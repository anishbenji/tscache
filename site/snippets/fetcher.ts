// A fetcher module: the worker import()s it and calls its default export.
// It closes over nothing on the page; what it needs arrives in `context`.
// It speaks the protocol of the examples' mock backend
// (examples/mock-backend), against which `bun run docs:run` executes it.
// #region fetcher
import {
  AuthInvalidError,
  type Fetcher,
  type FetchRequest,
  type FetchResponse,
} from "tscache/fetcher";

/** What this app passes as `context` to createClient and updateAuth. */
export interface Context {
  token?: string;
  /**
   * The backend's origin. The browser omits it: its requests resolve
   * against the page's origin. A server has none, so it passes one.
   */
  origin?: string;
}

/** One page of the backend's answer. */
interface Page {
  timestamps: number[];
  fields: Record<string, number[]>;
  meta: {
    version: string;
    /** The first timestamp that is not final yet. */
    finalizedUntil: number;
  };
  /** Where the next page starts; absent on the last one. */
  next?: number;
}

async function fetchPage(request: FetchRequest, start: number): Promise<Page> {
  const { token, origin } = (request.context ?? {}) as Context;
  // The cache id names the series: `<dataset>/<symbol>`.
  const query = new URLSearchParams({
    start: String(start),
    end: String(request.range.end),
    interval: String(request.interval),
    offset: String(request.alignmentOffset),
  });
  const path = `/api/series/${request.cacheId}?${query}`;
  const response = await fetch(
    origin === undefined ? path : new URL(path, origin),
    {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    },
  );
  // The one error the worker treats specially: every tab hears authInvalid.
  if (response.status === 401) throw new AuthInvalidError("token refused");
  // Anything else thrown makes the range 'fetch-failed' for this get.
  if (!response.ok) throw new Error(`backend answered ${response.status}`);
  return (await response.json()) as Page;
}

const fetcher: Fetcher = {
  async fetch(request): Promise<FetchResponse> {
    // The answer is authoritative for the whole range: collect every page.
    const timestamps: number[] = [];
    // No prototype: a field may be named like an Object.prototype member
    // (`constructor`), which `??=` would otherwise find already set.
    const fields: Record<string, number[]> = Object.create(null);
    let page = await fetchPage(request, request.range.start);
    const { version } = page.meta;
    let finalizedUntil = page.meta.finalizedUntil;
    for (;;) {
      if (page.meta.version !== version) {
        throw new Error("version changed mid-fetch");
      }
      // A loop, not push(...values): spreading a long page overflows the stack.
      for (const t of page.timestamps) timestamps.push(t);
      for (const [name, values] of Object.entries(page.fields)) {
        fields[name] ??= [];
        for (const value of values) fields[name].push(value);
      }
      // The earliest watermark: a later page must not vouch for an
      // earlier page's provisional points.
      finalizedUntil = Math.min(finalizedUntil, page.meta.finalizedUntil);
      if (page.next === undefined) break;
      page = await fetchPage(request, page.next);
    }
    return { timestamps, fields, meta: { version, finalizedUntil } };
  },
};

export default fetcher;
// #endregion fetcher
