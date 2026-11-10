// The messages between the benchmark page and its tabs, the same-origin
// iframes that stand in for browser tabs (tab.html).

import type { View } from "./workload";

/**
 * The page asks a tab to read these views, one after another, or to
 * dispose of its source before the page removes it.
 */
export type PageMessage = { type: "run"; views: View[] } | { type: "dispose" };

/** One view, as the tab drew it. */
export interface ViewTiming {
  /** From the read's start to the frame after setData returned. */
  chartMs: number;
  bars: number;
  /** When the read began and answered, on the fetch reports' time line. */
  askedAt: number;
  answeredAt: number;
}

export type TabMessage =
  /** The tab's source is open; `setupMs` is how long that took. */
  | { type: "ready"; tab: string; setupMs: number }
  | { type: "done"; tab: string; views: ViewTiming[] }
  /** The tab's source is disposed: its client closed, its cache cleared. */
  | { type: "disposed"; tab: string }
  | { type: "failed"; tab: string; error: string };
