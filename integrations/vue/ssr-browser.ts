// A server-rendered page in Vue, the browser's half. The hydration render
// shows the server's read, so it matches the server's markup. The first
// client starts its cache from that read, and the chart's own answer then
// replaces it, fetching only what the server's answer did not cover (the
// provisional last day, say).

import { type ClientOptions, createClient } from "tscache";
import { type App, createSSRApp } from "vue";
import { candles } from "../shared/candles";
import {
  type Dehydrated,
  readJson,
  rehydrate,
  SERVER_READ,
} from "../shared/hydration";
import { Chart } from "./chart";
import { createTscache } from "./series";

/** Hydrates the server's page in `#app`. `app.unmount()` disposes the client. */
export function hydratePage(options: ClientOptions): App {
  const read = rehydrate(candles, readJson<Dehydrated>(SERVER_READ));
  const app = createSSRApp(Chart, { range: read.range, initial: read });
  app.use(
    createTscache(() => createClient(options), [{ config: candles, read }]),
  );
  app.mount("#app");
  return app;
}
