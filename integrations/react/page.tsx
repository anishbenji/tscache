// The page, the same component tree on the server and in the browser, so
// the browser's hydration render reproduces the server's markup: one chart
// inside a Suspense boundary, for its first answer, and an error boundary,
// for a connection or a read that failed.

import { Component, type ReactNode, Suspense, useState } from "react";
import type { Range } from "tscache";
import { candles, DAY, describe } from "../shared/candles";
import { useSeries } from "./series";

/** The id of the element the page renders into. */
export const ROOT = "root";

function Chart({ range }: { range: Range }) {
  const result = useSeries(candles, range);
  // A chart library would take result.timestamps and result.fields here.
  return <p>{describe(result)}</p>;
}

/** Most apps have their own boundary (react-error-boundary, say) with a retry. */
class ChartFailed extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) return <p>The chart could not load.</p>;
    return this.props.children;
  }
}

const earlier = ({ start, end }: Range): Range => ({
  start: start - 90 * DAY,
  end: end - 90 * DAY,
});

/** The page, its chart showing `range` first. */
export function Page(props: { range: Range }) {
  const [range, setRange] = useState(props.range);
  // Scrolling a chart sets its visible range the same way. No transition is
  // needed: useSeries keeps the current answer until the next one is ready.
  return (
    <>
      <ChartFailed>
        <Suspense fallback={<p>Loading the chart…</p>}>
          <Chart range={range} />
        </Suspense>
      </ChartFailed>
      <button type="button" onClick={() => setRange(earlier)}>
        90 days earlier
      </button>
    </>
  );
}
