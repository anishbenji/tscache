// The tscache client and the sensor's cache as async memos. When the worker
// is lost (docs/guides/worker-setup.md), refreshing the client memo creates
// a new client; the cache memo and the chart data derive from it, so they
// follow with the new client's worker and its empty cache.

import {
  type CacheConfig,
  type CacheHandle,
  createClient,
  type TscacheClient,
} from "@anishbenji/tscache";
import workerUrl from "@anishbenji/tscache/worker?worker&url";
import { datasets } from "@examples/mock-backend/datasets";
import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import { pageContext } from "@examples/mock-backend/insights";
import {
  type Accessor,
  createMemo,
  refresh,
  type SourceAccessor,
} from "solid-js";
import { log } from "./log";

export const INTERVAL = 10_000;

const config: CacheConfig = {
  id: "sensor/greenhouse",
  interval: INTERVAL,
  fields: datasets.sensor.fields,
};

interface Session {
  client: Accessor<TscacheClient>;
  cache: Accessor<CacheHandle>;
}

/** Creates the memos under the calling component, which owns them. */
export function createSession(): Session {
  const client: SourceAccessor<TscacheClient> = createMemo(async () => {
    const next = await createClient({
      workerUrl,
      fetcher: { module: fetcherModule, context: pageContext({}) },
    });
    next.on("workerLost", ({ reason }) => {
      log(`worker lost (${reason}); connecting a new client`);
      void refresh(client);
    });
    return next;
  });
  const cache = createMemo<CacheHandle>(() => client().cache(config));
  return { client, cache };
}
