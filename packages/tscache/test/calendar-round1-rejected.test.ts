import { expect, it } from "vitest";
import { Engine, useCalendarGridContext } from "../src/engine/engine";
import { ConfigError } from "../src/errors";
import {
  calendarGridInternals,
  createCalendarGridContext,
  heldGrids,
} from "../src/grid";
import type { CacheConfig } from "../src/types";
import {
  batch,
  DAY,
  engine,
  HOUR,
  ID,
  NY,
  probe,
  slots,
  span,
} from "./calendar-contract-helpers";

// Implementer tests added after Codex round 1 of step 129
// (docs/reviews/step-129.md, R1-3).

const daily = { unit: "day", zone: NY, at: "09:30" } as const;
const winter = () => -5 * HOUR;
const dailyStart = (slot: number) => slot * DAY + 14.5 * HOUR;
const BLOCK = 512;

// R1-3: a cache() that is rejected after its grid was made leaves nothing
// in the engine's context.
it("R1-3: rejected cache() calls leave no grid in the engine's context", () => {
  const shared = calendarGridInternals().grids;
  const context = createCalendarGridContext();
  const e = new Engine();
  useCalendarGridContext(e, context);
  for (let n = 0; n < 100; n++) {
    const config = {
      id: `c${n}`,
      interval: {
        ...daily,
        at: `10:${String(n % 60).padStart(2, "0")}`,
        unit: n < 60 ? "day" : "week",
      },
      fields: { value: "f64" },
      // Outside the calendar's domain: the cache's construction rejects it.
      finalizedUntil: 9_000_000_000_000_000,
    } as CacheConfig;
    expect(() => e.cache(config)).toThrow(ConfigError);
    expect(() => e.cache(config)).toThrow(/finalizedUntil/);
    expect(e.has(`c${n}`)).toBe(false);
  }
  expect(heldGrids(context)).toBe(0);
  expect(context.tableCount).toBe(0);
  // The shared context is not where they went either.
  expect(calendarGridInternals().grids).toBe(shared);
});

it("R1-3: a rejected cache() leaves the grid and tables of a cache that shares its descriptor", () => {
  const { context, lookups } = probe(winter);
  const e = engine(daily, {}, context);
  const timestamps = slots(40 * BLOCK, 40 * BLOCK + 256).map(dailyStart);
  e.put(ID, batch(timestamps));
  expect(heldGrids(context)).toBe(1);
  expect(context.tableCount).toBe(1);
  const rejected = {
    id: "other",
    interval: { ...daily },
    fields: { value: "f64" },
    finalizedUntil: 9_000_000_000_000_000,
  } as CacheConfig;
  expect(() => e.cache(rejected)).toThrow(/finalizedUntil/);
  expect(heldGrids(context)).toBe(1);
  expect(context.tableCount).toBe(1);
  // The live cache still reads from its table.
  lookups.length = 0;
  const read = e.get(ID, span(timestamps[0] as number, timestamps.at(-1)));
  expect(read.timestamps).toHaveLength(257);
  expect(lookups).toEqual([]);
});
