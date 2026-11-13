# What tscache is

tscache caches timestamp-aligned time series in the browser: candles, metrics, sensor readings, event
counts. It is built for a chart that scrolls through history and follows a live tail, in several tabs at
once.

- **One cache for every tab.** The cache runs in a `SharedWorker`, so every same-origin tab reads the same
  data. Where there is no `SharedWorker` (Samsung Internet, Chrome for Android before 148), it falls back to a dedicated `Worker`,
  then to the page itself; those give each tab a cache of its own, shared with no other tab.
- **The worker fetches.** You give it a fetcher module, and a `get` fetches only the ranges its cache
  neither holds nor already has in flight, widened by one interval where a miss meets cached data so the
  series joins up (that edge point is fetched again). Under the SharedWorker, concurrent reads of a range from
  several tabs wait on one fetch, and finalized history one tab fetched is not fetched again by
  another. Points at or after the `finalizedUntil` watermark are provisional: every read that includes
  them fetches them again.
- **Known gaps are first-class.** The cache records what it _knows_ (coverage) separately from the points
  that _exist_. A weekend without candles, or an hour a sensor was offline, is a confirmed gap: it is
  never fetched again, and it is not confused with "not loaded yet".
- **Columns, not objects.** A read returns one typed array per field, which chart libraries take as they
  are, and moves them from the worker to the page without copying.
- **Honest freshness.** A watermark marks the provisional tail that is always fetched again; a dataset
  version clears the cache when the backend says history changed; `invalidate` forgets a range on your
  own clock. There is no TTL.

<figure class="demo-video">
  <video autoplay muted loop playsinline controls width="960" height="600" aria-describedby="demo-sharing" style="width: 100%; height: auto">
    <source src="/media/multi-tab-sharing.webm" type="video/webm" />
    <source src="/media/multi-tab-sharing.mp4" type="video/mp4" />
  </video>
  <figcaption id="demo-sharing">Two tabs of one origin. Tab 1 opens with an empty cache, and its SharedWorker fetches the history in one fetch. Tab 2 opens on the same SharedWorker and draws the same chart at once from the shared cache; the backend serves it only the newest bars, the one forming now and the one that just closed. Recorded from the demo hub's vanilla reference client by <code>scripts/demo/record.ts</code>; the counters above the page are its mock backend's. The two tabs are two frames of one page, which share the SharedWorker as two tabs do.</figcaption>
</figure>

## A first look

<<< @/snippets/getting-started.ts#cache{ts}

<<< @/snippets/getting-started.ts#get{ts}

[Getting started](/guide/getting-started) sets up the worker and the fetcher;
[Coverage and gaps](/concepts/coverage) explains the result.

## What it leaves out

Version 1 has no aggregation or resampling (a series at one minute and at one hour are two caches), no
eviction or memory limit, no subscriptions, and no irregular timestamps. The [roadmap](https://github.com/anishbenji/tscache/blob/main/docs/roadmap.md) lists what is planned.

### Known limits

Three limits of 0.1.0 that an application has to design around:

- **Memory is neither bounded nor reported.** A cache keeps everything it was asked for until its worker
  ends, and a SharedWorker runs while any tab of the origin uses it. A year of one-minute OHLCV bars is
  about 21 MB per series. [Memory](/guides/patterns#memory) says how to keep it in check.
- **A deploy can leave tabs on two versions.** With a hashed worker URL, old and new tabs run separate
  SharedWorkers that share no memory, silently, and both write the origin's IndexedDB database; with a
  fixed URL, a protocol change or a new fetcher module URL makes `createClient` reject
  (`ProtocolMismatchError` or `ConfigError`) until the old tabs close.
  [Stale scripts after a deploy](/guides/workers#stale-scripts-after-a-deploy) has the details.
- **Readers are not told when data changes.** A view that must redraw reads again.
  [Redrawing when the cache changes](/guides/live-feeds#redrawing-when-the-cache-changes) shows how.

## Status

tscache is at 0.x and follows semantic versioning within it: a minor release may break the API, a
patch release never does. Pin a minor range (`~0.1.0`) to take fixes without breaking changes. The
design is recorded in the
[architecture document](https://github.com/anishbenji/tscache/blob/main/docs/architecture.md); [Architecture for contributors](/contributing)
summarises it.
