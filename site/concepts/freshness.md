# Versions and watermarks

Most of what a time-series cache holds never changes: yesterday's candles are final. tscache is built to
avoid refetching them, and gives you three tools for the parts that do change: a watermark for the live
tail, a dataset version for restatements, and [invalidation](/concepts/invalidation) for everything you
learn about out of band. There is no TTL.

## The watermark: `finalizedUntil`

Each cache has an optional **finalized watermark**. Points at `t >= finalizedUntil` are **provisional**:

- they are stored and returned by `get`, so the forming candle shows;
- their slots are never recorded as coverage, so every fetching `get` that includes them asks the
  backend for them again, and the answer replaces them (new data wins);
- they are excluded from overlap warnings.

Coverage is excluded when it is recorded, not when it is read. When the watermark later moves past a
provisional point, that point is still uncovered and is fetched once more: it may have changed.

How the watermark moves:

| Source | Direction |
|---|---|
| `CacheConfig.finalizedUntil` | the initial value, when the cache is created |
| a put's or a fetch response's `meta.finalizedUntil` | **forwards only**: a lower value is ignored, so responses that arrive out of order cannot pull it back |
| `cache.setFinalizedUntil(t)` | sets it exactly, either way; moving it back withdraws coverage from there on |

<<< @/snippets/cache.ts#watermark{ts}

A response's own watermark also bounds what it claims. A response carrying `meta.finalizedUntil` is
authoritative only below it: past it, its points are merged but replace nothing and record no coverage.
A late response with an older watermark therefore cannot delete, or confirm as a gap, a point it itself
called provisional.

A fetcher for a backend that publishes late or revises recent points **must** report
`meta.finalizedUntil` (the first timestamp that is not final yet). Otherwise a slot returned without a
point becomes a confirmed gap and is never fetched again.

## The dataset version

A cache can carry an opt-in dataset **version**, a non-empty string. It comes from
`CacheConfig.version`, or from the first `meta.version` a put or a response reports, which an
unversioned cache adopts without clearing anything. From then on:

- a put or response whose `meta.version` differs **clears the cache** (data and coverage), adopts the
  new version, then applies the batch; every tab hears `cacheCleared` with reason
  `'version-mismatch'`;
- a fetch that was in flight when the cache was cleared is not applied. A `get` that was waiting when
  the cache was cleared asks once more for what is still missing, whether the clear dropped an answer
  or wiped one already stored, and returns as `'uncached'` what a clear during that second request
  drops or wipes;
- a put without `meta.version` changes nothing about the version.

`version` and `finalizedUntil` in a config apply only when the cache is created. A tab that opens an
existing cache with other values joins it as it is, so a tab from an older deploy cannot clear or rewind
the live cache.

::: warning Restatements without a version are undetectable
If the backend changes a point the cache already covers and reports no version change, no library
mechanism can notice. The cache returns the old value until you `invalidate` the range or `clear` the
cache. Report `meta.version` from the fetcher when the backend has one.
:::

The rules, with the decisions behind them (N17–N19, N29), are in §2.4 and §4.5 of the
[architecture document](https://github.com/anishbenji/tscache/blob/main/docs/architecture.md).
