// This tab's insights into its reads: where the drawn bars came from, and
// their time to chart (@examples/mock-backend/read-insights). One for the
// page's life, outside React like the log; components read it with
// useSyncExternalStore.

import {
  createInsights,
  insightLines,
} from "@examples/mock-backend/read-insights";
import { useSyncExternalStore } from "react";
import "@examples/mock-backend/insights.css";

export const insights = createInsights();

/** The panel's three lines, current. */
export function useInsightLines(): ReturnType<typeof insightLines> {
  const state = useSyncExternalStore(insights.subscribe, () => insights.state);
  return insightLines(state);
}
