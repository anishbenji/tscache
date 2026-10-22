// A server-rendered page in Angular, the browser's half: the app's config
// for hydrating the server's page. The service reads the server's read from
// TransferState, seeds every client with it and gives it to the chart
// as its first value, so the hydration render matches the server's markup;
// the chart then switches to the live answer, which costs at most what the
// server's read did not cover (the provisional last day, say).

import type { ApplicationConfig } from "@angular/core";
import { type ClientOptions, createClient } from "tscache";
import { candles } from "../shared/candles";
import { provideTscache } from "./tscache";

/**
 * The config for hydrating a page the server rendered with `CandlesChart`
 * (candles-chart.ts); add provideClientHydration() to it (README.md).
 */
export function browserConfig(options: ClientOptions): ApplicationConfig {
  return {
    providers: [
      provideTscache(() => createClient(options), { hydrate: [candles] }),
    ],
  };
}
