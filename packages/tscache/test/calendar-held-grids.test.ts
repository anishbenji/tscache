import { describe, expect, it } from "vitest";
import { validateBatch } from "../src/engine/batch";
import { CacheState } from "../src/engine/cache";
import { Engine, useCalendarGridContext } from "../src/engine/engine";
import { resolveCacheConfig } from "../src/engine/validate";
import { nextSlotStart, slotStart, snapRange } from "../src/entries/grid";
import {
  calendarGridInternals,
  createCalendarGrid,
  createCalendarGridContext,
  gridOf,
  heldGrids,
} from "../src/grid";
import type { CacheConfig, CalendarInterval } from "../src/types";

// The one rule for calendar grids (architecture §4.1, "When a context
// holds a grid"): a context holds a grid only once a call that needed it
// has succeeded. Every entry point is tried with a call rejected for each
// reason it can be rejected for, each with a descriptor the context has
// never seen, so a grid held too early would show in the count.

/** A descriptor no other case uses: a zone and a minute of the day by number. */
const ZONES = ["Europe/Madrid", "Europe/Rome", "Europe/Vienna", "Europe/Oslo"];
let serial = 0;
function fresh(): CalendarInterval {
  const n = serial++;
  const minute = n % 1440;
  const at = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  return { unit: "day", zone: ZONES[Math.floor(n / 1440)] as string, at };
}

const OUTSIDE = 9_000_000_000_000_000;
let ids = 0;
const t = Date.UTC(2026, 5, 3, 12);
const config = (interval: unknown, extra: object = {}): CacheConfig =>
  ({
    id: `c${ids++}`,
    interval,
    fields: { value: "f64" },
    ...extra,
  }) as CacheConfig;

/** An entry point: where its grids are held, and its calls. */
interface EntryPoint {
  name: string;
  /** The grids the entry point's context holds now. */
  held(): number;
  /** A call that succeeds with the descriptor, holding its grid. */
  succeed(interval: CalendarInterval): void;
  /**
   * Whether a call for a held descriptor checks no zone (the grid entry).
   * Resolving a cache's config checks its zone on every call.
   */
  findsFirst: boolean;
  /** Calls that are rejected, by the reason they are rejected for. */
  rejected: Record<string, (interval: CalendarInterval) => void>;
}

const context = createCalendarGridContext();
const engine = new Engine();
useCalendarGridContext(engine, context);
engine.cache(config({ unit: "month" }, { id: "live" }));
const shared = () => calendarGridInternals().grids;

const entryPoints: EntryPoint[] = [
  {
    name: "Engine.cache",
    findsFirst: false,
    held: () => heldGrids(context),
    succeed: (interval) => void engine.cache(config(interval)),
    rejected: {
      "an invalid interval": (interval) =>
        void engine.cache(config({ ...interval, zone: "No/Zone" })),
      "a null field": (interval) =>
        void engine.cache(config({ ...interval, zone: null })),
      "an offset": (interval) =>
        void engine.cache(config(interval, { alignmentOffset: 5 })),
      "a watermark outside the domain": (interval) =>
        void engine.cache(config(interval, { finalizedUntil: OUTSIDE })),
      "a conflict with the live cache": (interval) =>
        void engine.cache(config(interval, { id: "live" })),
      "another invalid field of the config": (interval) =>
        void engine.cache(config(interval, { gapSplitK: 0 })),
    },
  },
  {
    name: "new CacheState, without an engine",
    findsFirst: false,
    held: shared,
    succeed: (interval) =>
      void new CacheState(resolveCacheConfig(config(interval))),
    rejected: {
      "a watermark outside the domain": (interval) =>
        void new CacheState(
          resolveCacheConfig(config(interval, { finalizedUntil: OUTSIDE })),
        ),
    },
  },
  {
    name: "snapRange",
    findsFirst: true,
    held: shared,
    succeed: (interval) => void snapRange({ start: t, end: t }, interval),
    rejected: {
      "an invalid interval": (interval) =>
        void snapRange({ start: t, end: t }, { ...interval, at: "25:00" }),
      "an offset": (interval) =>
        void snapRange({ start: t, end: t }, interval, 5),
      "an inverted range": (interval) =>
        void snapRange({ start: t, end: t - 1 }, interval),
      "a range that is not numbers": (interval) =>
        void snapRange({ start: Number.NaN, end: t }, interval),
      "a range outside the domain": (interval) =>
        void snapRange({ start: t, end: OUTSIDE }, interval),
    },
  },
  {
    name: "slotStart",
    findsFirst: true,
    held: shared,
    succeed: (interval) => void slotStart(t, interval),
    rejected: {
      "an invalid interval": (interval) =>
        void slotStart(t, { ...interval, unit: "hour" } as never),
      "an offset": (interval) => void slotStart(t, interval, 5),
      "an instant that is not a number": (interval) =>
        void slotStart(Number.NaN, interval),
      "an instant outside the domain": (interval) =>
        void slotStart(OUTSIDE, interval),
    },
  },
  {
    name: "nextSlotStart",
    findsFirst: true,
    held: shared,
    succeed: (interval) => void nextSlotStart(t, interval),
    rejected: {
      "an invalid interval": (interval) =>
        void nextSlotStart(t, { ...interval, weekStart: 3 }),
      "an offset": (interval) => void nextSlotStart(t, interval, 5),
      "an instant that is not a number": (interval) =>
        void nextSlotStart("5" as unknown as number, interval),
      "an instant outside the domain": (interval) =>
        void nextSlotStart(-OUTSIDE, interval),
    },
  },
];

