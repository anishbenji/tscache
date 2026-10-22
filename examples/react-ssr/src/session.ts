// The browser's side of tscache: a client whose cache starts from what the
// server read, replaced when its worker is lost; the cache's answers for the
// shown window; and the fetches the backend received.

import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import { type Hydration, seed } from "@examples/mock-backend/hydration";
import { onFetchNotice } from "@examples/mock-backend/notices";
import { useEffect, useState } from "react";
import {
  type CacheHandle,
  createClient,
  type GetResult,
  type Range,
  type TscacheClient,
} from "tscache";
import workerUrl from "tscache/worker?worker&url";
import { candles, type Summary, summarize, utcDay } from "./candles";
import { log, message } from "./log";

/** A connected client and its candles cache. */
export interface Connection {
  client: TscacheClient;
  cache: CacheHandle;
}

/** A cache answer for the window from `start` to now. */
export interface Frame {
  /** The cache that answered. */
  cache: CacheHandle;
  start: number;
  result: GetResult;
  summary: Summary;
}

const span = ({ start, end }: Range) => `${utcDay(start)} – ${utcDay(end)}`;

/**
 * Connects a client, opens the cache and applies the server's snapshot to
 * it, so the cache covers what the server read; hydrate skips what the cache
 * already covers, which another tab may have fetched later than the server
 * did. `onLost` is subscribed at once: the worker can be lost while the
 * cache is still being opened and seeded.
 */
async function connect(
  hydration: Hydration,
  onLost: (reason: string) => void,
): Promise<Connection & { applied: Range[] }> {
  const client = await createClient({
    workerUrl,
    fetcher: { module: fetcherModule },
  });
  client.on("workerLost", ({ reason }) => onLost(reason));
  try {
    const cache = await client.cache(candles);
    const { applied } = await seed(cache, hydration);
    return { client, cache, applied };
  } catch (error) {
    void client.dispose();
    throw error;
  }
}

/**
 * The connected client and its cache; undefined while connecting. When the
 * worker behind it is lost, as when the tab hosting the SharedWorker
 * crashes, a new client replaces it (docs/guides/worker-setup.md). Its new
 * worker starts empty, and the server's snapshot seeds it too: hydrate
 * refuses a snapshot of another dataset version and never touches what a
 * cache already covers.
 */
export function useConnection(hydration: Hydration): Connection | undefined {
  const [connection, setConnection] = useState<Connection>();
  useEffect(() => {
    let mounted = true;
    let current: TscacheClient | undefined;
    const connectNext = () => {
      const onLost = (reason: string) => {
        if (!mounted) return;
        log(`worker lost (${reason}); connecting a new client`);
        setConnection(undefined);
        connectNext();
      };
      connect(hydration, onLost).then(
        (next) => {
          if (!mounted) return void next.client.dispose();
          current = next.client;
          log(`client connected (${next.client.mode})`);
          const applied = next.applied.map(span);
          log(
            `snapshot from the server: ${applied.length > 0 ? applied.join(", ") : "nothing"} applied where the cache had no coverage`,
          );
          setConnection({ client: next.client, cache: next.cache });
        },
        (error) => log(`could not connect: ${message(error)}`),
      );
    };
    connectNext();
    return () => {
      mounted = false;
      void current?.dispose();
    };
  }, [hydration]);
  return connection;
}

function logMisses({ misses }: GetResult): void {
  for (const miss of misses) {
    if (miss.reason !== "uncached") log(`miss: ${miss.reason}`);
  }
}

/**
 * The connection's answer for the window from `start` to now, asked again
 * whenever either changes. Only the latest request draws: an answer that
 * arrives after a newer request was made is dropped, so a slow fetch never
 * draws over a later answer.
 */
export function useCandles(
  connection: Connection | undefined,
  start: number,
): Frame | undefined {
  const [frame, setFrame] = useState<Frame>();
  useEffect(() => {
    if (connection === undefined) return;
    const { cache } = connection;
    let latest = true;
    cache.get({ start, end: Date.now() }).then(
      (result) => {
        if (!latest) return;
        logMisses(result);
        setFrame({ cache, start, result, summary: summarize(result) });
      },
      (error) => {
        if (latest) log(`get failed: ${message(error)}`);
      },
    );
    return () => {
      latest = false;
    };
  }, [connection, start]);
  return frame;
}

/** Fetches any tab's worker made since this page opened. */
export function useFetchCount(): number {
  const [count, setCount] = useState(0);
  useEffect(
    () =>
      onFetchNotice((notice) => {
        setCount((n) => n + 1);
        const { cacheId, range, pages, outcome } = notice;
        log(`fetched ${cacheId} ${span(range)}: ${outcome}, ${pages} page(s)`);
      }),
    [],
  );
  return count;
}
