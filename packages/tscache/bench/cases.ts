// What the benchmarks time, ranked by what a chart does most: read the
// screen it shows, take new bars, scroll back through history. Every case
// drives the package's public engine (`tscache/engine`), the one engine all
// three hostings run, so the base and the head of a pull request expose
// the same API to it. A case prepares its state outside the timer and
// returns the operation to time; the operation returns a number derived
// from its result, which the smoke run checks against the data.

import type * as EngineEntry from "../src/entries/engine";
import type { PutBatch, Range } from "../src/types";
import {
  barsIn,
  batchOf,
  candleConfig,
  DAY,
  MINUTE,
  pages,
  type Series,
  series,
} from "./fixtures";
import type { Op } from "./sample";

/** An implementation under test: the `tscache/engine` entry of a revision. */
export type Impl = typeof EngineEntry;

export interface Case {
  name: string;
  /** What the case is, in a few words, for the report. */
  what: string;
  /**
   * The number the operation returns on correct data: the smoke run checks
   * it, so a case cannot quietly stop doing its work.
   */
  expect: number;
  /** Builds the state outside any timer and returns the operation. */
  prepare(impl: Impl): Op;
  /**
   * How calibration slows the head (run.ts, `slowed`): `repeat` runs the
   * operation again rather than waiting, for one that allocates heavily.
   */
  slowdownBy?: "repeat";
}

/** The screen a chart shows: 500 one-minute bars. */
const SCREEN = 500 * MINUTE;

/** A chart's read: the screen and one screen each side (1,500 bars). */
function around(centre: number): Range {
  return { start: centre - 1.5 * SCREEN, end: centre + 1.5 * SCREEN - MINUTE };
}

/** A filled engine: `s` put day by day, authoritative for each day. */
function filled(impl: Impl, s: Series, id: string) {
  const engine = new impl.Engine();
  engine.cache(candleConfig(id));
  for (const { batch, range } of pages(s, 1)) engine.put(id, batch, { range });
  return engine;
}

/** The bars a read returns, and its last close: cheap, and exact. */
function fold(result: {
  timestamps: Float64Array;
  fields: Record<string, unknown>;
}): number {
  const close = result.fields.close as Float64Array;
  return (
    result.timestamps.length +
    (close.length === 0 ? 0 : Math.round(close[close.length - 1] as number))
  );
}

/** The fixtures, built once per process, shared by both revisions. */
let data: { allDay: Series; sessions: Series } | undefined;
function fixtures() {
  data ??= { allDay: series("allDay", 365), sessions: series("sessions", 365) };
  return data;
}

function lastClose(s: Series, range: Range): number {
  const { close } = s.fields;
  let value = 0;
  for (let i = 0; i < s.timestamps.length; i++) {
    const t = s.timestamps[i] as number;
    if (t >= range.start && t <= range.end) value = close[i] as number;
  }
  return Math.round(value);
}

function expectRead(s: Series, range: Range): number {
  const bars = barsIn(s, range);
  return bars + (bars === 0 ? 0 : lastClose(s, range));
}

