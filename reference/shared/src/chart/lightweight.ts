// The candle chart on Lightweight Charts v5: candles in the main pane,
// volume in a pane of its own below.
//
// Lightweight Charts places bars by index (its "logical" range), not by
// time, so bars loaded to the left of the view would push it right. Each
// draw notes the time on screen and restores it on the new bars, and a
// scroll is reported as times, past the first or last bar included: the
// range beyond the bars is what the cache is asked to load.
//
// The chart also changes its range by itself, after a draw or a resize,
// and tells no difference; so a change counts as a scroll only while the
// user is working the chart (and for a moment after, while a flick
// coasts).

import {
  type CandlestickData,
  CandlestickSeries,
  createChart,
  type HistogramData,
  HistogramSeries,
  type LogicalRange,
  type UTCTimestamp,
} from "lightweight-charts";
import type { GetResult, Range } from "tscache";
import { type ChartOptions, type ChartView, keptRange, moved } from "./view";

const UP = "#2a78d6";
const DOWN = "#eb6834";

/** How long after the user's last input a range change is still theirs. */
const USER_MS = 1000;

/** Lightweight Charts takes times in seconds. */
const seconds = (t: number) => (t / 1000) as UTCTimestamp;

interface Bars {
  bars: CandlestickData<UTCTimestamp>[];
  volumes: HistogramData<UTCTimestamp>[];
}

/** The answer as the chart's bars, one object per bar, as it requires. */
function toBars({ timestamps, fields }: GetResult): Bars | undefined {
  const { open, high, low, close, volume } = fields;
  if (!open || !high || !low || !close || !volume) return undefined;
  const out: Bars = { bars: [], volumes: [] };
  timestamps.forEach((t, i) => {
    const time = seconds(t);
    const o = open[i] ?? Number.NaN;
    const c = close[i] ?? Number.NaN;
    const h = high[i] ?? o;
    const l = low[i] ?? o;
    out.bars.push({ time, open: o, high: h, low: l, close: c });
    out.volumes.push({
      time,
      value: volume[i] ?? 0,
      color: c >= o ? UP : DOWN,
    });
  });
  return out;
}

export function createLightweightChart(
  element: HTMLElement,
  { interval, opening }: ChartOptions,
): ChartView {
  const chart = createChart(element, {
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
  chart.panes()[1]?.setStretchFactor(0.25);
  const scale = chart.timeScale();

  /** The timestamps of the bars drawn, in ms. */
  let times: ArrayLike<number> & { at(i: number): number | undefined } =
    new Float64Array(0);
  /** The range on screen as last drawn or reported. */
  let shown: Range | undefined;
  const listeners = new Set<(visible: Range) => void>();

  /** The time at a logical index, extrapolated past either end. */
  function timeAt(logical: number): number {
    const last = times.length - 1;
    const first = times[0] ?? 0;
    if (logical <= 0) return first + logical * interval;
    if (logical >= last)
      return (times[last] ?? 0) + (logical - last) * interval;
    const i = Math.floor(logical);
    const t = times[i] ?? 0;
    return t + (logical - i) * ((times[i + 1] ?? t) - t);
  }

  /** The logical index of a time: the inverse of timeAt. */
  function logicalAt(t: number): number {
    const last = times.length - 1;
    const first = times[0] ?? 0;
    if (t <= first) return (t - first) / interval;
    if (t >= (times[last] ?? 0))
      return last + (t - (times[last] ?? 0)) / interval;
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((times[mid] ?? 0) <= t) lo = mid;
      else hi = mid;
    }
    const a = times[lo] ?? 0;
    const b = times[hi] ?? a;
    return lo + (b === a ? 0 : (t - a) / (b - a));
  }

  function toRange({ from, to }: LogicalRange): Range {
    return { start: timeAt(from), end: timeAt(to) };
  }

  /** Until when (performance.now()) a range change is the user's. */
  let userUntil = 0;
  const interacting = (event: Event) => {
    // A pointer moving with no button down is hovering, not scrolling.
    const hovering = event instanceof PointerEvent && event.buttons === 0;
    if (event.type === "pointermove" && hovering) return;
    userUntil = performance.now() + USER_MS;
  };
  const inputs = ["pointerdown", "pointermove", "wheel", "keydown"] as const;
  for (const type of inputs) {
    element.addEventListener(type, interacting, { passive: true });
  }

  function onRangeChange(logical: LogicalRange | null): void {
    if (logical === null || times.length === 0) return;
    const visible = toRange(logical);
    const user = performance.now() < userUntil;
    if (user && !moved(shown, visible, interval)) return;
    shown = visible;
    if (!user) return;
    for (const listener of listeners) listener(visible);
  }
  scale.subscribeVisibleLogicalRangeChange(onRangeChange);

  return {
    draw(result) {
      const data = toBars(result);
      if (data === undefined) return;
      const before = times.at(-1);
      times = result.timestamps;
      candles.setData(data.bars);
      volume.setData(data.volumes);
      if (times.length === 0) return;
      const target =
        before === undefined || shown === undefined
          ? opening
          : keptRange(shown, before, times.at(-1));
      shown = target;
      scale.setVisibleLogicalRange({
        from: logicalAt(target.start),
        to: logicalAt(target.end),
      });
    },
    onScroll(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
      for (const type of inputs) {
        element.removeEventListener(type, interacting);
      }
      scale.unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart.remove();
    },
  };
}
