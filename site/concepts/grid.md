# Intervals and the grid

## The grid

Every cache has an `interval`, which is **required** and has no default. It is one of two things:

- a **fixed interval** in milliseconds, with an `alignmentOffset` (default 0);
- a **calendar interval**: a day, week, month, quarter or year in a time zone
  ([below](#calendar-intervals)).

A fixed interval and its offset define the grid as the timestamps `t` with

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

The offset moves a fixed grid. Daily bars stamped at 14:30 UTC are on a grid of one day offset by 14.5
hours:

<<< @/snippets/grid.ts#offset{ts}

Any integer offset is accepted and normalised into `[0, interval)`: an offset of `interval + 5` names the
same grid as `5`, and both configs resolve identically. A fixed grid does not move: a session that
follows daylight saving time does not fit one offset all year, and needs a calendar interval.

## Calendar intervals

A calendar interval makes each slot a calendar unit in a time zone. The slot starts when the zone's
clock reads `at` on the unit's first day:

```ts
interface CalendarInterval {
  unit: "day" | "week" | "month" | "quarter" | "year";
  zone?: string; // an IANA time zone; default "UTC"
  at?: string; // "HH:MM", 24-hour; default "00:00"
  weekStart?: 1 | 2 | 3 | 4 | 5 | 6 | 7; // weeks only: 1 = Monday (default) … 7 = Sunday
}
```

A New York session opens at 09:30 local time, which is 14:30 UTC in winter and 13:30 UTC in summer.
With a calendar interval both are slot starts, so daily bars are stamped at the open all year:

<<< @/snippets/grid.ts#daily-dst{ts}

Everything else works as on a fixed grid, in milliseconds: the ranges you pass, the timestamps a read
returns, `coverage`, `misses`, watermarks and events. What changes is where the grid points lie.

- **Every calendar day is a slot.** A weekend or a holiday is an empty slot: the fetcher's response
  covers it and holds no bar for it, so the cache records a confirmed gap and does not ask again. The
  cache holds no holiday list.
- **`alignmentOffset` is not used.** `zone` and `at` place the slots; an offset other than 0 is
  rejected with `ConfigError`.
- **Zones are compared as written.** `US/Eastern` and `America/New_York` are two grids, and a second
  tab that names the other one is refused. Use the canonical IANA name. A zone the runtime does not
  know is rejected with `ConfigError`.
- **Transitions.** A local time that a clock change skips starts after the change (an `at` of 02:30 on
  the day clocks go forward starts at 03:30), and one that occurs twice starts at the first.
- **Domain.** The years 1 to 9999. A range or timestamp outside them is rejected as one beyond the
  safe integers is on a fixed grid.
- **Reading the config back.** `interval` is `number | CalendarInterval` in a cache's config and in a
  fetcher's request, so TypeScript code narrows it before doing arithmetic
  (`typeof interval === "number"`).
- **Sizes count slots.** `gapSplitK` and `segmentSlotCap` count days, weeks or months: with the
  defaults, a closure of more than four days splits a segment, and one page of a daily cache spans
  about 89 years.
- **Units below a day** are not calendar units. A fixed interval covers those that divide an hour.

Zone rules come from the runtime's `Intl`, so the library bundles no time-zone data. A zone other than
`"UTC"` needs a runtime whose `Intl.DateTimeFormat` knows the `longOffset` time-zone name (Chrome 95,
Firefox 91, Safari 15.4, Node 18, or newer); in an older one such a zone is rejected with
`ConfigError`, as an unknown zone is. Two runtimes can
hold different rules, for example a server and the browser that hydrates its snapshot; see
[Server rendering](/guides/ssr#calendar-caches) for what the cache checks then.

### Grid arithmetic in the page

A view often needs the grid itself: the range a read returns for what is on screen, the bar forming
now, or the start of the next one. On a calendar grid a fixed step is wrong at every edge, so
`@anishbenji/tscache/grid` exports the arithmetic the cache uses, for both kinds of interval:

<<< @/snippets/grid.ts#calendar-page{ts}

| Function                                       | Returns                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `snapRange(range, interval, alignmentOffset?)` | `range` snapped outward to the grid: what `get` reads for it        |
| `slotStart(t, interval, alignmentOffset?)`     | the start of the slot that contains `t`                             |
| `nextSlotStart(t, interval, alignmentOffset?)` | the start of the slot after it; the difference is the slot's length |

An application that does not import the entry does not load it.

## Data that does not fit either grid

A `put` with a timestamp off the grid is rejected whole (`'misaligned'`), so data on another schedule
is mapped onto a grid in the fetcher, before the cache sees it. These recipes cover the common cases.

### Daily bars from an exchange that observes daylight saving time

Use a calendar interval with the exchange's zone and its opening time, as [above](#calendar-intervals).
If the backend stamps a daily bar at midnight of its trading date instead, use
`{ unit: "day" }` (UTC) or `{ unit: "day", zone }` with the default `at`, whichever the backend's
midnight is.

### Weekly bars

A week is a fixed 604,800,000 ms, so weekly bars fit the grid when every bar is stamped on the same
weekday at the same UTC time. The offset puts slot 0 on that weekday. The epoch, 1 January 1970, was a
Thursday, so Monday at 00:00 UTC is an offset of 4 days, 345,600,000 ms (Sunday is 3 days,
259,200,000 ms):

<<< @/snippets/grid.ts#weekly{ts}

A week that starts at local midnight in a zone, and so moves by an hour twice a year, is a calendar
week: `{ unit: "week", zone: "Europe/London" }`, with `weekStart` for a week that does not start on
Monday. A fixed week and a calendar week number their slots differently, so they are two caches.

### Monthly, quarterly and yearly bars

Months differ in length, so no millisecond interval holds them. A calendar interval does:

<<< @/snippets/grid.ts#monthly{ts}

Quarters and years work the same way (`unit: "quarter"`, `unit: "year"`), and each takes a `zone` and
an `at` like a day does.

::: tip A calendar the units do not cover
For a schedule none of the units describes (fiscal periods of four or five weeks, say), map each period
to an ordinal in the fetcher: store period `n` at timestamp `n` on a fixed grid of interval 1, and
convert back when drawing. Every range, watermark and timestamp of such a cache is then an ordinal, so
the fetcher converts the requested ordinals to the periods it asks the backend for.
:::

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
`InvalidRangeError`; so does a range outside a calendar interval's years 1 to 9999. The `coverage` and `misses` of a result are on the grid, in milliseconds.

<<< @/snippets/grid.ts#snap{ts}

::: tip Reading up to now
An end of `Date.now()` snaps outward to the next grid point, whose bar does not exist yet, so the read
asks the backend for it. A fetcher that reports `meta.finalizedUntil` keeps that slot provisional;
without a watermark, the empty slot would be recorded as a confirmed gap. Floor the end to the grid
when you read up to the present: `Math.floor(now / interval) * interval` with a fixed interval and
offset 0, or `slotStart(now, interval)` from `@anishbenji/tscache/grid` for any interval.
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
- **Integer fields** (`i32`, `u32`, `i16`, `u16`, `i8`, `u8`) accept only an integer inside the
  dtype's range (`-0` and an integral float such as `2.0` included), stored as given. A fraction
  (`1.5` for an `i32` field), `NaN`, `±Infinity` and a value outside the range (`300` or `-1` for
  `u8`) are rejected: round in the fetcher if the backend sends fractions for an integer field.

Nothing is coerced: a `null` from a JSON backend is rejected, not stored as `0`. A typed array of the
field's own dtype is accepted as it is, without a scan. An empty batch is legal: with a range it states
that the range holds no points.

A JSON backend has no `NaN`, so it usually sends `null` for a missing value. Map `null` to `NaN` for
float fields in the fetcher ([Fetchers](/guides/fetcher)); a response that still holds one is rejected,
and its range is reported `'fetch-failed'`.

<<< @/snippets/cache.ts#put-error{ts}
