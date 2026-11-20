import { expect, it } from "vitest";
import { nextSlotStart, slotStart, snapRange } from "../src/entries/grid";
import {
  calendarGridInternals,
  createCalendarGrid,
  msInto,
  startOf,
} from "../src/grid";
import type { CalendarInterval } from "../src/types";
import { slots } from "./calendar-contract-helpers";

// Implementer tests added after security lane 2 of step 129
// (docs/reviews/step-129.md, S2.2).

// S2.2: the context the grid entry shares holds a bounded number of grids,
// least recently used out, whatever a page passes it.
it("18: the grid entry's shared context holds a bounded number of grids", () => {
  const range = { start: Date.UTC(2026, 2, 6), end: Date.UTC(2026, 2, 10) };
  const spelling = (n: number): CalendarInterval => ({
    unit: "day",
    zone: [..."europe/amsterdam"]
      .map((c, i) => ((n >> (i % 10)) & 1 ? c.toUpperCase() : c))
      .join(""),
    at: "09:00",
  });
  const expected = snapRange(range, spelling(0));
  for (let n = 1; n < 500; n++) {
    expect(snapRange(range, spelling(n))).toEqual(expected);
  }
  const { grids } = calendarGridInternals();
  expect(grids).toBeGreaterThan(1);
  expect(grids).toBeLessThanOrEqual(64);
});

it("18: a grid the shared context drops gives up its tables and goes on converting", () => {
  const descriptor = { unit: "day", zone: "Asia/Seoul", at: "03:00" } as const;
  const grid = createCalendarGrid(descriptor);
  const block = 40 * 512;
  const starts = new Float64Array(slots(block, block + 256));
  msInto(starts, grid);
  const held = calendarGridInternals().tables;
  expect(held).toBeGreaterThan(0);
  // 64 other descriptors push it out of the context.
  const t = Date.UTC(2026, 5, 3);
  for (let n = 0; n < 64; n++) {
    slotStart(t, {
      unit: "month",
      zone: "Asia/Seoul",
      at: `05:${10 + (n % 50)}`,
    });
    slotStart(t, {
      unit: "quarter",
      zone: "Asia/Seoul",
      at: `05:${10 + (n % 50)}`,
    });
  }
  expect(calendarGridInternals().tables).toBeLessThan(held);
  // A cache that still holds the dropped grid reads the same starts from it,
  // and a new grid of the descriptor agrees.
  expect(startOf(block + 3, grid)).toBe(starts[3]);
  const again = createCalendarGrid(descriptor);
  expect(again).not.toBe(grid);
  expect(startOf(block + 3, again)).toBe(starts[3]);
});

it("18: a grid used again is not the next one the shared context drops", () => {
  const kept: CalendarInterval = {
    unit: "week",
    zone: "Asia/Tokyo",
    at: "07:15",
  };
  const other = (n: number): CalendarInterval => ({
    unit: "day",
    zone: "Asia/Tokyo",
    at: `${10 + Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`,
  });
  const t = Date.UTC(2026, 5, 3);
  const start = slotStart(t, kept);
  // 40 other grids, the kept one again, 40 more: 81 descriptors, more than
  // the 64 the context holds. The kept one is never the least recently
  // used, so the first others are the ones dropped.
  for (let n = 0; n < 40; n++) nextSlotStart(t, other(n));
  expect(slotStart(t, { ...kept })).toBe(start);
  for (let n = 40; n < 80; n++) nextSlotStart(t, other(n));
  expect(calendarGridInternals().grids).toBe(64);
  // Still held: asking for it again builds no formatter.
  const built = calendarGridInternals().built;
  expect(slotStart(t, { ...kept })).toBe(start);
  expect(calendarGridInternals().built).toBe(built);
  // The first of the others was dropped: it is validated again.
  nextSlotStart(t, other(0));
  expect(calendarGridInternals().built).toBeGreaterThan(built);
});
