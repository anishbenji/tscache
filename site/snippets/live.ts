import { createClient, type PutBatch } from "tscache";
import workerUrl from "tscache/worker?worker&url";
import fetcherModule from "./fetcher.ts?fetcher";

const MINUTE = 60_000;
const client = await createClient({
  workerUrl,
  fetcher: { module: fetcherModule },
});
const cache = await client.cache({
  id: "candles/ACME",
  interval: MINUTE,
  fields: { open: "f64", high: "f64", low: "f64", close: "f64", volume: "u32" },
});

// #region push
// Server-Sent Events: each message is a put batch, the bar forming now
// (and the bar that just closed, when one did). Its meta.finalizedUntil
// keeps the forming bar provisional, so a fetching read asks for it again.
const events = new EventSource(`/api/stream/candles/ACME?interval=${MINUTE}`);
events.onmessage = ({ data }) => {
  const batch = JSON.parse(data as string) as PutBatch;
  // No range: adds or overwrites these bars and removes nothing.
  void cache.put(batch).then(() => redraw());
};
// #endregion push

// #region poll
// Polling: read the newest bars with a fetching get. Only what the cache
// lacks is fetched: the provisional end and any bar closed since.
setInterval(() => {
  // End on the bar forming now: an end of Date.now() snaps outward to the
  // next bar, which does not exist yet.
  const forming = Math.floor(Date.now() / MINUTE) * MINUTE;
  void cache
    .get({ start: forming - 5 * MINUTE, end: forming })
    .then(() => redraw());
}, 2000);
// #endregion poll

function redraw(): void {}
