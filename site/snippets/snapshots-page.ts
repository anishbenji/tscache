// The page's entry, as a bundler builds it. Not run by `bun run docs:run`:
// it reads `document` and imports through Vite's `?worker&url` and
// `?fetcher`.
// #region page
import workerUrl from "tscache/worker?worker&url";
import fetcherModule from "./fetcher.ts?fetcher";
import { startCache } from "./snapshots-browser";

const MINUTE = 60_000;
const now = Math.floor(Date.now() / MINUTE) * MINUTE;
const result = await startCache(
  { workerUrl, fetcher: { module: fetcherModule } },
  { start: now - 6 * 60 * MINUTE, end: now }, // the range the server read
  document.getElementById("tscache-snapshot")?.textContent,
);
// #endregion page
console.log(result.timestamps.length);
