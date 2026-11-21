import { createClient } from "@anishbenji/tscache";
import { nextSlotStart, slotStart, snapRange } from "@anishbenji/tscache/grid";

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
// One slot per New York session day, starting at the open: 14:30 UTC in
// winter and 13:30 UTC in summer.
const sessions = await client.cache({
  id: "candles/ACME/1d-ny",
  interval: { unit: "day", zone: "America/New_York", at: "09:30" },
  fields: { close: "f64" },
});
// New York moved to daylight saving time on 8 March 2026. Both opens are
// slot starts, so both bars are on the grid.
await sessions.put({
  timestamps: [
    Date.UTC(2026, 2, 6, 14, 30), // Friday, 09:30 EST
    Date.UTC(2026, 2, 9, 13, 30), // Monday, 09:30 EDT
  ],
  fields: { close: [101.5, 102.25] },
});
// #endregion daily-dst

// #region calendar-page
// A view's range as the cache reads it, and the bar forming now, for any
// interval: the arithmetic the engine itself uses.
const nySession = {
  unit: "day",
  zone: "America/New_York",
  at: "09:30",
} as const;
const shown = snapRange(
  { start: Date.UTC(2026, 2, 6, 20), end: Date.UTC(2026, 2, 9, 20) },
  nySession,
); // 6 March 14:30 UTC to 10 March 13:30 UTC
const forming = slotStart(Date.UTC(2026, 2, 9, 20), nySession); // 9 March 13:30 UTC
const next = nextSlotStart(forming, nySession); // 10 March 13:30 UTC
// #endregion calendar-page

// #region weekly
const DAY = 86_400_000;
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
// One slot per calendar month, starting at 00:00 UTC of its first day.
const monthly = await client.cache({
  id: "candles/ACME/1mo",
  interval: { unit: "month" },
  fields: { close: "f64" },
});
await monthly.put({
  timestamps: [Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1)], // September, October
  fields: { close: [97, 104] },
});
// Ranges are instants too, snapped outward as on any grid: mid-January
// reads from January's start.
const months = await monthly.get(
  { start: Date.UTC(2026, 0, 15), end: Date.UTC(2026, 11, 1) },
  { cacheOnly: true },
);
console.log([...months.timestamps].map((t) => new Date(t).toISOString()));
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
// A scraper that only ever runs late: 12:00:02, 12:01:03 and 12:01:58 (a
// repeated scrape). The last two share the 12:01 slot, which keeps 0.25.
const { timestamps, values } = toGrid(
  [
    { t: Date.UTC(2026, 10, 10, 12, 0, 2), value: 0.5 },
    { t: Date.UTC(2026, 10, 10, 12, 1, 3), value: 0.75 },
    { t: Date.UTC(2026, 10, 10, 12, 1, 58), value: 0.25 },
  ],
  MINUTE,
);
await gauge.put({ timestamps, fields: { load: values } });

// #endregion jitter

// Read by `bun run docs:run`, which checks what the example produced.
export { forming, gauge, months, next, sessions, shown, week, weekly };
