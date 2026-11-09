// The four ways a tab can read the workload's ranges. Every mode fetches
// through the same code, the mock backend's fetcher (fetchSeries), which
// asks for columns bodies, pages through long ranges and decodes the same
// way; only what sits between the chart and the fetcher differs:
//
// - none: every view fetches its range.
// - memo: a Map per tab, keyed by the exact range, holding each fetch's
//   promise, so a range asked again is not fetched again.
// - tanstack: TanStack Query's core, configured fairly for immutable
//   history: one QueryClient per tab, the key [series, start, end], and
//   staleTime Infinity, so a cached range is never refetched.
// - tscache: a tscache client, whose worker loads the same fetcher; the
//   tabs share one cache through the SharedWorker, and a view fetches only
//   what the cache does not hold.

import { createClient, type Range } from "@anishbenji/tscache";
import workerUrl from "@anishbenji/tscache/worker?worker&url";
import { fetchSeries } from "@examples/mock-backend/fetcher";
import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import { QueryClient } from "@tanstack/query-core";
import { cacheConfig, INTERVAL, type Mode, SERIES } from "./workload";

/** What the chart draws: times and closes. */
interface Bars {
  timestamps: ArrayLike<number>;
  close: ArrayLike<number>;
}

export interface Source {
  read(range: Range): Promise<Bars>;
  dispose(): Promise<void>;
}

/** The backend's answer for `range`, as every mode but tscache fetches it. */
async function fetchBars(range: Range): Promise<Bars> {
  const response = await fetchSeries(
    {
      cacheId: SERIES,
      range,
      interval: INTERVAL,
      alignmentOffset: 0,
      context: {},
    },
    { page() {} },
  );
  return {
    timestamps: response.timestamps,
    close: (response.fields.close ?? []) as ArrayLike<number>,
  };
}

function noCache(): Source {
  return { read: fetchBars, dispose: async () => {} };
}

function memo(): Source {
  const memos = new Map<string, Promise<Bars>>();
  return {
    read(range) {
      const key = `${range.start}:${range.end}`;
      let bars = memos.get(key);
      if (bars === undefined) {
        bars = fetchBars(range);
        memos.set(key, bars);
      }
      return bars;
    },
    dispose: async () => memos.clear(),
  };
}

function tanstack(): Source {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
  });
  client.mount();
  return {
    read: (range) =>
      client.fetchQuery({
        queryKey: [SERIES, range.start, range.end],
        queryFn: () => fetchBars(range),
      }),
    dispose: async () => {
      client.clear();
      client.unmount();
    },
  };
}

/** A tscache client of the run's own cache, `run` naming it. */
async function tscache(run: string): Promise<Source> {
  const client = await createClient({
    workerUrl,
    fetcher: { module: fetcherModule },
  });
  const cache = await client.cache(cacheConfig(run));
  return {
    async read(range) {
      const result = await cache.get(range);
      return {
        timestamps: result.timestamps,
        close: result.fields.close ?? [],
      };
    },
    dispose: () => client.dispose(),
  };
}

/** Opens a tab's source for `mode`; tscache's connects its client first. */
export async function openSource(mode: Mode, run: string): Promise<Source> {
  switch (mode) {
    case "none":
      return noCache();
    case "memo":
      return memo();
    case "tanstack":
      return tanstack();
    case "tscache":
      return tscache(run);
  }
}
