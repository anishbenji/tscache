// The fetcher module the examples load into tscache's worker
// (docs/architecture.md §2.5). A cache id names the series as
// `<dataset>/<symbol>`, optionally followed by more segments that only keep
// ids apart (`candles/ACME/30m`). The backend answers in pages; a fetcher
// must return the whole requested range, so it loops over them.

import {
  AuthInvalidError,
  type Fetcher,
  type FetchRequest,
  type FetchResponse,
} from "tscache/fetcher";
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
}

interface Page {
  timestamps: number[];
  fields: Record<string, number[]>;
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
  const response = await fetch(
    origin === undefined ? url : new URL(url, origin),
    {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    },
  );
  if (response.status === 401) {
    throw new AuthInvalidError("the backend refused the access token");
  }
  if (!response.ok) throw new Error(`the backend answered ${response.status}`);
  return (await response.json()) as Page;
}

function append(target: number[], values: readonly number[]): void {
  for (const value of values) target.push(value);
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
  const timestamps: number[] = [];
  const fields: Record<string, number[]> = {};
  // The earliest watermark of all pages: a later page was answered later,
  // and its watermark would claim an earlier page's provisional points.
  let finalizedUntil = page.meta.finalizedUntil;
  for (;;) {
    counted();
    if (page.meta.version !== version) return undefined;
    append(timestamps, page.timestamps);
    for (const [name, values] of Object.entries(page.fields)) {
      fields[name] ??= [];
      append(fields[name], values);
    }
    finalizedUntil = Math.min(finalizedUntil, page.meta.finalizedUntil);
    if (page.next === undefined) {
      return { timestamps, fields, meta: { version, finalizedUntil } };
    }
    page = await fetchPage(path, request, page.next);
  }
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
