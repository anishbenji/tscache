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
([Segments and slots](/concepts/segments)).

## Several resolutions

There is no resampling: one-minute and one-hour bars are two caches with two ids, each fetched from the
backend at its own interval. Put the interval in the id (`candles/ACME/1m`) so they never collide.

## A clear reaches every tab

`clear()` and `clearAll()` empty the shared cache for every tab ([Invalidation and
clearing](/concepts/invalidation)). For one view's housekeeping, `invalidate` instead.

## Memory

Nothing is evicted in version 1: a cache grows with what it is asked for and lives until its worker ends,
which for a SharedWorker is when the last tab of the origin closes. `clear()` frees a cache's points.
A long-lived page that scrolls far should clear what it no longer shows.
