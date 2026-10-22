// Daily ACME candles: the cache config the server and the browser share, and
// the figures the page shows of a cache answer. Pure functions, so the
// server and the browser compute the same figures from the same answer.

import { datasets } from "@examples/mock-backend/datasets";
import type { CacheConfig, FieldArray, GetResult, Range } from "tscache";

const DAY = 86_400_000;
/** The window the page opens on, and each step of scroll-back. */
export const HALF_YEAR = 182 * DAY;

export const candles: CacheConfig = {
  id: "candles/ACME/1d",
  interval: DAY,
  fields: datasets.candles.fields,
};

/** One session's bar. */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /**
   * Outside coverage: the backend's watermark keeps today's bar provisional,
   * so every get fetches it again.
   */
  forming: boolean;
}

/** What the page shows of one cache answer. */
export interface Summary {
  bars: number;
  /** From the first bar's open to the last bar's close; null without bars. */
  change: number | null;
  /** Covered days without a bar: weekends (on a real exchange, holidays too). */
  knownEmpty: number;
  /** The last five bars, newest first. */
  latest: Bar[];
}

type Columns = Record<"open" | "high" | "low" | "close" | "volume", FieldArray>;

/** The answer's columns; a cache answers with every field of its config. */
export function columnsOf(result: GetResult): Columns {
  return result.fields as Columns;
}

export function valueAt(column: FieldArray, i: number): number {
  return column[i] ?? Number.NaN;
}

function isCovered(t: number, coverage: Range[]): boolean {
  return coverage.some(({ start, end }) => t >= start && t <= end);
}

/** Bars inside the answer's coverage: the final ones, not a forming one. */
export function coveredBars({ timestamps, coverage }: GetResult): number {
  let bars = 0;
  let i = 0;
  for (const { start, end } of coverage) {
    while (i < timestamps.length && (timestamps[i] as number) < start) i++;
    for (; i < timestamps.length && (timestamps[i] as number) <= end; i++) {
      bars++;
    }
  }
  return bars;
}

export function summarize(result: GetResult): Summary {
  const { timestamps, coverage } = result;
  const { open, high, low, close, volume } = columnsOf(result);
  const count = timestamps.length;
  const latest: Bar[] = [];
  for (let i = count - 1; i >= Math.max(0, count - 5); i--) {
    const time = timestamps[i] as number;
    latest.push({
      time,
      open: valueAt(open, i),
      high: valueAt(high, i),
      low: valueAt(low, i),
      close: valueAt(close, i),
      volume: valueAt(volume, i),
      forming: !isCovered(time, coverage),
    });
  }
  const coveredDays = coverage.reduce(
    (days, { start, end }) => days + (end - start) / DAY + 1,
    0,
  );
  return {
    bars: count,
    change:
      count === 0 ? null : valueAt(close, count - 1) / valueAt(open, 0) - 1,
    knownEmpty: coveredDays - coveredBars(result),
    latest,
  };
}

/** A timestamp's day in UTC, as the page writes it: the same on every machine. */
export function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}
