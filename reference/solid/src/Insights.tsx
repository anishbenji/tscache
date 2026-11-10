// The insights panel: where the drawn bars came from, and their time to
// chart. Like the session's state, the page's insights reach Solid through
// one signal, taken once the page has settled, so the hydration render
// matches the server's placeholders; on the server nothing settles.

import {
  type InsightsState,
  insightLines,
  type Insights as PageInsights,
} from "@examples/mock-backend/read-insights";
import { createMemo, createSignal, onSettled } from "solid-js";

export function Insights(props: { insights: PageInsights | undefined }) {
  const [state, setState] = createSignal<InsightsState>({
    last: undefined,
    spread: undefined,
  });
  onSettled(() => {
    const { insights } = props;
    if (insights === undefined) return;
    const take = () => setState(insights.state);
    take();
    return insights.subscribe(take);
  });
  const lines = createMemo(() => insightLines(state()));
  return (
    <p class="insights" data-testid="insights">
      <output data-testid="provenance">{lines().source}</output>
      <br />
      <output data-testid="time-to-chart">{lines().timing}</output> ·{" "}
      <output data-testid="chart-spread">{lines().spread}</output>
    </p>
  );
}
