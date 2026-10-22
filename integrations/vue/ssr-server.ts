// A server-rendered page in Vue, the server's half. The server reads with
// its own client, renders the chart from the read, and writes the read
// into the page for the browser's half (ssr-browser.ts) to hydrate from and
// start its cache with. Without the browser's half, this is a page rendered
// on the server alone.
//
// The read happens before the render rather than in onServerPrefetch. The
// page's range comes from the request's `now`, and the same read becomes
// the root props on both sides, so the hydration render matches by
// construction and the composable carries no server code.

import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { candles, lastDays } from "../shared/candles";
import { dehydrate, jsonScript, SERVER_READ } from "../shared/hydration";
import { type ServerOptions, serverReader } from "../shared/server";
import { Chart } from "./chart";

/**
 * The page renderer for this server process; create it once at startup,
 * since it owns the process's client (docs/guides/worker-setup.md, "Server
 * rendering"). Each call renders a fresh app, as Vue requires per request.
 */
export function pageRenderer(
  options: ServerOptions,
): (now: number) => Promise<string> {
  const reader = serverReader(options);
  return async (now) => {
    const read = await reader(candles, lastDays(90, now));
    const html = await renderToString(
      createSSRApp(Chart, { range: read.range, initial: read }),
    );
    return `<div id="app">${html}</div>${jsonScript(SERVER_READ, dehydrate(read))}`;
  };
}
