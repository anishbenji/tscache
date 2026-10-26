// The data the benchmarks and the performance budgets run on: one-minute
// OHLCV candles, as a chart reads them (the primary use, N11). Seeded, so
// every run and every machine builds the same points; built once, outside
// any timer.
//
// Shapes:
//   sessions  weekday trading sessions, 13:30–20:00 UTC (390 bars a day);
//             nights and weekends are confirmed gaps, so a year of it is
//             about 260 segments
//   allDay    every minute of every day, as a market that never closes
//   dropout   allDay with about 2 % of bars missing and a 15-minute outage
//             every six hours, as a feed that drops points

import type { CacheConfig, PutBatch, Range } from "../src/types";

export const MINUTE = 60_000;
export const DAY: number = 1440 * MINUTE;
/** A Monday, so a sessions series starts on a trading day. */
const START: number = Date.UTC(2025, 0, 6);

export const FIELDS = {
  open: "f64",
  high: "f64",
  low: "f64",
  close: "f64",
  volume: "u32",
} as const;

export type Shape = "sessions" | "allDay" | "dropout";

export function candleConfig(id: string): CacheConfig {
  return { id, interval: MINUTE, fields: FIELDS };
}

/** The bars of one series: aligned, ascending, one column per field. */
export interface Series {
  readonly shape: Shape;
  readonly days: number;
  readonly timestamps: Float64Array;
  readonly fields: {
    readonly open: Float64Array;
    readonly high: Float64Array;
    readonly low: Float64Array;
    readonly close: Float64Array;
    readonly volume: Uint32Array;
  };
  /** From the first day's start to the last day's last minute. */
  readonly range: Range;
}

/** mulberry32: small, seeded, the same sequence in every engine. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SESSION_OPEN = (13 * 60 + 30) * MINUTE;
const SESSION_CLOSE = 20 * 60 * MINUTE;

/** Whether `shape` has a bar at minute `t` (`next` draws the dropouts). */
function present(shape: Shape, t: number, next: () => number): boolean {
  if (shape === "allDay") return true;
  const inDay = t % DAY;
  if (shape === "sessions") {
    const weekday = new Date(t).getUTCDay();
    return (
      weekday >= 1 &&
      weekday <= 5 &&
      inDay >= SESSION_OPEN &&
      inDay < SESSION_CLOSE
    );
  }
  // dropout: a 15-minute outage every six hours, and 2 % of single bars.
  if (inDay % (360 * MINUTE) < 15 * MINUTE) return false;
  return next() >= 0.02;
}

/** `days` days of `shape`, from START. */
export function series(shape: Shape, days: number, seed = 1): Series {
  const next = random(seed);
  const times: number[] = [];
  for (let t = START; t < START + days * DAY; t += MINUTE) {
    if (present(shape, t, next)) times.push(t);
  }
  const n = times.length;
  const open = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  const volume = new Uint32Array(n);
  let price = 100;
  for (let i = 0; i < n; i++) {
    const move = (next() - 0.5) * 0.4;
    open[i] = price;
    price = Math.max(1, price + move);
    close[i] = price;
    high[i] = Math.max(open[i] as number, price) + next() * 0.1;
    low[i] = Math.min(open[i] as number, price) - next() * 0.1;
    volume[i] = Math.floor(next() * 10_000);
  }
  return {
    shape,
    days,
    timestamps: Float64Array.from(times),
    fields: { open, high, low, close, volume },
    range: { start: START, end: START + days * DAY - MINUTE },
  };
}

/** The series' bars inside `range`, as one put batch. */
export function batchOf(s: Series, range: Range): PutBatch {
  const { timestamps } = s;
  let from = 0;
  while (
    from < timestamps.length &&
    (timestamps[from] as number) < range.start
  ) {
    from++;
  }
  let to = from;
  while (to < timestamps.length && (timestamps[to] as number) <= range.end) {
    to++;
  }
  const fields: Record<string, ArrayBufferView> = {};
  for (const [name, column] of Object.entries(s.fields)) {
    fields[name] = column.subarray(from, to);
  }
  return { timestamps: timestamps.subarray(from, to), fields };
}

/**
 * The series as the backend pages it: one authoritative page per `days`
 * days, newest first, as a chart scrolling back asks for them.
 */
export function pages(
  s: Series,
  days: number,
): { batch: PutBatch; range: Range }[] {
  const out: { batch: PutBatch; range: Range }[] = [];
  for (let end = s.range.end; end >= s.range.start; end -= days * DAY) {
    const range = {
      start: Math.max(s.range.start, end - days * DAY + MINUTE),
      end,
    };
    out.push({ batch: batchOf(s, range), range });
  }
  return out;
}

/** The number of bars of `s` inside `range`. */
export function barsIn(s: Series, range: Range): number {
  let n = 0;
  for (const t of s.timestamps) if (t >= range.start && t <= range.end) n++;
  return n;
}
