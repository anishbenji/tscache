// The fetcher of fetcher.ts, asking for columns bodies instead of JSON
// (examples/mock-backend/src/columns.ts holds the format's decoder). A range
// that fits one page is returned as views over the bytes fetched; a longer
// one is joined into one typed array per column, and refused if its pages'
// columns differ. `bun run docs:run`
// executes it against the examples' mock backend.
// #region fetcher
import {
  COLUMNS_TYPE,
  type DecodedColumns,
  decodeColumns,
  joinColumns,
} from "@examples/mock-backend/columns";
import {
  AuthInvalidError,
  type Fetcher,
  type FetchRequest,
  type FetchResponse,
} from "tscache/fetcher";
import type { Context } from "./fetcher";

/** What the backend puts in a columns header besides the columns. */
interface PageMembers {
  meta: { version: string; finalizedUntil: number };
  /** Where the next page starts; absent on the last one. */
  next?: number;
}

type Page = DecodedColumns & PageMembers;

async function fetchPage(request: FetchRequest, start: number): Promise<Page> {
  const { token, origin } = (request.context ?? {}) as Context;
  const query = new URLSearchParams({
    start: String(start),
    end: String(request.range.end),
    interval: String(request.interval),
    offset: String(request.alignmentOffset),
  });
  const path = `/api/series/${request.cacheId}?${query}`;
  const headers: Record<string, string> = { accept: COLUMNS_TYPE };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(
    origin === undefined ? path : new URL(path, origin),
    { headers },
  );
  if (response.status === 401) throw new AuthInvalidError("token refused");
  if (!response.ok) throw new Error(`backend answered ${response.status}`);
  // One ArrayBuffer, every column a view into it. A truncated or malformed
  // body throws ColumnsError, which makes the range 'fetch-failed'.
  const page = decodeColumns(await response.arrayBuffer());
  const { meta, next } = page.header as unknown as PageMembers;
  return next === undefined ? { ...page, meta } : { ...page, meta, next };
}

const fetcher: Fetcher = {
  async fetch(request): Promise<FetchResponse> {
    // Authoritative for the whole range: collect every page first.
    const pages: Page[] = [];
    let start: number | undefined = request.range.start;
    while (start !== undefined) {
      const page = await fetchPage(request, start);
      pages.push(page);
      start = page.next;
    }
    const first = pages[0] as Page;
    const { version } = first.meta;
    if (pages.some((page) => page.meta.version !== version)) {
      throw new Error("version changed mid-fetch");
    }
    // Throws ColumnsError if the pages' columns differ in name or dtype:
    // a u16 value joined into a u8 array would be wrapped, not rejected.
    const { timestamps, fields } = joinColumns(pages);
    return {
      timestamps,
      fields,
      meta: {
        version,
        // The earliest watermark, as in fetcher.ts.
        finalizedUntil: Math.min(...pages.map((p) => p.meta.finalizedUntil)),
      },
    };
  },
};

export default fetcher;
// #endregion fetcher
