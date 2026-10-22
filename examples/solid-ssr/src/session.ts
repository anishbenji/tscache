// The browser's tscache client and the sensor's cache, as async memos. The
// cache memo applies the server's snapshot to each client's cache before it
// hands the cache out, so no get can run ahead of it. When the worker is
// lost (docs/guides/worker-setup.md), refreshing the client memo connects a
// new client, whose new worker starts empty: the snapshot seeds it too,
// since hydrate refuses a snapshot of another dataset version and never
// touches what a cache already covers.

import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import { readHydration, seed } from "@examples/mock-backend/hydration";
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
  const hydration = readHydration();
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
    const { applied } = await seed(handle, hydration);
    log(`snapshot from the server: ${applied.length} range(s) applied`);
    return handle;
  });
  return { client, cache };
}
