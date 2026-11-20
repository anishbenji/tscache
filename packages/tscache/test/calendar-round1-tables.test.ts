import { expect, it } from "vitest";
import { slotStart } from "../src/entries/grid";
import { createCalendarGrid, heldTables, msInto, startOf } from "../src/grid";
import { DAY, HOUR, NY, probe, slots } from "./calendar-contract-helpers";

// Implementer tests added after Codex round 1 of step 129
// (docs/reviews/step-129.md, R1-1).

const daily = { unit: "day", zone: NY, at: "09:30" } as const;
const winter = () => -5 * HOUR;
const dailyStart = (slot: number) => slot * DAY + 14.5 * HOUR;
const BLOCK = 512;
/** More than half of a block: a conversion that fills its table. */
const most = (block: number) =>
  new Float64Array(slots(block * BLOCK, block * BLOCK + 256));

// R1-1: a table the context evicted, or a grid it dropped, is referenced
// by nothing, the grid's shortcut to its last table included.
it("R1-1: a grid holds no reference to a table the context evicted", () => {
  const { context } = probe(winter, { tableCapacity: 1 });
  const a = createCalendarGrid(daily, context);
  const b = createCalendarGrid({ ...daily, at: "09:31" }, context);
  msInto(most(40), a);
  expect(heldTables(a)).toBe(1);
  // B's table takes the context's one place: A's is evicted.
  msInto(most(40), b);
  expect(context.tableCount).toBe(1);
  expect(heldTables(a)).toBe(0);
  expect(heldTables(b)).toBe(1);
  // Thirty grids in turn: only the last holds a table.
  const grids = Array.from({ length: 30 }, (_, n) =>
    createCalendarGrid(
      { ...daily, at: `10:${String(n).padStart(2, "0")}` },
      context,
    ),
  );
  for (const grid of grids) msInto(most(40), grid);
  expect(grids.map(heldTables).reduce((sum, held) => sum + held, 0)).toBe(1);
  expect(heldTables(b)).toBe(0);
  // An evicted table is computed again, to the same starts.
  const again = most(40);
  msInto(again, a);
  expect(again[3]).toBe(dailyStart(40 * BLOCK + 3));
});

it("R1-1: a grid the shared context drops holds no table reference", () => {
  const descriptor = { unit: "day", zone: "Asia/Seoul", at: "03:00" } as const;
  const grid = createCalendarGrid(descriptor);
  const starts = most(40);
  msInto(starts, grid);
  expect(heldTables(grid)).toBe(1);
  const t = Date.UTC(2026, 5, 3);
  for (let n = 0; n < 64; n++) {
    const at = `0${5 + Math.floor(n / 50)}:${10 + (n % 50)}`;
    slotStart(t, { unit: "month", zone: "Asia/Seoul", at });
  }
  expect(createCalendarGrid(descriptor)).not.toBe(grid);
  expect(heldTables(grid)).toBe(0);
  // Whoever still holds the dropped grid goes on converting with it.
  expect(startOf(40 * BLOCK + 3, grid)).toBe(starts[3]);
});