/** The cases, built lazily: fixtures cost a second or two. */
export function cases(): Case[] {
  const { allDay, sessions } = fixtures();
  const middle = allDay.range.start + 182 * DAY;
  const viewport = around(middle);
  // A sessions read in the middle of the year, crossing a few nights.
  const sessionsView = around(
    sessions.range.start + 182 * DAY + 16 * 60 * MINUTE,
  );
  const page = { start: middle - 5000 * MINUTE + MINUTE, end: middle };
  const pageBatch: PutBatch = batchOf(allDay, page);
  const pageEnd = { start: page.end, end: page.end };
  const tail = allDay.range.end;
  const tailBar = { start: tail, end: tail };
  const tailBatch: PutBatch = batchOf(allDay, tailBar);
  const month = { start: middle - 30 * DAY, end: middle - MINUTE };
  const monthBars = barsIn(allDay, month);

  return [
    {
      name: "read-viewport",
      what: "get 1,500 bars from a year of 24/7 bars",
      expect: expectRead(allDay, viewport),
      prepare(impl) {
        const engine = filled(impl, allDay, "a");
        return () => fold(engine.get("a", viewport));
      },
    },
    {
      name: "read-viewport-sessions",
      what: "get 1,500 minutes across trading sessions (several segments)",
      expect: expectRead(sessions, sessionsView),
      prepare(impl) {
        const engine = filled(impl, sessions, "s");
        return () => fold(engine.get("s", sessionsView));
      },
    },
    {
      name: "read-year",
      what: "get a whole year of 24/7 bars (525,600)",
      expect: expectRead(allDay, allDay.range),
      prepare(impl) {
        const engine = filled(impl, allDay, "a");
        return () => fold(engine.get("a", allDay.range));
      },
    },
    {
      name: "put-page",
      what: "put a 5,000-bar authoritative page over cached history",
      // The put's warnings (none), and the page's last bar read back.
      expect: expectRead(allDay, pageEnd),
      prepare(impl) {
        const engine = filled(impl, allDay, "a");
        return () =>
          engine.put("a", pageBatch, { range: page }).warnings.length +
          fold(engine.get("a", pageEnd));
      },
    },
    {
      name: "put-live-bar",
      what: "put the newest bar again, as a pushed update, and read it back",
      expect: expectRead(allDay, tailBar),
      prepare(impl) {
        const engine = filled(impl, allDay, "a");
        return () =>
          engine.put("a", tailBatch).warnings.length +
          fold(engine.get("a", tailBar));
      },
    },
    {
      name: "append-bars",
      what: "append 32,768 bars one put at a time into an empty cache, as a live feed does",
      expect: 32_768,
      prepare(impl) {
        const bars = Array.from({ length: 32_768 }, (_, i) => {
          const t = allDay.range.start + i * MINUTE;
          return batchOf(allDay, { start: t, end: t });
        });
        return () => {
          const engine = new impl.Engine();
          engine.cache(candleConfig("live"));
          for (const bar of bars) engine.put("live", bar);
          return engine.get("live", {
            start: allDay.range.start,
            end: allDay.range.start + 32_767 * MINUTE,
          }).timestamps.length;
        };
      },
    },
    {
      name: "fill-month",
      what: "put 30 day pages into an empty cache",
      expect: monthBars,
      prepare(impl) {
        const days = pages(allDay, 1).filter(
          ({ range }) => range.start >= month.start && range.end <= month.end,
        );
        return () => {
          const engine = new impl.Engine();
          engine.cache(candleConfig("m"));
          for (const { batch, range } of days)
            engine.put("m", batch, { range });
          return engine.get("m", month, {}).timestamps.length;
        };
      },
    },
    {
      name: "snapshot-roundtrip",
      what: "snapshot a month, encode, decode, hydrate a fresh cache",
      expect: monthBars,
      prepare(impl) {
        const engine = filled(impl, allDay, "a");
        return () => {
          const { snapshot } = engine.get("a", month, { snapshot: true });
          if (snapshot === undefined) throw new Error("no snapshot");
          const decoded = impl.decodeSnapshot(impl.encodeSnapshot(snapshot));
          const fresh = new impl.Engine();
          fresh.cache(candleConfig("a"));
          fresh.hydrate("a", decoded);
          return fresh.get("a", month).timestamps.length;
        };
      },
    },
    {
      name: "read-transfer",
      what: "get 1,500 bars and move them to another realm (structuredClone with transfer)",
      expect: expectRead(allDay, viewport),
      prepare(impl) {
        const engine = filled(impl, allDay, "a");
        return () => {
          const result = engine.get("a", viewport);
          const transfer = [
            result.timestamps.buffer,
            ...Object.values(result.fields).map(
              (f) => (f as Float64Array).buffer,
            ),
          ] as ArrayBuffer[];
          return fold(structuredClone(result, { transfer }));
        };
      },
    },
  ];
}
