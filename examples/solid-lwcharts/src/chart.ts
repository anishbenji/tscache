// A Lightweight Charts candlestick chart with a volume histogram. It draws
// bars by index: the nights and weekends without bars take no room on the
// time axis.

import {
  type CandlestickData,
  CandlestickSeries,
  createChart,
  type HistogramData,
  HistogramSeries,
  type UTCTimestamp,
} from "lightweight-charts";
import type { GetResult } from "tscache";

export interface CandleChart {
  /**
   * Draws a cache answer. Bars prepended to the ones drawn before shift the
   * view by as many bars, so what was in view stays in view.
   */
  draw(result: GetResult): void;
  remove(): void;
}

const UP = "#15803d";
const DOWN = "#b91c1c";
const UP_VOLUME = "rgba(21, 128, 61, 0.35)";
const DOWN_VOLUME = "rgba(185, 28, 28, 0.35)";

/** Bars from the left edge of the view at which more history is wanted. */
const NEAR_LEFT_EDGE = 10;

type Column = GetResult["fields"][string];

function series(result: GetResult) {
  const bars: CandlestickData<UTCTimestamp>[] = [];
  const volumes: HistogramData<UTCTimestamp>[] = [];
  const { open, high, low, close, volume } = result.fields;
  if (!open || !high || !low || !close || !volume) return { bars, volumes };
  const at = (column: Column, i: number) => column[i] ?? Number.NaN;
  for (const [i, t] of result.timestamps.entries()) {
    const time = (t / 1000) as UTCTimestamp;
    const bar = {
      time,
      open: at(open, i),
      high: at(high, i),
      low: at(low, i),
      close: at(close, i),
    };
    bars.push(bar);
    const color = bar.close >= bar.open ? UP_VOLUME : DOWN_VOLUME;
    volumes.push({ time, value: at(volume, i), color });
  }
  return { bars, volumes };
}

export function createCandleChart(
  container: HTMLElement,
  onNearLeftEdge: () => void,
): CandleChart {
  const chart = createChart(container, {
    autoSize: true,
    layout: { textColor: "#1d2433", fontFamily: "system-ui, sans-serif" },
    grid: {
      vertLines: { color: "#eef0f4" },
      horzLines: { color: "#eef0f4" },
    },
    rightPriceScale: { scaleMargins: { top: 0.06, bottom: 0.28 } },
    timeScale: { timeVisible: true, barSpacing: 10 },
  });
  const candles = chart.addSeries(CandlestickSeries, {
    upColor: UP,
    downColor: DOWN,
    wickUpColor: UP,
    wickDownColor: DOWN,
    borderVisible: false,
  });
  const volume = chart.addSeries(HistogramSeries, {
    priceFormat: { type: "volume" },
    priceScaleId: "volume",
  });
  chart.priceScale("volume").applyOptions({
    scaleMargins: { top: 0.78, bottom: 0 },
  });
  const timeScale = chart.timeScale();
  timeScale.subscribeVisibleLogicalRangeChange((range) => {
    if (range !== null && range.from < NEAR_LEFT_EDGE) onNearLeftEdge();
  });

  let firstBar: number | undefined;
  return {
    draw(result) {
      const view = timeScale.getVisibleLogicalRange();
      const drawnFrom = firstBar;
      const prepended =
        drawnFrom === undefined
          ? 0
          : result.timestamps.filter((t) => t < drawnFrom).length;
      const { bars, volumes } = series(result);
      candles.setData(bars);
      volume.setData(volumes);
      if (view !== null && prepended > 0) {
        timeScale.setVisibleLogicalRange({
          from: view.from + prepended,
          to: view.to + prepended,
        });
      }
      firstBar = result.timestamps[0];
    },
    remove: () => chart.remove(),
  };
}
