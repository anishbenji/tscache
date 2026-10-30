import { type CacheHandle, createClient, type PutBatch } from "tscache";
import workerUrl from "tscache/worker?worker&url";
import fetcherModule from "./fetcher.ts?fetcher";

const MINUTE = 60_000;
const client = await createClient({
  workerUrl,
  fetcher: { module: fetcherModule },
});
const cache = await client.cache({
  id: "crypto/BTC", // trades around the clock, so bars form at any hour
  interval: MINUTE,
  fields: { open: "f64", high: "f64", low: "f64", close: "f64", volume: "u32" },
});

// #region push
/** Puts every bar the backend streams; returns the stop. */
export function followStream(cache: CacheHandle, redraw: () => void) {
  // Server-Sent Events: the backend names each message `bar` (onmessage
  // hears only unnamed ones). Its data is a put batch, the bar forming now
  // (and the bar that just closed, when one did); its meta.finalizedUntil
  // keeps the forming bar provisional, so a fetching read asks for it again.
  const events = new EventSource(`/api/stream/crypto/BTC?interval=${MINUTE}`);
  events.addEventListener("bar", (event) => {
    const batch = JSON.parse((event as MessageEvent<string>).data) as PutBatch;
    // No range: adds or overwrites these bars and removes nothing.
    void cache.put(batch).then(redraw);
  });
  return () => events.close();
}
// #endregion push

// #region poll
/** Reads the newest bars with a fetching get, every two seconds. */
export function startPolling(
  cache: CacheHandle,
  redraw: () => void,
  everyMs = 2000,
) {
  // Only what the cache lacks is fetched: the provisional end and any bar
  // closed since. End on the bar forming now: an end of Date.now() snaps
  // outward to the next bar, which does not exist yet.
  const timer = setInterval(() => {
    const forming = Math.floor(Date.now() / MINUTE) * MINUTE;
    void cache.get({ start: forming - 5 * MINUTE, end: forming }).then(redraw);
  }, everyMs);
  return () => clearInterval(timer);
}
// #endregion poll

// Read by `bun run docs:run`, which runs both feeds against the mock backend.
export { cache };
