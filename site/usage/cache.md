# A cache

`client.cache(config)` resolves with a `CacheHandle`. Its methods are one message each to the worker,
with the cache id filled in; `cache.id` is that id.

## Config

<<< @/snippets/cache.ts#config{ts}

| Field | Default | Meaning |
|---|---|---|
| `id` | required | any non-empty string; tabs that use the same id share the cache |
| `interval` | required | milliseconds between grid points ([the grid](/concepts/grid)) |
| `alignmentOffset` | `0` | shifts the grid; normalised into `[0, interval)` |
| `fields` | required | field name → dtype, at least one ([dtypes](/concepts/segments)) |
| `gapSplitK` | `4` | segments split where more than K slots in a row are empty |
| `segmentSlotCap` | `32768` | most slots per segment, at most 2^31 − 1 |
| `version` | none | dataset version; a different one reported by a put clears the cache |
| `finalizedUntil` | none | initial watermark; points at or after it are provisional |
| `warnOnOverlapDiff` | `false` | report writes that change held values ([events](/concepts/events)) |

An invalid config rejects with `ConfigError` naming the field.

## get(range, options?)

<<< @/snippets/cache.ts#get{ts}

Resolves with every present point in the range, its `coverage` and its `misses`
([Coverage and gaps](/concepts/coverage)). With a fetcher, it first awaits the fetches for what the
cache lacks.

| Option | Default | Meaning |
|---|---|---|
| `cacheOnly` | `false` | do not fetch; answer from the cache as it is |
| `snapshot` | `false` | also return a `snapshot` of the range, from the same state ([Snapshots](/usage/snapshots)) |

## put(batch, options?)

<<< @/snippets/cache.ts#put{ts}

Writes points. `batch.timestamps` is a `number[]` or `Float64Array`, aligned, strictly ascending;
`batch.fields` has one array per field; `batch.meta` may carry `version` and `finalizedUntil`, as a fetch
response does. `options.range` claims a range ([Claiming a range](/concepts/coverage#claiming-a-range-yourself)).
Resolves with `{ warnings }`, empty unless `warnOnOverlapDiff` is on.

The batch's typed arrays are **transferred** to the worker and are detached afterwards; pass copies if
you still need them. `number[]` arrays are copied.

An invalid batch rejects as a whole with `PutError`, before anything changes:

<<< @/snippets/cache.ts#put-error{ts}

## invalidate(range)

<<< @/snippets/cache.ts#invalidate{ts}

## clear()

Empties this cache, for every tab sharing the worker; see
[Invalidation and clearing](/concepts/invalidation).

## setFinalizedUntil(t)

<<< @/snippets/cache.ts#watermark{ts}

Sets the watermark exactly, either way ([Versions and watermarks](/concepts/freshness)).

## hydrate(snapshot)

Applies a snapshot where the cache knows nothing; see [Snapshots](/usage/snapshots).

## on(event, fn)

`client.on` filtered to this cache, for `cacheCleared` and `mergeWarning`. Returns the unsubscribe.

<<< @/snippets/cache.ts#events{ts}
