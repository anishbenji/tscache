// The browser's tscache client and the sensor's cache, as async memos. The
// cache memo puts the server's seeds into the cache before it hands the
// cache out, so no get can run ahead of them. When the worker is lost
// (docs/guides/worker-setup.md), refreshing the client memo connects a new
// client; the cache memo follows and seeds the new worker's empty cache
// again, which saves fetching the server's day a second time.

import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import { putSeeds, readHydration } from "@examples/mock-backend/hydration";
import { createMemo, refresh, type SourceAccessor } from "solid-js";
import { type CacheHandle, createClient, type TscacheClient } from "tscache";
import workerUrl from "tscache/worker?worker&url";
import { config } from "./sensor";

export interface Session {
  client: SourceAccessor<TscacheClient>;
  cache: SourceAccessor<CacheHandle>;
}

/** Creates the memos under the calling component, which owns them. */
export function createSession(log: (text: string) => void): Session {
  const seeds = readHydration();
  const client: SourceAccessor<TscacheClient> = createMemo(async () => {
    const next = await createClient({
      workerUrl,
      fetcher: { module: fetcherModule },
    });
    next.on("workerLost", ({ reason }) => {
      log(`worker lost (${reason}); connecting a new client`);
      void refresh(client);
    });
    return next;
  });
  const cache = createMemo(async () => {
    const handle = await client().cache(config);
    await putSeeds(handle, config, seeds);
    return handle;
  });
  return { client, cache };
}
