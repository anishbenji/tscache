// Answers of one-minute bars for the chart tests.

import type { GetResult } from "tscache";

export const MINUTE = 60_000;
export const T0 = Date.UTC(2026, 9, 30, 12, 0);

/** A bar's open, high, low and close, and its volume (100 + its index if absent). */
export type Bar = [
  open: number,
  high: number,
  low: number,
  close: number,
  volume?: number,
];

/** An answer of one-minute bars from T0 + `first` minutes on. */
export function answer(bars: readonly Bar[], first = 0): GetResult {
  const column = (k: number) => Float64Array.from(bars, (bar) => bar[k] ?? 0);
  return {
    timestamps: Float64Array.from(bars, (_, i) => T0 + (first + i) * MINUTE),
    fields: {
      open: column(0),
      high: column(1),
      low: column(2),
      close: column(3),
      volume: Float64Array.from(bars, (bar, i) => bar[4] ?? 100 + i),
    },
    coverage: [],
    misses: [],
  };
}

export const HISTORY: Bar[] = [
  [10, 12, 9, 11],
  [11, 13, 10, 12],
  [12, 14, 11, 13],
  [13, 15, 12, 14],
];
