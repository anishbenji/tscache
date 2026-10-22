// A server-rendered page in Solid, the server's half. The server reads with
// its own client, renders the page from that read, and writes the read into
// the page as data the browser starts its cache from (ssr-browser.tsx).
// Without the browser's half, this is a page rendered on the server alone.

import { generateHydrationScript, renderToString } from "@solidjs/web";
import { candles, lastDays } from "../shared/candles";
import { dehydrate, jsonScript, SERVER_READ } from "../shared/hydration";
import { type ServerOptions, serverReader } from "../shared/server";
import { Page } from "./page";

/**
 * The page renderer for this server process; create it once at startup,
 * since it owns the process's client (docs/guides/worker-setup.md, "Server
 * rendering"). It renders the page's body: Solid's hydration script, the
 * app in `#app`, and the read.
 */
export function pageRenderer(
  options: ServerOptions,
): (now: number) => Promise<string> {
  const reader = serverReader(options);
  const hydration = generateHydrationScript();
  return async (now) => {
    const read = await reader(candles, lastDays(90, now));
    // renderToString is synchronous, so the read comes first.
    const app = renderToString(() => <Page read={read} />);
    return `${hydration}<div id="app">${app}</div>${jsonScript(SERVER_READ, dehydrate(read))}`;
  };
}
