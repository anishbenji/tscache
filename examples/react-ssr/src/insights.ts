// The tab's insights into its reads: where the drawn bars came from, and
// their time to chart (@examples/mock-backend/read-insights). A module-level
// store like the log. The server renders the placeholders, which the
// browser's hydration render repeats; it never reads through the
// instrumented cache, so it opens no channel.

import {
  createInsights,
  type InsightsState,
  insightLines,
} from "@examples/mock-backend/read-insights";
import { useSyncExternalStore } from "react";
import "@examples/mock-backend/insights.css";

export const insights = createInsights();

const BEFORE_HYDRATION: InsightsState = { last: undefined, spread: undefined };

export function useInsightLines(): ReturnType<typeof insightLines> {
  return insightLines(
    useSyncExternalStore(
      insights.subscribe,
      () => insights.state,
      () => BEFORE_HYDRATION,
    ),
  );
}
