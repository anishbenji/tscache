// A server-rendered Svelte 5 page, the server's half. The server reads with
// its own client, renders the app with svelte/server from that read, and
// writes the read into the page as data the browser starts its cache from
// (ssr-browser.ts). Without the browser's half, this is a page rendered on
// the server alone.

import type { Component } from "svelte";
import { render } from "svelte/server";
import { candles, lastDays } from "../shared/candles";
import {
  dehydrate,
  jsonScript,
  SERVER_READ,
  type ServerRead,
} from "../shared/hydration";
import { type ServerOptions, serverReader } from "../shared/server";

/** The rendered page's parts, for the `<head>` and the `<body>`. */
export interface Page {
  head: string;
  body: string;
}

/**
 * The page renderer for this server process; create it once at startup,
 * since it owns the process's client (docs/guides/worker-setup.md, "Server
 * rendering"). The app renders into `#app`, which ssr-browser.ts hydrates.
 */
export function pageRenderer(
  App: Component<{ read: ServerRead }>,
  options: ServerOptions,
): (now: number) => Promise<Page> {
  const reader = serverReader(options);
  return async (now) => {
    const read = await reader(candles, lastDays(90, now));
    const { head, body } = render(App, { props: { read } });
    return {
      head,
      body: `<div id="app">${body}</div>${jsonScript(SERVER_READ, dehydrate(read))}`,
    };
  };
}
