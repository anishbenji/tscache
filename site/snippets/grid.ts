import { createClient } from "@anishbenji/tscache";

// No fetcher: nothing loads, so a read returns its snapped range as a miss.
const client = await createClient({ mode: "in-process" });

// #region offset
const daily = await client.cache({
  id: "candles/ACME/1d",
  interval: 86_400_000,
  alignmentOffset: 52_200_000, // 14:30 UTC, the market's open
  fields: { open: "f64", high: "f64", low: "f64", close: "f64" },
});
// #endregion offset

// #region snap
// Not on the grid: read outward, from the open at or before the start to
// the open at or after the end.
const week = await daily.get({
  start: Date.UTC(2026, 9, 26, 9, 0),
  end: Date.UTC(2026, 9, 30, 9, 0),
});
console.log(week.misses[0]?.range); // 25 Oct 14:30 UTC to 30 Oct 14:30 UTC

// #endregion snap

// #region daily-dst
const DAY = 86_400_000;

// In the fetcher: a bar's identity is its trading date, so stamp it at
// 00:00 UTC of that date, whenever the session opened.
function dayStamp(tradingDate: string): number {
  return Date.parse(`${tradingDate}T00:00:00Z`); // "2026-03-06" → ms
}

const sessions = await client.cache({
  id: "candles/ACME/1d-by-date",
  interval: DAY, // alignmentOffset 0: midnight UTC
  fields: { close: "f64" },
});
// New York moved to daylight saving time on 8 March 2026: the session opened
// at 14:30 UTC on the 6th and at 13:30 UTC on the 9th. Both stamps are on
// the grid.
await sessions.put({
  timestamps: [dayStamp("2026-03-06"), dayStamp("2026-03-09")],
  fields: { close: [101.5, 102.25] },
});
// #endregion daily-dst

// #region weekly
const WEEK = 7 * DAY; // 604_800_000

// 1 January 1970, the epoch, was a Thursday. The first Monday, 5 January
// 1970, is 4 days later, so an offset of 4 days puts every slot on a
// Monday at 00:00 UTC (for Sunday weeks, 3 days).
const MONDAY = 4 * DAY; // 345_600_000

const weekly = await client.cache({
  id: "candles/ACME/1w",
  interval: WEEK,
  alignmentOffset: MONDAY,
  fields: { close: "f64" },
});
await weekly.put({
  timestamps: [Date.UTC(2026, 10, 2), Date.UTC(2026, 10, 9)], // two Mondays
  fields: { close: [99, 103] },
});
// #endregion weekly

// #region monthly
// Months differ in length, so no millisecond grid holds them. Store month n
// since January 1970 at timestamp n, on a grid of interval 1, and convert in
// the fetcher (ordinal range → months to ask for) and when drawing (ordinal →
// label). Every range, watermark and timestamp of this cache is an ordinal.
function monthIndex(year: number, month: number): number {
  return (year - 1970) * 12 + (month - 1); // month 1-12
}
function monthOf(index: number): { year: number; month: number } {
  // A true modulo: months before 1970 have negative ordinals.
  return {
    year: 1970 + Math.floor(index / 12),
    month: (((index % 12) + 12) % 12) + 1,
  };
}

const monthly = await client.cache({
  id: "candles/ACME/1mo",
  interval: 1,
  fields: { close: "f64" },
});
await monthly.put({
  timestamps: [monthIndex(2026, 9), monthIndex(2026, 10)],
  fields: { close: [97, 104] },
});
const months = await monthly.get(
  { start: monthIndex(2026, 1), end: monthIndex(2026, 12) },
  { cacheOnly: true },
);
console.log([...months.timestamps].map(monthOf)); // September and October 2026
// #endregion monthly

// #region jitter
const MINUTE = 60_000;

// In the fetcher: move each sample to the slot it belongs to, then keep one
// sample per slot (here the last; a mean or a sum are other choices), since
// a batch's timestamps must be unique and ascending.
function toGrid(
  samples: { t: number; value: number }[], // ascending by t
  interval: number,
): { timestamps: number[]; values: number[] } {
  const timestamps: number[] = [];
  const values: number[] = [];
  for (const { t, value } of samples) {
    const slot = Math.floor(t / interval) * interval; // alignmentOffset 0
    if (timestamps.at(-1) === slot) values[values.length - 1] = value;
    else {
      timestamps.push(slot);
      values.push(value);
    }
  }
  return { timestamps, values };
}

const gauge = await client.cache({
  id: "metrics/cpu/1m",
  interval: MINUTE,
  fields: { load: "f32" },
});
// 12:00:02, 12:00:58 and 12:01:01: the first two share the 12:00 slot.
const { timestamps, values } = toGrid(
  [
    { t: Date.UTC(2026, 10, 10, 12, 0, 2), value: 0.5 },
    { t: Date.UTC(2026, 10, 10, 12, 0, 58), value: 0.75 },
    { t: Date.UTC(2026, 10, 10, 12, 1, 1), value: 0.25 },
  ],
  MINUTE,
);
await gauge.put({ timestamps, fields: { load: values } });

// #endregion jitter

// Read by `bun run docs:run`, which checks what the example produced.
export { gauge, monthIndex, monthOf, months, sessions, week, weekly };
