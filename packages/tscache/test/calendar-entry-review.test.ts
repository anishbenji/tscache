import { expect, it } from "vitest";
import { slotStart, snapRange } from "../src/entries/grid";
import { ConfigError } from "../src/errors";
import { calendarGridInternals } from "../src/grid";
import type { CalendarInterval } from "../src/types";

// Implementer test added after the pre-review before Codex round 2 of
// step 129 (docs/reviews/step-129.md, PR3-2).

// PR3-2: a grid-entry call that is rejected holds no grid, so rejected
// calls cannot push the grids of live views out of the shared context.
it("18: rejected grid-entry calls leave the shared context's grids as they were", () => {
  const range = { start: Date.UTC(2026, 2, 6), end: Date.UTC(2026, 2, 10) };
  const live: CalendarInterval = {
    unit: "day",
    zone: "Europe/Paris",
    at: "09:00",
  };
  const shown = snapRange(range, live);
  const held = calendarGridInternals().grids;
  expect(held).toBeGreaterThan(0);
  // 200 distinct valid descriptors, each with an offset a calendar refuses.
  for (let n = 0; n < 200; n++) {
    const at = `${String(10 + Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
    const rejected = () =>
      slotStart(range.start, { unit: "day", zone: "Europe/Paris", at }, 5);
    expect(rejected).toThrow(ConfigError);
    expect(rejected).toThrow(/alignmentOffset/);
  }
  expect(calendarGridInternals().grids).toBe(held);
  // The live view's grid is still held: asking again builds no formatter.
  const built = calendarGridInternals().built;
  expect(snapRange(range, { ...live })).toEqual(shown);
  expect(calendarGridInternals().built).toBe(built);
  // The errors keep cache()'s order: an invalid descriptor before the offset.
  expect(() => slotStart(0, { unit: "day", zone: "No/Zone" }, 5)).toThrow(
    /zone/,
  );
});
