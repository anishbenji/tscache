// The fetcher module the examples load into tscache's worker
// (docs/architecture.md §2.5). A cache id names the series as
// `<dataset>/<symbol>`, optionally followed by more segments that only keep
// ids apart (`candles/ACME/30m`). The backend answers in pages; a fetcher
// must return the whole requested range, so it loops over them. It asks for
// pages as columns bodies (src/columns.ts), which decode without parsing a
// number, and reads JSON from a backend that answers JSON anyway.

import {
  AuthInvalidError,
  type Fetcher,
  type FetchRequest,
  type FetchResponse,
} from "tscache/fetcher";
import {
  COLUMNS_TYPE,
  decodeColumns,
  isColumnsType,
  type NumericColumn,
} from "./columns";
import { type FetchNotice, postFetchNotice } from "./notices";

/** The fetcher context the examples pass to createClient and updateAuth. */
export interface ExampleContext {
  /** Access token; omit when the backend runs without auth. */
  token?: string;
  /**
   * The backend's origin. Omit in the browser, where the worker's own
   * origin serves the backend. A server has no such origin, so the SSR
   * examples pass the address they listen on.
   */
  origin?: string;
  /**
   * How to ask for pages: as columns bodies (the default) or as JSON, for
   * comparing the two.
   */
  format?: "columns" | "json";
}

/** A column of a page: numbers from JSON, a typed array from a columns body. */
type Column = number[] | NumericColumn;

interface Page {
  timestamps: number[] | Float64Array;
  fields: Record<string, Column>;
  meta: { version: string; finalizedUntil: number };
  next?: number;
}

function stringIn(context: unknown, key: keyof ExampleContext) {
  if (typeof context !== "object" || context === null) return undefined;
  const value: unknown = (context as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function seriesPath(cacheId: string): string {
  const [dataset, symbol] = cacheId.split("/");
  if (!dataset || !symbol) {
    throw new Error(`cache id "${cacheId}" is not <dataset>/<symbol>`);
  }
  return `/api/series/${encodeURIComponent(dataset)}/${encodeURIComponent(symbol)}`;
}

async function fetchPage(
  path: string,
  request: FetchRequest,
  start: number,
): Promise<Page> {
  const query = new URLSearchParams({
    start: String(start),
    end: String(request.range.end),
    interval: String(request.interval),
    offset: String(request.alignmentOffset),
  });
  const url = `${path}?${query}`;
  const origin = stringIn(request.context, "origin");
  const token = stringIn(request.context, "token");
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (stringIn(request.context, "format") !== "json") {
    headers.accept = `${COLUMNS_TYPE}, application/json;q=0.5`;
  }
  const response = await fetch(
    origin === undefined ? url : new URL(url, origin),
    { headers },
  );
  if (response.status === 401) {
    throw new AuthInvalidError("the backend refused the access token");
  }
  if (!response.ok) throw new Error(`the backend answered ${response.status}`);
  if (!isColumnsType(response.headers.get("content-type"))) {
    return (await response.json()) as Page;
  }
  // Views over the body: no value is parsed or copied.
  const { header, timestamps, fields } = decodeColumns(
    await response.arrayBuffer(),
  );
  return {
    timestamps,
    fields,
    meta: header.meta as Page["meta"],
    ...(header.next === undefined ? {} : { next: header.next as number }),
  };
}

/**
 * One column from a column of each page: the page's own when there is one
 * page, else a new one of the same kind.
 */
function join<T extends Column>(parts: readonly T[]): T {
  const [first] = parts;
  if (first === undefined) throw new Error("no pages to join");
  if (parts.length === 1) return first;
  if (parts.some((part) => part.constructor !== first.constructor)) {
    throw new Error("the pages' columns differ in type");
  }
  if (Array.isArray(first)) {
    const joined: number[] = [];
    // A loop, not push(...part): spreading a long page overflows the stack.
    for (const part of parts) for (const value of part) joined.push(value);
    return joined as T;
  }
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const Kind = first.constructor as new (length: number) => NumericColumn;
  const joined = new Kind(length);
  let at = 0;
  for (const part of parts as readonly NumericColumn[]) {
    joined.set(part, at);
    at += part.length;
  }
  return joined as T;
}

/**
 * Every page of the range, or undefined when the dataset version changed
 * between two of them: a range is never assembled from two versions.
 */
async function collect(
  path: string,
  request: FetchRequest,
  counted: () => void,
): Promise<FetchResponse | undefined> {
  let page = await fetchPage(path, request, request.range.start);
  const { version } = page.meta;
  const pages: Page[] = [];
  // The earliest watermark of all pages: a later page was answered later,
  // and its watermark would claim an earlier page's provisional points.
  let finalizedUntil = page.meta.finalizedUntil;
  for (;;) {
    counted();
    if (page.meta.version !== version) return undefined;
    pages.push(page);
    finalizedUntil = Math.min(finalizedUntil, page.meta.finalizedUntil);
    if (page.next === undefined) break;
    page = await fetchPage(path, request, page.next);
  }
  // No prototype, so a field named `constructor` or `__proto__` is a key
  // like any other rather than an inherited member.
  const fields: Record<string, Column> = Object.create(null);
  const names = Object.keys(pages[0]?.fields ?? {});
  for (const { fields: columns } of pages) {
    // Name by name: a string joined from the names could make two lists
    // alike, as ["a\0b"] and ["a", "b"] are once joined with NUL.
    const own = Object.keys(columns);
    if (own.length !== names.length || own.some((n, i) => n !== names[i])) {
      throw new Error("the pages' columns differ in name");
    }
  }
  for (const name of names) {
    fields[name] = join(pages.map((p) => p.fields[name] as Column));
  }
  return {
    timestamps: join(pages.map((p) => p.timestamps)),
    fields,
    meta: { version, finalizedUntil },
  };
}

async function fetchRange(
  request: FetchRequest,
  counted: () => void,
): Promise<FetchResponse> {
  const path = seriesPath(request.cacheId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await collect(path, request, counted);
    if (response !== undefined) return response;
  }
  throw new Error("the dataset version kept changing during the fetch");
}

const fetcher: Fetcher = {
  async fetch(request) {
    let pages = 0;
    const notice = (outcome: FetchNotice["outcome"]): FetchNotice => ({
      cacheId: request.cacheId,
      range: request.range,
      pages,
      outcome,
    });
    try {
      const response = await fetchRange(request, () => {
        pages++;
      });
      postFetchNotice(notice("ok"));
      return response;
    } catch (error) {
      const auth = error instanceof AuthInvalidError;
      postFetchNotice(notice(auth ? "auth-invalid" : "failed"));
      throw error;
    }
  },
};

export default fetcher;
