// The browser's tscache client and the sensor's cache, as async memos. The
// cache memo puts the server's seeds into the first client's cache before it
// hands the cache out, so no get can run ahead of them. When the worker is
// lost (docs/guides/worker-setup.md), refreshing the client memo connects a
// new client, whose new worker starts empty and fetches what it is asked
// for. It gets no seeds: they are as old as the page, which may have seen a
// newer dataset version since, and an unversioned seed in an empty cache
// would pass for that version.

import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import {
  type Hydration,
  putSeeds,
  readHydration,
} from "@examples/mock-backend/hydration";
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
  let seeds: Hydration | undefined = readHydration();
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
    const first = seeds;
    seeds = undefined;
    if (first !== undefined) await putSeeds(handle, config, first);
    return handle;
  });
  return { client, cache };
}
