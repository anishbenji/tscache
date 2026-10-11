// Lightweight Charts v5: candles in the main pane, volume in a pane of its
// own below. The chart is created once; each answer of the cache replaces
// the data.

import {
  type CandlestickData,
  CandlestickSeries,
  createChart,
  type HistogramData,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { FieldArray, GetResult } from "tscache";

const UP = "#2a78d6";
const DOWN = "#eb6834";

interface Plot {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
}

interface Bars {
  candles: CandlestickData<UTCTimestamp>[];
  volume: HistogramData<UTCTimestamp>[];
}

function toBars(result: GetResult): Bars {
  const { open, high, low, close, volume } = result.fields;
  const at = (column: FieldArray | undefined, i: number) =>
    column?.[i] ?? Number.NaN;
  const bars: Bars = { candles: [], volume: [] };
  result.timestamps.forEach((t, i) => {
    const time = (t / 1000) as UTCTimestamp;
    const candle = {
      time,
      open: at(open, i),
      high: at(high, i),
      low: at(low, i),
      close: at(close, i),
    };
    const color = candle.close >= candle.open ? UP : DOWN;
    bars.candles.push(candle);
    bars.volume.push({ time, value: at(volume, i), color });
  });
  return bars;
}

function create(container: HTMLElement): Plot {
  const chart = createChart(container, {
    autoSize: true,
    layout: { textColor: "#52514e", panes: { separatorColor: "#e4e4e0" } },
    grid: {
      vertLines: { color: "#f0f0ec" },
      horzLines: { color: "#f0f0ec" },
    },
    timeScale: { timeVisible: true, secondsVisible: false },
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
  return { chart, candles, volume };
}

export function CandleChart({ result }: { result: GetResult | undefined }) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<Plot>(null);
  const fitted = useRef(false);
  useEffect(() => {
    if (container.current === null) return;
    const created = create(container.current);
    plot.current = created;
    return () => {
      plot.current = null;
      created.chart.remove();
    };
  }, []);
  useEffect(() => {
    if (result === undefined || plot.current === null) return;
    const { chart, candles, volume } = plot.current;
    const bars = toBars(result);
    candles.setData(bars.candles);
    volume.setData(bars.volume);
    if (!fitted.current && bars.candles.length > 0) {
      chart.timeScale().fitContent();
      fitted.current = true;
    }
  }, [result]);
  return <div className="chart" ref={container} />;
}
