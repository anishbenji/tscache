// Five-minute ACME candles for the last three days, refreshed every five
// seconds. Bars before the backend's watermark are final: the cache covers
// them after one fetch, so a refresh fetches only the bar forming now. Every
// tab of the origin shares that one cache through the SharedWorker.

import { datasets } from "@examples/mock-backend/datasets";
import { useEffect, useState } from "react";
import type {
  CacheConfig,
  CacheHandle,
  GetResult,
  TscacheClient,
} from "tscache";
import { log, message } from "./log";

const DAY = 24 * 3_600_000;
const WINDOW = 3 * DAY;
const REFRESH_MS = 5000;

const CANDLES: CacheConfig = {
  id: "candles/ACME/5m",
  interval: 5 * 60_000,
  fields: datasets.candles.fields,
};

/** One answer of the cache, and the client whose cache gave it. */
export interface Frame {
  client: TscacheClient;
  result: GetResult;
  /** When the get was issued. */
  at: number;
}

function logMisses(result: GetResult): void {
  for (const miss of result.misses) {
    if (miss.reason === "uncached") continue;
    const detail = miss.error ? ` (${miss.error.message})` : "";
    log(`miss: ${miss.reason}${detail}`);
  }
}

/**
 * Opens the candles cache on `client` and asks it for the shown range every
 * REFRESH_MS; a new client opens the cache again. `answered` must be a
 * stable callback: a new one restarts the polling.
 */
export function useCandles(
  client: TscacheClient | undefined,
  answered: (result: GetResult) => void,
): Frame | undefined {
  const [frame, setFrame] = useState<Frame>();
  useEffect(() => {
    if (client === undefined) return;
    let mounted = true;
    let busy = false;
    let cache: CacheHandle | undefined;
    const poll = async () => {
      if (busy || cache === undefined) return;
      busy = true;
      try {
        const at = Date.now();
        const result = await cache.get({ start: at - WINDOW, end: at });
        if (!mounted) return;
        logMisses(result);
        answered(result);
        setFrame({ client, result, at });
      } catch (error) {
        if (mounted) log(`get failed: ${message(error)}`);
      } finally {
        busy = false;
      }
    };
    client.cache(CANDLES).then(
      (opened) => {
        if (!mounted) return;
        log(`opened cache ${opened.id}`);
        cache = opened;
        void poll();
      },
      (error) => log(`could not open the cache: ${message(error)}`),
    );
    const timer = setInterval(() => void poll(), REFRESH_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [client, answered]);
  return frame;
}
