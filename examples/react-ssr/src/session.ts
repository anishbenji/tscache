// The browser's side of tscache: a client whose cache starts from what the
// server read, replaced when its worker is lost; the cache's answers for the
// shown window; and the fetches the backend received.

import {
  type CacheHandle,
  createClient,
  type GetResult,
  type Range,
  type TscacheClient,
} from "@anishbenji/tscache";
import workerUrl from "@anishbenji/tscache/worker?worker&url";
import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import { type Hydration, seedCache } from "@examples/mock-backend/hydration";
import { pageContext } from "@examples/mock-backend/insights";
import { onFetchNotice } from "@examples/mock-backend/notices";
import { useEffect, useState } from "react";
import { candles, type Summary, summarize, utcDay } from "./candles";
import { type Attempt, attempts, untilPageGone } from "./connecting";
import { insights } from "./insights";
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
 * did. A snapshot that fails to apply leaves the cache to fetch instead
 * (`seedCache`); only a cache that cannot be opened fails the connection.
 * The attempt's `lose` is subscribed at once: the worker can be lost while
 * the cache is still being opened and seeded.
 */
async function connect(
  hydration: Hydration,
  attempt: Attempt,
): Promise<Connection & { applied: Range[] | undefined }> {
  const client = await createClient({
    workerUrl,
    fetcher: { module: fetcherModule, context: pageContext({}) },
  });
  client.on("workerLost", ({ reason }) => attempt.lose(reason));
  try {
    const cache = await client.cache(candles);
    const applied = await seedCache(cache, hydration, attempt.live);
    return { client, cache: insights.instrument(cache, client), applied };
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
    let current: TscacheClient | undefined;
    const stop = attempts((attempt) => connect(hydration, attempt), {
      connected(next) {
        current = next.client;
        log(`client connected (${next.client.mode})`);
        if (next.applied === undefined) {
          log(
            "snapshot from the server: not applied; the cache fetches what it would have covered",
          );
        } else {
          const applied = next.applied.map(span);
          log(
            `snapshot from the server: ${applied.length > 0 ? applied.join(", ") : "nothing"} applied where the cache had no coverage`,
          );
        }
        setConnection({ client: next.client, cache: next.cache });
      },
      lost(reason) {
        log(`worker lost (${reason}); connecting a new client`);
        setConnection(undefined);
      },
      failed: (error) => log(`could not connect: ${message(error)}`),
      drop: (next) => void next.client.dispose(),
    });
    // A page hidden for good disposes the client, which is no connection.
    const unlisten = untilPageGone(window, stop);
    return () => {
      unlisten();
      stop();
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
