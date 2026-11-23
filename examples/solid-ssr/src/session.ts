// The browser's tscache client and the sensor's cache, as async memos. The
// cache memo applies the server's snapshot to each client's cache before it
// hands the cache out, so no get can run ahead of it. A snapshot that fails
// to apply leaves the cache not seeded: the memo still hands it out, and it
// fetches what the snapshot would have covered (architecture §2.8). When the
// worker is lost (docs/guides/worker-setup.md), refreshing the client memo
// connects a new client, whose new worker starts empty: the snapshot seeds
// it too, since hydrate refuses a snapshot of another dataset version and
// never touches what a cache already covers.

import {
  type CacheHandle,
  createClient,
  type TscacheClient,
} from "@anishbenji/tscache";
import workerUrl from "@anishbenji/tscache/worker?worker&url";
import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import { readHydration, seed } from "@examples/mock-backend/hydration";
import { pageContext } from "@examples/mock-backend/insights";
import { createMemo, refresh, type SourceAccessor } from "solid-js";
import { config } from "./sensor";

export interface Session {
  client: SourceAccessor<TscacheClient>;
  cache: SourceAccessor<CacheHandle>;
}

/** Creates the memos under the calling component, which owns them. */
export function createSession(log: (text: string) => void): Session {
  const hydration = readHydration();
  // The clients whose worker was lost: a lost client fails every pending
  // call, `hydrate` included, which is no news about the snapshot.
  const lost = new WeakSet<TscacheClient>();
  const client: SourceAccessor<TscacheClient> = createMemo(async () => {
    const next = await createClient({
      workerUrl,
      fetcher: { module: fetcherModule, context: pageContext({}) },
    });
    next.on("workerLost", ({ reason }) => {
      lost.add(next);
      log(`worker lost (${reason}); connecting a new client`);
      void refresh(client);
    });
    return next;
  });
  const cache = createMemo(async () => {
    const current = client();
    // Only a cache that cannot be opened fails the memo.
    const handle = await current.cache(config);
    try {
      const { applied } = await seed(handle, hydration);
      log(`snapshot from the server: ${applied.length} range(s) applied`);
    } catch (error) {
      // A lost client's memo is about to be recomputed with its
      // replacement, which seeds afresh.
      if (lost.has(current)) return handle;
      // Hydration saves fetches; it is never needed for correct answers.
      // Only the error's message is printed: the snapshot carries the
      // page's data.
      if (import.meta.env.DEV) {
        const why = error instanceof Error ? error.message : String(error);
        console.warn(
          `tscache: the server's snapshot for cache "${handle.id}" was not applied (${why}), so the cache fetches that range instead; printed in development builds only.`,
        );
      }
      log(
        "snapshot from the server: not applied; the cache fetches what it would have covered",
      );
    }
    return handle;
  });
  return { client, cache };
}
