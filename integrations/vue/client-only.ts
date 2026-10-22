// A page with one chart, client-only. The plugin connects once for the app;
// the chart shows the last 90 days.

import { type ClientOptions, createClient } from "tscache";
import { type App, createApp } from "vue";
import { lastDays } from "../shared/candles";
import { Chart } from "./chart";
import { createTscache } from "./series";

/**
 * Mounts a page with one chart, showing the last 90 days, in `container`.
 * `options` carries the worker and fetcher URLs as your bundler serves them
 * (docs/guides/worker-setup.md). `app.unmount()` disposes the client; a
 * page that simply closes needs no teardown, since a client disposes itself
 * on `pagehide`.
 */
export function mountPage(
  options: ClientOptions,
  container: Element | string,
): App {
  const app = createApp(Chart, { range: lastDays(90, Date.now()) });
  app.use(createTscache(() => createClient(options)));
  app.mount(container);
  return app;
}
