# Invalidation and clearing

| Call | Coverage | Points | Config, version, watermark | Event |
|---|---|---|---|---|
| `cache.invalidate(range)` | removed over the range, snapped outward | kept | kept | none |
| `cache.clear()` | all removed | all removed | kept | `cacheCleared`, `'manual'` |
| `client.clearAll()` | all removed, every cache | all removed | kept | `cacheCleared`, `'clear-all'`, per cache |

## invalidate

`invalidate` forgets what the cache knows about a range. The next fetching `get` over it asks the
backend again, and the answer replaces the range's points. Until then the old points are still returned,
so a chart does not go blank; `coverage` no longer includes them. Use it for a correction you learned
about out of band, or for expiry on your own clock ([Expiry and other patterns](/guides/patterns)).

<<< @/snippets/cache.ts#invalidate{ts}

The range snaps outward, like a read's, so it may forget a little more than you named, never less.

## clear and clearAll

`clear` empties one cache; `clearAll` empties every cache of the worker. The caches themselves stay:
their configs, versions and watermarks describe the dataset, not its contents, and every handle in every
tab stays valid.

::: warning With a SharedWorker, a clear reaches every tab
Every same-origin tab reads the same caches. `clear()` and `clearAll()` empty them for all tabs, and
every tab hears `cacheCleared`. Use them for resets that should apply everywhere (a logout, a version
change you detected yourself). To refetch a range for one view, `invalidate` it. On Chrome for Android,
which has no SharedWorker, each tab has its own worker and a clear stays in that tab.
:::

<<< @/snippets/cache.ts#events{ts}

## What a write removes

A write that states its range replaces it: every orchestrated fetch, and a `put` with `options.range`.
Afterwards the points inside the range are exactly the batch's, so a point the backend no longer returns
disappears. A `put` without a range only adds or overwrites the points it carries and never removes one.
