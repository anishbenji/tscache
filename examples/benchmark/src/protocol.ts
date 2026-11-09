// The messages between the benchmark page and its tabs, the same-origin
// iframes that stand in for browser tabs (tab.html).

import type { View } from "./workload";

/** The page asks a tab to read these views, one after another. */
export interface RunMessage {
  type: "run";
  views: View[];
}

/** One view, as the tab drew it. */
export interface ViewTiming {
  /** From the read's start to the frame after setData returned. */
  chartMs: number;
  bars: number;
}

export type TabMessage =
  /** The tab's source is open; `setupMs` is how long that took. */
  | { type: "ready"; tab: string; setupMs: number }
  | { type: "done"; tab: string; views: ViewTiming[] }
  | { type: "failed"; tab: string; error: string };
