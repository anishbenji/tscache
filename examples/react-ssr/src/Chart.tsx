// The chart, drawn in the browser only. The server renders its empty
// container; after hydration the chart is created once, in that container,
// and each new answer replaces its data. Lightweight Charts is imported
// then, so it stays out of the bundle that hydrates the page.

import { useEffect, useEffectEvent, useRef } from "react";
import type { GetResult } from "tscache";
import type { CandlePlot } from "./candle-chart";
import { log, message } from "./log";

export function CandleChart({
  result,
  onNearLeftEdge,
}: {
  result: GetResult | undefined;
  onNearLeftEdge: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<CandlePlot>(null);
  const nearLeftEdge = useEffectEvent(onNearLeftEdge);
  // An answer that arrived while the chart was loading is drawn once it is.
  const drawLatest = useEffectEvent((created: CandlePlot) => {
    if (result !== undefined) created.draw(result);
  });
  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    let mounted = true;
    import("./candle-chart").then(
      ({ createCandleChart }) => {
        if (!mounted) return;
        plot.current = createCandleChart(element, () => nearLeftEdge());
        drawLatest(plot.current);
      },
      (error) => log(`could not load the chart: ${message(error)}`),
    );
    return () => {
      mounted = false;
      plot.current?.remove();
      plot.current = null;
    };
  }, []);
  useEffect(() => {
    if (result !== undefined) plot.current?.draw(result);
  }, [result]);
  return <div className="chart" ref={container} />;
}
