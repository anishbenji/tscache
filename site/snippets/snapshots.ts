import {
  type CacheConfig,
  createClient,
  decodeSnapshot,
  type EncodedSnapshot,
  encodeSnapshot,
  type Range,
  TscacheError,
} from "tscache";
import workerUrl from "tscache/worker?worker&url";
import fetcherModule from "./fetcher.ts?fetcher";

const config: CacheConfig = {
  id: "candles/ACME",
  interval: 60_000,
  fields: { close: "f64" },
};
const range: Range = { start: Date.now() - 3_600_000, end: Date.now() };

// #region server
// On the server: an in-process client (no worker), with a fetcher module
// the server can import().
const server = await createClient({
  mode: "in-process",
  fetcher: { module: new URL("./fetcher.js", import.meta.url) },
});
const serverCache = await server.cache(config);

// One read gives the page's columns and the cache's snapshot (same state).
const { snapshot, ...result } = await serverCache.get(range, {
  snapshot: true,
});
if (snapshot === undefined) throw new Error("the read carries no snapshot");
// Escape every "<" so no string can close the script element.
const json = JSON.stringify(encodeSnapshot(snapshot)).replaceAll(
  "<",
  "\\u003c",
);
const html = `<p>${result.timestamps.length} candles</p>
<script id="tscache-snapshot" type="application/json">${json}</script>`;
// #endregion server
console.log(html);

// #region browser
// In the browser, before the first live read.
const text = document.getElementById("tscache-snapshot")?.textContent;
// The browser's client has a fetcher too: it loads what the snapshot lacks.
const client = await createClient({
  workerUrl,
  fetcher: { module: fetcherModule },
});
const cache = await client.cache(config);
if (text != null) {
  const seed = decodeSnapshot(JSON.parse(text) as EncodedSnapshot);
  try {
    const { applied, skipped } = await cache.hydrate(seed);
    console.log(applied, skipped); // skipped: "version-mismatch" when refused
  } catch (error) {
    // A worker from before hydrate (a stale cached script) refuses the op:
    // nothing was applied, and the read below fetches instead.
    const old =
      error instanceof TscacheError && error.message === "unknown op hydrate";
    if (!old) throw error;
  }
}
// This read fetches only what the snapshot did not cover.
await cache.get(range);
// #endregion browser
