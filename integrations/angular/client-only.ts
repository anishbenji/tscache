// A page with one chart, client-only: the app's config. Bootstrap the chart
// with it (README.md); the app connects once, and disposes the connection
// when it is destroyed.

import type { ApplicationConfig } from "@angular/core";
import { type ClientOptions, createClient } from "tscache";
import { provideTscache } from "./tscache";

/**
 * The config for a page showing `CandlesChart` (candles-chart.ts). `options`
 * carries the worker and fetcher URLs as your bundler serves them
 * (docs/guides/worker-setup.md).
 */
export function clientConfig(options: ClientOptions): ApplicationConfig {
  return { providers: [provideTscache(() => createClient(options))] };
}
