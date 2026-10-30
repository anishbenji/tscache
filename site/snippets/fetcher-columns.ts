// The fetcher of fetcher.ts, asking for columns bodies rather than JSON
// (examples/mock-backend/src/columns.ts holds the format's decoder and the
// join), and reading a page the backend answers as JSON all the same. Each
// page is normalized as it arrives and the pages are joined by one rule
// table; a range that fits one columns page is returned as views over the
// bytes fetched. `bun run docs:run` executes it against the examples' mock
// backend.
// #region fetcher
import {
  COLUMNS_TYPE,
  decodeColumns,
  fromColumns,
  fromJson,
  isColumnsType,
  joinPages,
  type NormalPage,
} from "@examples/mock-backend/columns";
import {
  AuthInvalidError,
  type Fetcher,
  type FetchRequest,
  type FetchResponse,
} from "tscache/fetcher";
import type { Context } from "./fetcher";

/** What a page carries besides its columns, in either format. */
interface PageMembers {
  meta: { version: string; finalizedUntil: number };
  /** Where the next page starts; absent on the last one. */
  next?: number;
}

/** A page: its columns normalized, whatever its format, and its members. */
interface Page extends PageMembers {
  columns: NormalPage;
}

async function fetchPage(request: FetchRequest, start: number): Promise<Page> {
  const { token, origin } = (request.context ?? {}) as Context;
  const query = new URLSearchParams({
    start: String(start),
    end: String(request.range.end),
    interval: String(request.interval),
    offset: String(request.alignmentOffset),
  });
  const path = `/api/series/${request.cacheId}?${query}`;
  const headers: Record<string, string> = {
    accept: `${COLUMNS_TYPE}, application/json;q=0.5`,
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(
    origin === undefined ? path : new URL(path, origin),
    { headers },
  );
  if (response.status === 401) throw new AuthInvalidError("token refused");
  if (!response.ok) throw new Error(`backend answered ${response.status}`);
  let columns: NormalPage;
  let members: PageMembers;
  if (isColumnsType(response.headers.get("content-type"))) {
    // One ArrayBuffer, every column a view into it. A truncated or malformed
    // body throws ColumnsError, which makes the range 'fetch-failed'.
    const decoded = decodeColumns(await response.arrayBuffer());
    columns = fromColumns(decoded);
    members = decoded.header as unknown as PageMembers;
  } else {
    // JSON, from a backend that does not serve columns (or not yet).
    members = (await response.json()) as PageMembers;
    columns = fromJson(members);
  }
  const { meta, next } = members;
  return next === undefined ? { columns, meta } : { columns, meta, next };
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
    const { version } = (pages[0] as Page).meta;
    if (pages.some((page) => page.meta.version !== version)) {
      throw new Error("version changed mid-fetch");
    }
    // By the rule table in columns.ts: one dtype stays that dtype; mixed
    // formats or dtypes widen to Float64Array, never narrow; pages whose
    // field names differ throw ColumnsError.
    const { timestamps, fields } = joinPages(pages.map((p) => p.columns));
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
