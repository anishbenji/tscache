// A server-rendered page without a framework, the server's half. The
// server reads with its own client and writes the answer into the page
// twice: as markup, and as data the browser starts its cache from
// (ssr-browser.ts). Without the browser's half, this is a page rendered on
// the server alone.

import { candles, describe, lastDays } from "../shared/candles";
import { dehydrate, jsonScript, SERVER_READ } from "../shared/hydration";
import { type ServerOptions, serverReader } from "../shared/server";

/**
 * The page renderer for this server process; create it once at startup,
 * since it owns the process's client (docs/guides/worker-setup.md, "Server
 * rendering").
 */
export function pageRenderer(
  options: ServerOptions,
): (now: number) => Promise<string> {
  const reader = serverReader(options);
  return async (now) => {
    const read = await reader(candles, lastDays(90, now));
    // describe() writes numbers only; HTML-escape anything that holds text.
    return `<p id="chart">${describe(read.result)}</p>${jsonScript(SERVER_READ, dehydrate(read))}`;
  };
}
