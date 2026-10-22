// A server-rendered React page, the server's half. The server reads before
// it renders and hands the read to the page through TscacheProvider, so
// nothing suspends and renderToString writes the finished markup in one
// pass; streaming would have nothing to stream. The read goes into the page
// a second time as data, for the browser's half (ssr-browser.tsx). Without
// that half, this is a page rendered on the server alone.

import { renderToString } from "react-dom/server";
import { candles, lastDays } from "../shared/candles";
import { dehydrate, jsonScript, SERVER_READ } from "../shared/hydration";
import { type ServerOptions, serverReader } from "../shared/server";
import { Page, ROOT } from "./page";
import { TscacheProvider } from "./series";

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
    const html = renderToString(
      <TscacheProvider connection={null} seeds={[{ config: candles, read }]}>
        <Page range={read.range} />
      </TscacheProvider>,
    );
    return `<div id="${ROOT}">${html}</div>${jsonScript(SERVER_READ, dehydrate(read))}`;
  };
}
