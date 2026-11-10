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
  memo: "Per-tab memo (exact range)",
  tanstack: "TanStack Query (exact-range keys, per tab)",
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

/** Phase one's and phase two's request counts, and their sum. */
export interface Requests {
  one: number;
  three: number;
  total: number;
}

/**
 * The requests a cache keyed by exact range makes on `plan`, in one tab and
 * then in TABS tabs: per tab, as the memo and TanStack Query here, or one
 * cache shared by every tab that joins a range already in flight. Counted,
 * not measured: the shared cache is a counterfactual that no mode runs, so
 * the results can say how much of tscache's saving sharing alone explains.
 */
export function exactKeyRequests(
  plan: { one: View[]; three: View[] },
  sharing: "per tab" | "shared",
): Requests {
  const key = ({ range }: View) => `${range.start}:${range.end}`;
  const seen = (cache: Set<string>, tabViews: View[]) => {
    let made = 0;
    for (const view of tabViews) {
      if (!cache.has(key(view))) made++;
      cache.add(key(view));
    }
    return made;
  };
  const first = new Set<string>();
  const one = seen(first, plan.one);
  // Tab one keeps its cache in phase two. Per tab, the other tabs start
  // empty; shared, they join what tab one fetches.
  let three = seen(first, plan.three);
  if (sharing === "per tab") {
    for (let tab = 1; tab < TABS; tab++) three += seen(new Set(), plan.three);
  }
  return { one, three, total: one + three };
}

/**
 * The cache id a tab's fetches are reported under: the run's tscache cache,
 * which every tab of the run shares, or for the other modes one per tab, as
 * their caches are. The fetcher reads the series from the first two
 * segments and ignores the rest.
 */
export function sourceCacheId(mode: Mode, run: string, tab: string): string {
  return mode === "tscache" ? cacheConfig(run).id : `${SERIES}/${tab}`;
}

/** The tscache config of a run: a fresh cache id, so a run starts empty. */
export function cacheConfig(run: string): CacheConfig {
  return {
    id: `${SERIES}/${run}`,
    interval: INTERVAL,
    fields: datasets.crypto.fields,
  };
}
