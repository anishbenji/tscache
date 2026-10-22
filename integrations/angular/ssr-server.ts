// A server-rendered page in Angular, the server's half: the providers that
// make `cacheResource()` read with this process's client and hand the read
// to the browser in TransferState, which Angular writes into the page
// (escaped) as it renders. The browser's half is ssr-browser.ts; without
// it, this is a page rendered on the server alone. Only the server imports
// this file, so none of it reaches the browser bundle.

import {
  type EnvironmentProviders,
  inject,
  makeEnvironmentProviders,
  TransferState,
} from "@angular/core";
import type { CacheConfig, Range } from "tscache";
import { dehydrate } from "../shared/hydration";
import { type ServerOptions, serverReader } from "../shared/server";
import { SERVER_READER, serverReadKey } from "./tscache";

/**
 * The server's tscache providers. Call it once per process, where the
 * server's config is built (app.config.server.ts), since it creates the
 * client every render shares (docs/guides/worker-setup.md, "Server
 * rendering"). A page shows one server read per cache: the browser seeds
 * from the last one written.
 */
export function provideTscacheServer(
  options: ServerOptions,
): EnvironmentProviders {
  const reader = serverReader(options);
  return makeEnvironmentProviders([
    {
      provide: SERVER_READER,
      useFactory: () => {
        const transfer = inject(TransferState);
        return async (config: CacheConfig, range: Range) => {
          const read = await reader(config, range);
          transfer.set(serverReadKey(config), dehydrate(read));
          return read.result;
        };
      },
    },
  ]);
}
