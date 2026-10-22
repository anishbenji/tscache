// A server-rendered page without a framework, the server's half. The
// server reads with its own client and writes the answer into the page
// twice: as markup, and as data the browser starts its cache from
// (ssr-browser.ts). Without the browser's half, this is a page rendered on
// the server alone.

import { candles, describe, lastDays } from "../shared/candles";
import { dehydrate, jsonScript, SERVER_READ } from "../shared/hydration";
import { serverClient } from "../shared/server";

export interface ServerOptions {
  /** The fetcher module as a URL the server can import(). */
  fetcherModule: string;
  /** The backend's origin: a server has no page origin to resolve against. */
  origin: string;
}

/**
 * The page renderer for this server process; create it once at startup,
 * since it owns the process's client (docs/guides/worker-setup.md, "Server
 * rendering").
 */
export function pageRenderer({
  fetcherModule,
  origin,
}: ServerOptions): (now: number) => Promise<string> {
  const server = serverClient({
    fetcher: { module: fetcherModule, context: { origin } },
  });
  return async (now) => {
    const range = lastDays(90, now);
    const cache = await (await server()).cache(candles);
    const read = { range, result: await cache.get(range) };
    // describe() writes numbers only; HTML-escape anything that holds text.
    return `<p id="chart">${describe(read.result)}</p>${jsonScript(SERVER_READ, dehydrate(read))}`;
  };
}
