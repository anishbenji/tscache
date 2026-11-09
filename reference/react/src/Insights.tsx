// The insights panel: where the drawn bars came from, and their time to
// chart. The page's insights are an external store, read with
// useSyncExternalStore like the session's state; the server, which has no
// session, renders the placeholders the browser's hydration render matches.

import {
  type InsightsState,
  insightLines,
  type Insights as PageInsights,
} from "@examples/mock-backend/read-insights";
import { useSyncExternalStore } from "react";

const NOTHING_DRAWN: InsightsState = { last: undefined, spread: undefined };
const subscribeToNothing = () => () => {};

export function Insights({ insights }: { insights: PageInsights | undefined }) {
  const state = useSyncExternalStore(
    insights?.subscribe ?? subscribeToNothing,
    () => insights?.state ?? NOTHING_DRAWN,
    () => NOTHING_DRAWN,
  );
  const { source, timing, spread } = insightLines(state);
  return (
    <p className="insights" data-testid="insights">
      <output data-testid="provenance">{source}</output>
      <br />
      <output data-testid="time-to-chart">{timing}</output> ·{" "}
      <output data-testid="chart-spread">{spread}</output>
    </p>
  );
}
