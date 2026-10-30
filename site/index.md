# What tscache is

tscache caches timestamp-aligned time series in the browser: candles, metrics, sensor readings, event
counts. It is built for a chart that scrolls through history and follows a live tail, in several tabs at
once.

- **One cache for every tab.** The cache runs in a `SharedWorker`, so every same-origin tab reads the same
  data, and a range one tab fetched is never fetched again by another. Where there is no
  `SharedWorker` (Chrome on Android), it falls back to a dedicated `Worker` per tab, then to the page
  itself.
- **The worker fetches.** You give it a fetcher module; a `get` for a range the cache does not hold
  fetches only what is missing, once, however many tabs ask at the same moment.
- **Known gaps are first-class.** The cache records what it *knows* (coverage) separately from the points
  that *exist*. A weekend without candles, or an hour a sensor was offline, is a confirmed gap: it is
  never fetched again, and it is not confused with "not loaded yet".
- **Columns, not objects.** A read returns one typed array per field, which chart libraries take as they
  are, and moves them from the worker to the page without copying.
- **Honest freshness.** A watermark marks the provisional tail that is always fetched again; a dataset
  version clears the cache when the backend says history changed; `invalidate` forgets a range on your
  own clock. There is no TTL.

## A first look

<<< @/snippets/getting-started.ts#cache{ts}

<<< @/snippets/getting-started.ts#get{ts}

[Getting started](/guide/getting-started) sets up the worker and the fetcher;
[Coverage and gaps](/concepts/coverage) explains the result.

## What it leaves out

Version 1 has no aggregation or resampling (a series at one minute and at one hour are two caches), no
persistence across page loads, no eviction or memory limit, no subscriptions, and no irregular
timestamps. The [roadmap](https://github.com/anishbenji/tscache/blob/main/docs/roadmap.md) lists what is planned.

## Status

tscache is pre-release. The design is settled and recorded in the
[architecture document](https://github.com/anishbenji/tscache/blob/main/docs/architecture.md); [Architecture for contributors](/contributing)
summarises it.
