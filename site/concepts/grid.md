# Intervals and the grid

## The grid

Every cache has an `interval` in milliseconds, which is **required** and has no default, and an
`alignmentOffset`, default 0. Together they define the grid: the timestamps `t` with

```
(t - alignmentOffset) % interval === 0
```

Each grid point is a **slot**. A cache stores at most one point per slot, and every timestamp it stores
lies on the grid. The interval is the smallest distance between two points: a series at one minute and
the same series at one hour are two caches (there is no resampling).

Timestamps are milliseconds since the epoch, as `Float64` numbers, and must be safe integers
(|t| ≤ 2^53 − 1). Internally all range arithmetic runs on integer slot indices, and one module converts
between milliseconds and slots, so off-by-one errors have one place to live.

### alignmentOffset

The offset moves the grid. Daily bars stamped at a market's open, 14:30 UTC, are on a grid of one day
offset by 14.5 hours:

<<< @/snippets/grid.ts#offset{ts}

Any integer offset is accepted and normalised into `[0, interval)`: an offset of `interval + 5` names the
same grid as `5`, and both configs resolve identically. The grid is fixed: a session that moves with
daylight saving time does not fit one offset all year.

## Ranges

A `Range` is `{ start, end }` in milliseconds, **inclusive at both ends**. That is how chart libraries
report a visible range (Lightweight Charts' `setVisibleRange`, uPlot's scale `min`/`max`), so a chart's
range feeds `get` directly.

| Call | Range on the grid? | What happens |
|---|---|---|
| `get`, `invalidate` | need not be | snapped **outward**: `start` down to the slot at or before it, `end` up to the slot at or after it; reading or forgetting a little more is safe |
| `put`'s `options.range` | need not be | snapped **inward**: it claims the grid points inside it and no others, since claiming a slot nobody named would record a confirmed gap |
| `put`'s timestamps | must be | a timestamp off the grid rejects the whole batch with `PutError` `'misaligned'` |

`start === end` is legal: one slot when it is aligned, two when it is not (outward snap). A range whose
endpoints are not finite numbers within ±(2^53 − 1), or with `start > end`, rejects with
`InvalidRangeError`. The `coverage` and `misses` of a result are on the grid, in milliseconds.

<<< @/snippets/grid.ts#snap{ts}

::: tip Reading up to now
An end of `Date.now()` snaps outward to the next grid point, whose bar does not exist yet, so the read
asks the backend for it. A fetcher that reports `meta.finalizedUntil` keeps that slot provisional;
without a watermark, the empty slot would be recorded as a confirmed gap. Floor the end to the grid
(`Math.floor(now / interval) * interval` with offset 0) when you read up to the present.
:::

## Batches

A `put` batch (and a fetcher's response) is validated as a whole before anything changes:

1. `fields` names exactly the cache's fields, each a `number[]` or a typed array (`'field-mismatch'`);
2. every field has as many values as there are timestamps (`'length-mismatch'`);
3. timestamps are aligned, strictly ascending and unique; the first offender is reported with its index
   and value (`'misaligned'`, `'unsorted'`, `'duplicate'`);
4. with `options.range`, every timestamp lies inside it (`'range-mismatch'`).

Values are converted to the field's dtype by typed-array assignment, so `1.5` given for an `i32` field is
stored as `1`. `NaN` is a legal value. An empty batch is legal: with a range it states that the range
holds no points.

<<< @/snippets/cache.ts#put-error{ts}