const rejections = entryPoints.flatMap((entry) =>
  Object.entries(entry.rejected).map(([reason, call]) => ({
    name: entry.name,
    reason,
    entry,
    call,
  })),
);

describe("a context holds a grid only once a call that needed it succeeded", () => {
  it.each(rejections)(
    "$name rejected for $reason holds no grid",
    ({ entry, call }) => {
      // A live view's grid, held by a call that succeeded.
      const live = fresh();
      entry.succeed(live);
      const held = entry.held();
      const sharedBefore = shared();
      const contextBefore = heldGrids(context);
      // Many rejected calls, each with a descriptor never seen before:
      // more than the shared context holds, so a grid held by one of them
      // would also push the live one out.
      for (let n = 0; n < 80; n++) {
        const interval = fresh();
        expect(() => call(interval)).toThrow();
      }
      expect(entry.held()).toBe(held);
      // Neither context changed, whichever the entry point uses.
      expect(shared()).toBe(sharedBefore);
      expect(heldGrids(context)).toBe(contextBefore);
      // The live grid is still held: a call for it adds no grid, and where
      // the entry point finds a held grid first, builds no formatter.
      const built = calendarGridInternals().built;
      entry.succeed({ ...live });
      if (entry.findsFirst) expect(calendarGridInternals().built).toBe(built);
      expect(entry.held()).toBe(held);
    },
  );

  it.each(entryPoints)(
    "$name holds exactly one grid for a call that succeeds",
    (entry) => {
      const interval = fresh();
      const held = entry.held();
      entry.succeed(interval);
      // The shared context holds at most 64: count only below that.
      if (held < 64) expect(entry.held()).toBe(held + 1);
      const after = entry.held();
      // The same descriptor again, in a fresh object: the grid it holds.
      entry.succeed({ ...interval });
      expect(entry.held()).toBe(after);
    },
  );

  it("a grid made for a caller that holds nothing is not held", () => {
    const before = shared();
    const interval = fresh();
    const resolved = resolveCacheConfig(config(interval));
    // The fallbacks of code that is handed a config and no grid.
    const grid = gridOf(resolved);
    expect(createCalendarGrid(interval)).not.toBe(grid);
    const start = slotStart(t, { ...interval });
    // slotStart held one grid of its own, for a call that succeeded.
    const afterEntry = shared();
    expect(afterEntry).toBeLessThanOrEqual(Math.min(64, before + 1));
    validateBatch({ timestamps: [start], fields: { value: [1] } }, resolved);
    expect(() =>
      validateBatch(
        { timestamps: [start + 1], fields: { value: [1] } },
        resolved,
      ),
    ).toThrow();
    gridOf(resolveCacheConfig(config(fresh())));
    createCalendarGrid(fresh());
    expect(shared()).toBe(afterEntry);
  });

  it("an order of use that only successful calls move", () => {
    // Fill the shared context, then keep rejecting calls for its oldest
    // grid: a rejected call does not make that grid more recently used.
    const oldest = fresh();
    slotStart(t, oldest);
    for (let n = 0; n < 63; n++) slotStart(t, fresh());
    expect(shared()).toBe(64);
    expect(() => slotStart(Number.NaN, { ...oldest })).toThrow();
    // One more grid: the oldest is the one dropped, although it was just
    // asked for by the rejected call.
    slotStart(t, fresh());
    const built = calendarGridInternals().built;
    slotStart(t, { ...oldest });
    expect(calendarGridInternals().built).toBeGreaterThan(built);
  });
});
