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

## Data that does not fit a fixed grid

The grid is one fixed step in milliseconds. Calendar-aware grids (a session that follows daylight saving
time, months of different lengths) are not supported. A `put` with a timestamp off the grid is rejected
whole (`'misaligned'`), so data on another schedule is mapped onto a grid in the fetcher, before the
cache sees it. These recipes cover the common cases.

### Daily bars from an exchange that observes daylight saving time

A session that opens at 9:30 New York time opens at 14:30 UTC in winter and 13:30 UTC in summer, so no
`alignmentOffset` fits it all year, and bars stamped at the open are rejected for half of it. A daily bar's
identity is its trading date, not the minute the session opened: stamp each bar at 00:00 UTC of that
date in the fetcher, on a grid of one day with offset 0.

<<< @/snippets/grid.ts#daily-dst{ts}

Ranges you read are then dates at midnight UTC too: a chart that shows the trading date reads the
same timestamps, and the session's open time, if you need it, is a field or a lookup of its own.

### Weekly bars

A week is a fixed 604,800,000 ms, so weekly bars fit the grid when every bar is stamped on the same
weekday at the same UTC time. The offset puts slot 0 on that weekday. The epoch, 1 January 1970, was a
Thursday, so Monday at 00:00 UTC is an offset of 4 days, 345,600,000 ms (Sunday is 3 days,
259,200,000 ms):

<<< @/snippets/grid.ts#weekly{ts}

A week that starts in a local time zone, or follows daylight saving time, is stamped at its date as
above.

### Monthly, quarterly and yearly bars

Months differ in length, so no millisecond interval holds them. Map each month to an ordinal, its number
of months since January 1970, store it as the timestamp on a grid of interval 1, and convert back when
drawing:

<<< @/snippets/grid.ts#monthly{ts}

The trade-off: the cache no longer holds times. Every range you pass to `get`, `invalidate` or `put`,
every `meta.finalizedUntil` the fetcher reports, and every timestamp a read returns is an ordinal, so
the fetcher converts the requested ordinal range to the months it asks the backend for, and the chart
needs a label for each ordinal. Quarters and years work the same way with their own ordinals.

### Jittered timestamps

Samples that arrive near, but not on, a fixed step are moved to the slot they belong to in the fetcher.
For a metric scraped every minute by a job that only ever runs late (12:00:02, 12:01:03, 12:01:58),
flooring, `Math.floor(t / interval) * interval` with offset 0, assigns each sample to the slot that
starts at or before it. Jitter on both sides of the step (12:00:58 meant for 12:01) needs rounding to the
nearest slot instead, `Math.round(t / interval) * interval`, since flooring would move such a sample into
the slot before. Either way two samples can land in one slot. A batch's timestamps must be unique, so
decide which one the slot keeps (the last, a mean, a sum) before the `put`:

<<< @/snippets/grid.ts#jitter{ts}

## Ranges

A `Range` is `{ start, end }` in milliseconds, **inclusive at both ends**. That is how chart libraries
report a visible range (Lightweight Charts' `setVisibleRange`, uPlot's scale `min`/`max`), so a chart's
range feeds `get` directly.

| Call                    | Range on the grid? | What happens                                                                                                                                    |
| ----------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `get`, `invalidate`     | need not be        | snapped **outward**: `start` down to the slot at or before it, `end` up to the slot at or after it; reading or forgetting a little more is safe |
| `put`'s `options.range` | need not be        | snapped **inward**: it claims the grid points inside it and no others, since claiming a slot nobody named would record a confirmed gap          |
| `put`'s timestamps      | must be            | a timestamp off the grid rejects the whole batch with `PutError` `'misaligned'`                                                                 |

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
4. with `options.range`, every timestamp lies inside it (`'range-mismatch'`);
5. every value is one its field can hold (`'field-mismatch'`, naming the field, index, timestamp and
   value; the error's `offenderField` is the field).

What each field accepts:

- **Every field** rejects a value that is not a number: `null`, `undefined`, a hole in an array, a
  string (`"1"` included), a boolean, a bigint or an object.
- **Float fields** (`f64`, `f32`) accept every number, `NaN`, `Infinity` and `-Infinity` included.
  `f32` stores the nearest float32.
- **Integer fields** (`i32`, `u32`, `i16`, `u16`, `i8`, `u8`) accept a finite number whose truncation
  toward zero lies in the dtype's range, and store the truncation: `1.5` given for an `i32` field is
  stored as `1`. `NaN`, `±Infinity` and a value outside the range (`300` or `-1` for `u8`) are
  rejected.

Nothing is coerced: a `null` from a JSON backend is rejected, not stored as `0`. A typed array of the
field's own dtype is accepted as it is, without a scan. An empty batch is legal: with a range it states
that the range holds no points.

The conversions below never reject the batch and never warn, so a value that is not a valid number for
its field is stored as some other number. Only an element that cannot be converted to a number at all (a
BigInt, a symbol, an object whose conversion throws) rejects the batch with `PutError` `'field-mismatch'`:

| Value given      | Float field (`f32`, `f64`)                  | Integer field (`i32`, `u8`, ...)                                    |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| `null`           | `0`                                         | `0`                                                                 |
| `undefined`      | `NaN`                                       | `0`                                                                 |
| `NaN`            | `NaN`                                       | `0`                                                                 |
| A fraction       | kept (`f32` rounds it to the nearest `f32`) | truncated toward zero: `1.5` is `1`                                 |
| Outside the type | `f32`: `Infinity` beyond about 3.4 × 10^38  | wraps around the type's range: `300` in `u8` is `44`, `-1` is `255` |

A JSON backend has no `NaN`, so it usually sends `null` for a missing value, and the cache would store a
bar of price `0`, indistinguishable from data. Map `null` to `NaN` for float fields in the fetcher
([Fetchers](/guides/fetcher)), and check integer fields' ranges there if the backend can exceed them.

<<< @/snippets/cache.ts#put-error{ts}
