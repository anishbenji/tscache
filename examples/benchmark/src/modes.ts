// The four ways a tab can read the workload's ranges. Every mode fetches
// through the same code, the mock backend's fetcher, which asks for columns
// bodies, pages through long ranges, decodes the same way and reports each
// fetch on the insights channel (insights.ts); only what sits between the
// chart and the fetcher differs:
//
// - none: every view fetches its range.
// - memo: a Map per tab, keyed by the exact range, holding each fetch's
//   promise, so a range asked again in the same tab is not fetched again.
// - tanstack: TanStack Query's core keyed by exact range, in memory, per
//   tab: one QueryClient per tab, the key [series, start, end], and
//   staleTime Infinity, so a cached range is never refetched.
// - tscache: a tscache client, whose worker loads the same fetcher; the
//   tabs share one cache through the SharedWorker, and a view fetches only
//   what the cache does not hold. Each run starts a new SharedWorker: a
//   SharedWorker is one per script URL, and the run's id is in its URL, so
//   no run inherits a warm worker (one lives on about 30 s after its last
//   tab) with its fetcher already loaded.

import { createClient, type Range } from "@anishbenji/tscache";
import workerUrl from "@anishbenji/tscache/worker?worker&url";
import fetcher from "@examples/mock-backend/fetcher";
import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import { QueryClient } from "@tanstack/query-core";
import { type Bars, barsOf } from "./answer";
import {
  cacheConfig,
  INTERVAL,
  type Mode,
  SERIES,
  sourceCacheId,
} from "./workload";

export interface Source {
  read(range: Range): Promise<Bars>;
  dispose(): Promise<void>;
}

/**
 * The backend's answer for `range`, as every mode but tscache fetches it:
 * through the fetcher tscache's worker loads, its reports under `cacheId`.
 */
async function fetchBars(cacheId: string, range: Range): Promise<Bars> {
  const response = await fetcher.fetch({
    cacheId,
    range,
    interval: INTERVAL,
    alignmentOffset: 0,
    context: {},
  });
  return {
    timestamps: response.timestamps,
    close: (response.fields.close ?? []) as ArrayLike<number>,
  };
}

function noCache(cacheId: string): Source {
  return {
    read: (range) => fetchBars(cacheId, range),
    dispose: async () => {},
  };
}

function memo(cacheId: string): Source {
  const memos = new Map<string, Promise<Bars>>();
  return {
    read(range) {
      const key = `${range.start}:${range.end}`;
      let bars = memos.get(key);
      if (bars === undefined) {
        bars = fetchBars(cacheId, range);
        memos.set(key, bars);
      }
      return bars;
    },
    dispose: async () => memos.clear(),
  };
}

function tanstack(cacheId: string): Source {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
  });
  client.mount();
  return {
    read: (range) =>
      client.fetchQuery({
        queryKey: [SERIES, range.start, range.end],
        queryFn: () => fetchBars(cacheId, range),
      }),
    dispose: async () => {
      client.clear();
      client.unmount();
    },
  };
}

/** The worker script's URL for run `run`: a SharedWorker of its own. */
function runWorkerUrl(run: string): string {
  const url = new URL(workerUrl, location.href);
  url.searchParams.set("run", run);
  return url.href;
}

/** A tscache client of the run's own worker and cache, `run` naming both. */
async function tscache(run: string): Promise<Source> {
  const client = await createClient({
    workerUrl: runWorkerUrl(run),
    fetcher: { module: fetcherModule },
  });
  const cache = await client.cache(cacheConfig(run));
  return {
    async read(range) {
      return barsOf(await cache.get(range), range);
    },
    dispose: () => client.dispose(),
  };
}

/**
 * Opens tab `tab`'s source for `mode`; tscache's connects its client first.
 * Each fetch is reported under the cache id `sourceCacheId` names.
 */
export async function openSource(
  mode: Mode,
  run: string,
  tab: string,
): Promise<Source> {
  const cacheId = sourceCacheId(mode, run, tab);
  switch (mode) {
    case "none":
      return noCache(cacheId);
    case "memo":
      return memo(cacheId);
    case "tanstack":
      return tanstack(cacheId);
    case "tscache":
      return tscache(run);
  }
}
