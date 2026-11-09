// The benchmark's one workload, the same for every mode: a chart of
// one-minute candles opens on the newest screen, scrolls back five
// screens, zooms out to four screens and back in, and returns to the
// newest screen. Then the market moves on by a few bars, and three tabs do
// the same at once: the first tab again and two new ones.
//
// Every range is computed here from one anchor, so every mode asks for the
// same ranges in the same order. The anchor is a minute of yesterday (UTC)
// that the benchmark page fixes once for all its runs: the data before it
// is final, a pure function of the series and the timestamp, so every mode
// reads the same bars and the counts do not depend on when the run started
// or how long it took. The bars after the anchor that phase two adds are
// final history too, standing in for the bars a live market adds.

import type { CacheConfig, Range } from "@anishbenji/tscache";
import { datasets } from "@examples/mock-backend/datasets";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** One-minute bars of a market that trades around the clock. */
export const INTERVAL = MINUTE;
/** The series every mode reads: the mock backend's `crypto` dataset. */
export const SERIES = "crypto/BENCH";
/** Bars on one screen. */
export const SCREEN = 240;
/** How far phase two's market has moved on: the newest bars. */
export const NEW_BARS = 5;
/** The tabs of phase two. */
export const TABS = 3;

export const MODES = ["none", "memo", "tanstack", "tscache"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABELS: Record<Mode, string> = {
  none: "No cache",
  memo: "Per-tab memo",
  tanstack: "TanStack Query",
  tscache: "tscache",
};

export function isMode(value: unknown): value is Mode {
  return (MODES as readonly unknown[]).includes(value);
}

type Step = "load" | "scroll back" | "zoom out" | "zoom in" | "return";

export interface View {
  step: Step;
  range: Range;
}

/** The anchor for a page opened at `now`: yesterday at 12:00 UTC. */
export function anchorFor(now: number): number {
  return Math.floor(now / DAY) * DAY - DAY / 2;
}

/** Screen `k` back from `end`: SCREEN bars, the newest at `end - k` screens. */
function screen(end: number, k: number): Range {
  const last = end - k * SCREEN * INTERVAL;
  return { start: last - (SCREEN - 1) * INTERVAL, end: last };
}

/** The views of one tab's workload, newest screen ending at `end`. */
export function views(end: number): View[] {
  const back = screen(end, 5);
  const margin = (3 * SCREEN * INTERVAL) / 2;
  return [
    { step: "load", range: screen(end, 0) },
    ...[1, 2, 3, 4, 5].map((k) => ({
      step: "scroll back" as const,
      range: screen(end, k),
    })),
    {
      step: "zoom out",
      range: { start: back.start - margin, end: back.end + margin },
    },
    { step: "zoom in", range: back },
    { step: "return", range: screen(end, 0) },
  ];
}

/** Phase one's views (one tab) and phase two's (each of TABS tabs). */
export function workload(anchor: number): { one: View[]; three: View[] } {
  return {
    one: views(anchor),
    three: views(anchor + NEW_BARS * INTERVAL),
  };
}

/** The tscache config of a run: a fresh cache id, so a run starts empty. */
export function cacheConfig(run: string): CacheConfig {
  return {
    id: `${SERIES}/${run}`,
    interval: INTERVAL,
    fields: datasets.crypto.fields,
  };
}
