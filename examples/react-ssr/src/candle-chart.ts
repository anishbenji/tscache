// Lightweight Charts v5: candles in the main pane, volume in a pane of its
// own below. Bars are placed by index, so weekends take no room on the time
// axis.

import {
  type CandlestickData,
  CandlestickSeries,
  createChart,
  type HistogramData,
  HistogramSeries,
  type UTCTimestamp,
} from "lightweight-charts";
import type { GetResult } from "tscache";
import { columnsOf, valueAt } from "./candles";

export interface CandlePlot {
  /**
   * Draws a cache answer. Bars prepended to the ones drawn before shift the
   * view by as many bars, so what was in view stays in view.
   */
  draw(result: GetResult): void;
  remove(): void;
}

const UP = "#2a78d6";
const DOWN = "#eb6834";

/** Bars from the left edge of the view at which more history is wanted. */
const NEAR_LEFT_EDGE = 10;

function series(result: GetResult) {
  const { open, high, low, close, volume } = columnsOf(result);
  const candles: CandlestickData<UTCTimestamp>[] = [];
  const volumes: HistogramData<UTCTimestamp>[] = [];
  for (const [i, t] of result.timestamps.entries()) {
    const time = (t / 1000) as UTCTimestamp;
    const candle = {
      time,
      open: valueAt(open, i),
      high: valueAt(high, i),
      low: valueAt(low, i),
      close: valueAt(close, i),
    };
    candles.push(candle);
    const color = candle.close >= candle.open ? UP : DOWN;
    volumes.push({ time, value: valueAt(volume, i), color });
  }
  return { candles, volumes };
}

export function createCandleChart(
  container: HTMLElement,
  onNearLeftEdge: () => void,
): CandlePlot {
  const chart = createChart(container, {
    autoSize: true,
    layout: { textColor: "#52514e", panes: { separatorColor: "#e4e4e0" } },
    grid: {
      vertLines: { color: "#f0f0ec" },
      horzLines: { color: "#f0f0ec" },
    },
    timeScale: { barSpacing: 10 },
  });
  const candles = chart.addSeries(CandlestickSeries, {
    upColor: UP,
    downColor: DOWN,
    wickUpColor: UP,
    wickDownColor: DOWN,
    borderVisible: false,
  });
  const volume = chart.addSeries(
    HistogramSeries,
    { priceFormat: { type: "volume" }, priceLineVisible: false },
    1,
  );
  chart.panes()[1]?.setStretchFactor(0.3);
  const timeScale = chart.timeScale();
  timeScale.subscribeVisibleLogicalRangeChange((range) => {
    if (range !== null && range.from < NEAR_LEFT_EDGE) onNearLeftEdge();
  });

  let firstDrawn: number | undefined;
  return {
    draw(result) {
      const { timestamps } = result;
      let prepended = 0;
      const drawnFrom = firstDrawn ?? Number.NEGATIVE_INFINITY;
      while (
        prepended < timestamps.length &&
        (timestamps[prepended] as number) < drawnFrom
      ) {
        prepended++;
      }
      const view = timeScale.getVisibleLogicalRange();
      const { candles: bars, volumes } = series(result);
      candles.setData(bars);
      volume.setData(volumes);
      if (view !== null && prepended > 0) {
        timeScale.setVisibleLogicalRange({
          from: view.from + prepended,
          to: view.to + prepended,
        });
      }
      firstDrawn = timestamps[0];
    },
    remove: () => chart.remove(),
  };
}
