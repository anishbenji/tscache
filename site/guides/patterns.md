# Expiry and other patterns

What tscache deliberately leaves to the application, and the limits to design around. The repository's
[patterns guide](https://github.com/anishbenji/tscache/blob/main/docs/guides/patterns.md) is the maintained source of this page.

## Expiry on your own clock

There is no time-to-live. Most of what a time-series cache holds is history that never changes, where an
expiry would only cause refetches. For what does change:

- **a live tail**: report `meta.finalizedUntil` from the fetcher ([Live feeds](/guides/live-feeds));
- **a known correction**: `invalidate(range)`; the old points stay readable until the refetch replaces
  them;
- **a schedule** (a nightly batch rewrites yesterday): call `invalidate` or `clear` on your own clock.

<<< @/snippets/patterns.ts#expiry{ts}

With a SharedWorker one tab's timer serves every tab, since they read the same cache; with dedicated
workers each tab runs its own.

## Retrying failed ranges

A failed fetch is a miss, never a rejection, and nothing about it is cached. Retry on your terms:

<<< @/snippets/patterns.ts#retry{ts}

## Restatements need a version

If the backend changes covered history and says nothing, no library mechanism can notice. Report
`meta.version` when the backend has one; otherwise `invalidate` what you know changed.

## Integer fields cannot be missing

Presence is per point. A float field can hold `NaN` for a missing value; an integer field cannot. Store
such a field as `f32`/`f64` with `NaN`, or in a cache of its own
([Segments and slots](/concepts/segments)). A `null` given for any field rejects the whole batch
with `PutError` `'field-mismatch'` ([Batches](/concepts/grid#batches)), so map a JSON backend's `null`
to `NaN` in the fetcher.

## Several resolutions

There is no resampling: one-minute and one-hour bars are two caches with two ids, each fetched from the
backend at its own interval. Put the interval in the id (`candles/ACME/1m`) so they never collide.

## A clear reaches every tab

`clear()` and `clearAll()` empty the shared cache for every tab ([Invalidation and
clearing](/concepts/invalidation)). For one view's housekeeping, `invalidate` instead.

## Memory

Without a budget nothing bounds the memory a cache holds: a cache grows with what it is asked for and
lives until its worker ends. A SharedWorker ends only when the last tab of the origin that uses it closes
(in Chromium about 30 seconds later), so it outlives the tab that opened it for as long as any other tab
stays open, and so does everything it holds.

A bar costs the bytes of its fields plus one presence bit; timestamps are implicit
([Performance](/performance)). One year of one-minute OHLCV bars with five `f64` fields is
365 × 1,440 = 525,600 bars of 40 bytes and one bit each, about 21 MB per series, before the copies a
page keeps of what it read. A cache with `persist: true` loads its stored records into the worker's
memory when it opens ([Persistence](/guides/persistence)), so persistence does not reduce this.

**Set a memory budget** in every application that lets a user browse many series or a long history:

```ts
const client = await createClient({
  workerUrl,
  fetcher: { module: fetcherUrl },
  // 200 MB for every cache of the worker; in a SharedWorker, for all its tabs.
  memoryBudget: 200_000_000,
});
```

Above the budget the worker evicts the least recently used pages (a cache's `segmentSlotCap` slots,
about 22.8 days of one-minute bars by default) of any of its caches, and their coverage with them, so a
later `get` over an evicted range fetches it again; it never reads as a confirmed gap. This assumes a backend that answers consistently: if it contradicts itself, for example a later response without a range omits a bar an earlier one had sent, a budgeted cache shows what the latest response says, where an unbudgeted one could still hold the older bar. Reads and writes
keep a page recent, in every tab. The pages a pending `get` is reading, and those holding a provisional
bar (at or after the watermark), are never evicted: the budget may be exceeded while they are held, and
the excess goes when they are released. A fetch that never settles keeps its `get`'s pages pinned, so
the engine can stay over the budget until it settles: bound each request in the fetcher, for example with
`AbortSignal.timeout()` ([Writing a fetcher](/guides/fetcher)). A view that already shows an evicted
range keeps its copy, and the `cacheChanged` event lists the range under `evicted`, which needs no
re-read ([Change events](/concepts/events#change-events)). That copy lasts until the view's next
re-read: a later read from the cache, such as the `cacheOnly` read after another write, shows the
evicted part as `uncached` misses, which the application fetches if it wants them.

The budget counts the bytes the cached points' arrays have allocated, so the worker's real footprint is
somewhat larger: object overhead, a read's result until it reaches the page, and a load's records while
they are applied are not counted. `client.memoryStats()` reports the budget in force, the bytes held, the
part pinned now, the pages evicted so far and one row per cache; it is a call, so poll it on your own
clock if you want to watch memory. In a SharedWorker the first budget the worker receives holds until
it restarts: a tab that joins it with another value joins without error and is told, in a development
build, which budget is in force. A budget set after a cache already exists in the worker is not applied.
A deploy that changes the fetcher's URL or the tscache version starts a worker of its own
([Stale scripts after a deploy](/guides/workers#stale-scripts-after-a-deploy)), which takes the budget
its own tabs pass; a deploy that changes only the budget joins the running worker, and its value waits
for that worker to stop. Each worker has its own budget, so while tabs of two deploys are open the
origin can hold the sum of the two. Each dedicated worker or in-process client has its own engine and
its own budget.

Without a budget, pick the smallest dtype that holds each field (`f32` halves a field), and call
`clear()` on a cache the application no longer shows; it frees the cache's points for every tab
([A clear reaches every tab](#a-clear-reaches-every-tab)) and, for a persisted cache, deletes its stored
records too. `invalidate` keeps the points and frees nothing.
