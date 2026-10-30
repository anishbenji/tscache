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
  fields: { close: "f64" },
});

// #region push
// Server-Sent Events: each message is a bar, as a put batch.
const events = new EventSource("/api/stream/candles/ACME");
events.onmessage = ({ data }) => {
  const bar = JSON.parse(data as string) as {
    t: number;
    close: number;
    finalizedUntil: number;
  };
  const batch: PutBatch = {
    timestamps: [bar.t],
    fields: { close: [bar.close] },
    // The forming bar is not final: it stays provisional, so a fetching
    // read asks the backend for it again.
    meta: { finalizedUntil: bar.finalizedUntil },
  };
  // No range: adds or overwrites this bar and removes nothing.
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
