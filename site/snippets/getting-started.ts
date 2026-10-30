// #region client
import { createClient } from "tscache";
// Vite: `?worker&url` bundles the module worker and gives its served URL.
import workerUrl from "tscache/worker?worker&url";
// tscache/vite's plugin: the fetcher module's URL, its exports kept.
import fetcherModule from "./fetcher.ts?fetcher";

const client = await createClient({
  workerUrl,
  fetcher: { module: fetcherModule },
});
console.log(client.mode); // "shared", or "dedicated" where SharedWorker is missing
// #endregion client

// #region cache
const MINUTE = 60_000;
const candles = await client.cache({
  id: "candles/ACME",
  interval: MINUTE, // required: there is no default
  fields: { open: "f64", high: "f64", low: "f64", close: "f64", volume: "f64" },
});
// #endregion cache

// #region get
// The bar forming now: reading to Date.now() would also ask for the next one.
const now = Math.floor(Date.now() / MINUTE) * MINUTE;
const result = await candles.get({ start: now - 6 * 60 * MINUTE, end: now });

// Present points only: equal-length columns, no holes.
const { timestamps, fields } = result;
console.log(timestamps.length, fields.close?.at(-1));

// What is known, and what is not.
for (const range of result.coverage) {
  console.log("authoritative", range.start, range.end);
}
for (const miss of result.misses) {
  console.log("not loaded", miss.range, miss.reason, miss.error?.message);
}

// #endregion get

// Read by `bun run docs:run`, which checks what the example produced.
export { result };
