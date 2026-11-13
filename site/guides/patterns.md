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

Nothing bounds the memory a cache holds, and nothing reports it. Version 1 has no eviction, no byte
budget and no call that returns a cache's size: a cache grows with what it is asked for and lives until
its worker ends. A SharedWorker ends only when the last tab of the origin that uses it closes (in
Chromium about 30 seconds later), so it outlives the tab that opened it for as long as any other tab
stays open, and so does everything it holds.

A bar costs the bytes of its fields plus one presence bit; timestamps are implicit
([Performance](/performance)). One year of one-minute OHLCV bars with five `f64` fields is
365 × 1,440 = 525,600 bars of 40 bytes and one bit each, about 21 MB per series, before the copies a
page keeps of what it read. A cache with `persist: true` loads all its stored records into the worker's
memory when it opens ([Persistence](/guides/persistence)), so persistence does not reduce this.

To keep memory in check today: pick the smallest dtype that holds each field (`f32` halves a field), and
call `clear()` on a cache the application no longer shows; it frees the cache's points for every tab
([A clear reaches every tab](#a-clear-reaches-every-tab)) and, for a persisted cache, deletes its stored
records too. `invalidate` keeps the points and frees
nothing. Eviction under a byte budget is sketched on the
[roadmap](https://github.com/anishbenji/tscache/blob/main/docs/roadmap.md#design-sketch-eviction-and-memory-limits).
