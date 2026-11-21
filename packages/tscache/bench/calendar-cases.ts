// Calendar-grid cases (docs/architecture.md §4.1, N124; §2.8, N113): what a
// daily chart of New York sessions costs. A slot start in a zone takes
// offset lookups in the runtime's `Intl`, which the tables of slot starts
// absorb, so each put and read is timed cold (a new engine, no table) and
// warm (the tables filled). A base from before calendar grids cannot run
// them: `needs` says so, and the runner then times the head against a
// second copy of itself, so these cases report and never gate until the
// base has the feature.

import type { CacheConfig, PutBatch, Range } from "../src/types";
import type { Case, Impl } from "./cases";
import { DAY } from "./fixtures";

const ZONE = "America/New_York";
const interval = { unit: "day", zone: ZONE, at: "09:30" } as const;

function config(id: string): CacheConfig {
  return { id, interval, fields: { close: "f64" } };
}

/** Whether an engine takes a calendar interval. */
function calendars(impl: Impl): boolean {
  try {
    new impl.Engine().cache(config("probe"));
    return true;
  } catch {
    return false;
  }
}

const hour = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  hour: "numeric",
  hourCycle: "h23",
});

/**
 * The instant New York's clock reads 09:30 on a UTC date: 13:30 UTC in
 * summer, 14:30 UTC in winter, told apart by the zone's own hour.
 */
function open(day: number): number {
  const summer = day * DAY + 13.5 * 3_600_000;
  // "9" or "09", as the runtime writes it.
  return Number(hour.format(summer)) === 9 ? summer : summer + 3_600_000;
}

const dayOf = (iso: string): number => Date.parse(iso) / DAY;

/** A session open on each day from `first` to `last`, every `step` days. */
function sessions(first: number, last: number, step = 1): PutBatch {
  const timestamps: number[] = [];
  for (let day = first; day <= last; day += step) timestamps.push(open(day));
  return { timestamps, fields: { close: timestamps.map((_, i) => i) } };
}

const spanOf = (batch: PutBatch): Range => ({
  start: batch.timestamps[0] as number,
  end: batch.timestamps[batch.timestamps.length - 1] as number,
});

function engineWith(impl: Impl, batch: PutBatch) {
  const engine = new impl.Engine();
  engine.cache(config("d"));
  engine.put("d", batch);
  return engine;
}

/** A put and a read of the same bars, cold and warm. */
function span(name: string, what: string, batch: PutBatch): Case[] {
  const range = spanOf(batch);
  const n = batch.timestamps.length;
  const common = { expect: n, needs: calendars };
  return [
    {
      ...common,
      name: `calendar-put-${name}-cold`,
      what: `put ${what} of New York daily bars into a new engine (no table of slot starts)`,
      prepare: (impl) => () =>
        engineWith(impl, batch).get("d", range).timestamps.length,
    },
    {
      ...common,
      name: `calendar-put-${name}-warm`,
      what: `put ${what} of New York daily bars again (tables filled)`,
      prepare(impl) {
        const engine = engineWith(impl, batch);
        return () => {
          engine.put("d", batch);
          return n;
        };
      },
    },
    {
      ...common,
      name: `calendar-read-${name}-cold`,
      what: `read ${what} of New York daily bars from a hydrated engine (no table)`,
      prepare(impl) {
        const snapshot = engineWith(impl, batch).snapshot("d", range);
        return () => {
          const engine = new impl.Engine();
          engine.cache(config("d"));
          engine.hydrate("d", snapshot);
          return engine.get("d", range).timestamps.length;
        };
      },
    },
    {
      ...common,
      name: `calendar-read-${name}-warm`,
      what: `read ${what} of New York daily bars (tables filled)`,
      prepare(impl) {
        const engine = engineWith(impl, batch);
        return () => engine.get("d", range).timestamps.length;
      },
    },
  ];
}

/** A snapshot hydrated into a new engine: its anchors' lookups, and its points. */
function hydrated(
  name: string,
  what: string,
  build: (impl: Impl) => { snapshot: ReturnType<Impl["decodeSnapshot"]> },
  expect: number,
): Case {
  return {
    name,
    what,
    expect,
    needs: calendars,
    prepare(impl) {
      const { snapshot } = build(impl);
      return () => {
        const engine = new impl.Engine();
        engine.cache(config("d"));
        return engine.hydrate("d", snapshot).applied.length;
      };
    },
  };
}

/** The coverage ranges of one slot whose charge just fits the lookup budget (N113). */
const LARGEST = 14_562;

export function calendarCases(): Case[] {
  const year = sessions(dayOf("2025-01-01"), dayOf("2025-12-31"));
  const decades = sessions(dayOf("1991-01-01"), dayOf("2025-12-31"));
  // More than the 256 tables an engine holds: about 400 years of days.
  const centuries = sessions(dayOf("2030-01-01"), dayOf("2429-12-31"));
  // One bar in each of 100 blocks of 512 slots: every start is computed alone.
  const sparse = sessions(
    dayOf("2030-01-01"),
    dayOf("2030-01-01") + 99 * 512,
    512,
  );
  // Page 0 of a daily cache with the default slot cap: 1970 to 2059.
  const page = sessions(0, 32_767);
  return [
    ...span("year", "a year", year),
    ...span("35-years", "35 years", decades),
    {
      name: "calendar-read-beyond-tables",
      what: "read 400 years of New York daily bars, more blocks than the tables an engine holds",
      expect: centuries.timestamps.length,
      needs: calendars,
      prepare(impl) {
        const engine = engineWith(impl, centuries);
        const range = spanOf(centuries);
        return () => engine.get("d", range).timestamps.length;
      },
    },
    {
      name: "calendar-read-sparse",
      what: "read one bar in each of 100 blocks: starts computed alone (the fill rule)",
      expect: sparse.timestamps.length,
      needs: calendars,
      prepare(impl) {
        const engine = engineWith(impl, sparse);
        const range = spanOf(sparse);
        return () => engine.get("d", range).timestamps.length;
      },
    },
    hydrated(
      "calendar-hydrate-page",
      "hydrate a full daily page of bars (32,768) into a new engine: anchors only",
      (impl) => ({
        snapshot: engineWith(impl, page).snapshot("d", spanOf(page)),
      }),
      1,
    ),
    hydrated(
      "calendar-hydrate-largest",
      `hydrate the largest record within the lookup budget: ${LARGEST} coverage ranges of one slot`,
      (impl) => {
        const engine = new impl.Engine();
        engine.cache(config("d"));
        // All inside one page (slots 32,768 to 65,535), so one payload.
        const first = 32_768;
        const last = first + 2 * (LARGEST - 1);
        // A watermark past the last range, as the largest charge counts one.
        engine.setFinalizedUntil("d", open(last + 1));
        for (let day = first; day <= last; day += 2) {
          const t = open(day);
          engine.put("d", { timestamps: [t], fields: { close: [1] } });
        }
        const range = { start: open(first), end: open(last) };
        return { snapshot: engine.snapshot("d", range) };
      },
      LARGEST,
    ),
  ];
}
