import { expect, it } from "vitest";
import { snapRange } from "../src/entries/grid";
import { ConfigError } from "../src/errors";
import {
  calendarGridInternals,
  createCalendarGrid,
  createCalendarGridContext,
  msInto,
  startOf,
} from "../src/grid";
import type { CalendarInterval } from "../src/types";
import {
  daySlot,
  engine,
  HOUR,
  NY,
  probe,
  slots,
  utc,
} from "./calendar-contract-helpers";

// Implementer tests added after pre-review 1 and security lane 1 of step
// 129 (docs/reviews/step-129.md): each pins a behaviour that no test did.

const daily = { unit: "day", zone: NY, at: "09:30" } as const;
const winter = () => -5 * HOUR;

// N124: one least-recently-used order for all the tables of a context, in
// which every use counts, a grid's repeated use of one table included.
it("17: a table used again through its grid is not the next one evicted", () => {
  const { context, lookups } = probe(winter, { tableCapacity: 2 });
  const a = createCalendarGrid(daily, context);
  const b = createCalendarGrid({ ...daily, at: "09:31" }, context);
  const fill = (grid: typeof a, block: number) =>
    msInto(new Float64Array(slots(block * 512, block * 512 + 256)), grid);
  fill(a, 40);
  fill(b, 1);
  expect(context.tableCount).toBe(2);
  // A's table again, with no other table of A's in between.
  lookups.length = 0;
  startOf(40 * 512 + 3, a);
  expect(lookups).toEqual([]);
  // A third table: B's first is now the least recently used, and goes.
  fill(b, 2);
  expect(context.tableCount).toBe(2);
  lookups.length = 0;
  startOf(40 * 512 + 3, a);
  startOf(2 * 512 + 3, b);
  expect(lookups).toEqual([]);
  startOf(512 + 3, b);
  expect(lookups.length).toBeGreaterThan(0);
});

// Security lane S1.1: formatters are kept per zone the runtime knows, not
// per spelling, and a rejected config keeps none.
it("keeps one zone formatter for every spelling of a zone, and none for a rejected config", () => {
  const before = calendarGridInternals().formatters;
  const context = createCalendarGridContext();
  const spellings = Array.from({ length: 64 }, (_, n) =>
    [..."america/new_york"]
      .map((c, i) => ((n >> (i % 6)) & 1 ? c.toUpperCase() : c))
      .join(""),
  );
  expect(new Set(spellings).size).toBe(64);
  const zones = new Set<string>();
  for (const zone of spellings) {
    const grid = createCalendarGrid(
      { unit: "day", zone, at: "09:30" },
      context,
    );
    // Each spelling is a grid of its own, as written (N112)...
    zones.add(grid.interval.zone);
    // ...and each resolves the same starts.
    expect(startOf(daySlot("2026-03-09"), grid)).toBe(utc("2026-03-09T13:30Z"));
  }
  expect(zones.size).toBe(64);
  expect(calendarGridInternals().formatters - before).toBeLessThanOrEqual(1);

  // Rejected after its zone was checked: nothing is kept for it.
  const kept = calendarGridInternals().formatters;
  for (const zone of ["Asia/Tokyo", "asia/tokyo", "ASIA/TOKYO"]) {
    expect(() => engine({ unit: "day", zone }, { alignmentOffset: 5 })).toThrow(
      /alignmentOffset/,
    );
  }
  expect(calendarGridInternals().formatters).toBe(kept);
});

// The offset text: Intl's "longOffset" name in en-US, with seconds for a
// zone's local mean time. New York kept UTC−4:56:02 until 1883.
it("reads an offset with seconds from the runtime's zone data", () => {
  const grid = createCalendarGrid(daily);
  expect(startOf(daySlot("1800-06-02"), grid)).toBe(
    utc("1800-06-02T09:30Z") + (4 * 3600 + 56 * 60 + 2) * 1000,
  );
});

// Pre-review 2 (PR2-1). The grid entry runs per event and per frame: only the first call for a
// descriptor may pay for a zone check, which builds an Intl formatter.
it("18: the grid entry builds no formatter for a descriptor it has a grid for", () => {
  const range = { start: Date.UTC(2026, 2, 6), end: Date.UTC(2026, 2, 10) };
  const descriptor = (): CalendarInterval => ({
    unit: "day",
    zone: "Europe/Lisbon",
    at: "08:00",
  });
  const first = snapRange(range, descriptor());
  const built = calendarGridInternals().built;
  expect(built).toBeGreaterThan(0);
  for (let i = 0; i < 50; i++) {
    // An equal descriptor in a fresh object, as a caller passes its config.
    expect(snapRange(range, descriptor())).toEqual(first);
    expect(snapRange(range, descriptor(), 0)).toEqual(first);
  }
  expect(calendarGridInternals().built).toBe(built);
  // The offset rule holds on the held grid too, with cache()'s message.
  expect(() => snapRange(range, descriptor(), 5)).toThrow(ConfigError);
  expect(() => snapRange(range, descriptor(), 5)).toThrow(/alignmentOffset/);
  expect(calendarGridInternals().built).toBe(built);
});
