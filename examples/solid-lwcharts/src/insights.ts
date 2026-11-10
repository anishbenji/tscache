// The page's insights into its reads: where the drawn bars came from, and
// their time to chart (@examples/mock-backend/read-insights). A module-scope
// store, as the fetch count and the log are (session.ts): what feeds it
// arrives outside any component.

import {
  createInsights,
  insightLines,
} from "@examples/mock-backend/read-insights";
import { createSignal } from "solid-js";
import "@examples/mock-backend/insights.css";

/** The page's reads: the cache is instrumented with it, each draw reported. */
export const insights = createInsights();

/** The insights panel's lines, a signal each change replaces. */
const [insight, setInsight] = createSignal(insightLines(insights.state));
insights.subscribe(() => setInsight(insightLines(insights.state)));

export { insight };
