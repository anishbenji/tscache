// The candle chart on uPlot: candles drawn on the price scale, volume as
// bars on a scale of its own along the bottom. uPlot takes the cache's
// typed arrays as they are, with no copy and no object per bar.
//
// uPlot has no candle series and no panning of its own: a draw hook paints
// the candles, and the wheel zooms and a drag pans the time axis.
//
// Nor has it a call that adds bars: it draws its canvas again from the
// arrays on any change, and its own streaming demos call setData on each
// one. So a live bar takes the same setData as any answer, on the cache's
// arrays as they are, and only the count of draws (countDraw) tells it
// from a change of history.

import type { GetResult, Range } from "tscache";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import {
  appendedFrom,
  type ChartOptions,
  type ChartView,
  countDraw,
  keptRange,
  moved,
} from "./view";

const UP = "#2a78d6";
const DOWN = "#eb6834";
const HEIGHT = 360;

/** The columns uPlot draws, in its order: time first. */
const COLUMNS = ["open", "high", "low", "close", "volume"] as const;

function drawCandles(u: uPlot): void {
  const [time, open, high, low, close] = u.data;
  if (!time || !open || !high || !low || !close) return;
  const [first = 0, last = time.length - 1] = u.series[0]?.idxs ?? [];
  const { ctx, bbox } = u;
  const column = bbox.width / Math.max(1, last - first + 1);
  const body = Math.max(1, Math.round(column * 0.7));
  const wick = Math.max(1, Math.round(uPlot.pxRatio));
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  for (let i = first; i <= last; i++) {
    const o = open[i];
    const c = close[i];
    const h = high[i];
    const l = low[i];
    if (o == null || c == null || h == null || l == null) continue;
    const x = Math.round(u.valToPos(time[i] ?? 0, "x", true));
    const top = u.valToPos(Math.max(o, c), "price", true);
    const bottom = u.valToPos(Math.min(o, c), "price", true);
    ctx.fillStyle = c >= o ? UP : DOWN;
    const yh = u.valToPos(h, "price", true);
    ctx.fillRect(x - wick / 2, yh, wick, u.valToPos(l, "price", true) - yh);
    ctx.fillRect(x - body / 2, top, body, Math.max(1, bottom - top));
  }
  ctx.restore();
}

/** The wheel zooms around the pointer; a drag pans. */
function panAndZoom(u: uPlot): void {
  const span = () => {
    const { min = 0, max = 0 } = u.scales.x ?? {};
    return { min, max };
  };
  u.over.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const { min, max } = span();
      const at = u.posToVal(event.offsetX, "x");
      const factor = event.deltaY < 0 ? 0.8 : 1.25;
      u.setScale("x", {
        min: at - (at - min) * factor,
        max: at + (max - at) * factor,
      });
    },
    { passive: false },
  );
  u.over.addEventListener("pointerdown", (event) => {
    const from = event.clientX;
    const { min, max } = span();
    const perPixel = (max - min) / u.over.clientWidth;
    u.over.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const shift = (from - next.clientX) * perPixel;
      u.setScale("x", { min: min + shift, max: max + shift });
    };
    const up = () => {
      u.over.removeEventListener("pointermove", move);
      u.over.removeEventListener("pointerup", up);
    };
    u.over.addEventListener("pointermove", move);
    u.over.addEventListener("pointerup", up);
  });
}

export function createUplotChart(
  element: HTMLElement,
  { interval, opening }: ChartOptions,
): ChartView {
  const listeners = new Set<(visible: Range) => void>();
  /** The range on screen as last drawn or reported. */
  let shown: Range | undefined;
  /** Set while draw() moves the scale, which is not the user scrolling. */
  let drawing = false;
  let times: ArrayLike<number> = [];
  /** The answer drawn last. */
  let drawn: GetResult | undefined;

  function onScale(u: uPlot, key: string): void {
    if (key !== "x" || drawing) return;
    const { min, max } = u.scales.x ?? {};
    if (min == null || max == null) return;
    const visible = { start: min, end: max };
    if (!moved(shown, visible, interval)) return;
    shown = visible;
    for (const listener of listeners) listener(visible);
  }

  const volumeBars = uPlot.paths.bars?.({ size: [0.7, 40] });
  const plot = new uPlot(
    {
      width: element.clientWidth,
      height: HEIGHT,
      ms: 1,
      // UTC, as Lightweight Charts shows it.
      tzDate: (t) => uPlot.tzDate(new Date(t), "Etc/UTC"),
      cursor: { drag: { x: false, y: false, setScale: false } },
      legend: { show: false },
      scales: {
        x: { time: true, auto: false },
        // Candles keep to the top three quarters, volume to the bottom.
        price: {
          range: (_u, min, max) => {
            const span = Math.max(max - min, Math.abs(max) * 1e-6, 1e-9);
            return [min - span / 3, max + span * 0.05];
          },
        },
        volume: { range: (_u, _min, max) => [0, Math.max(1, max) * 4] },
      },
      series: [
        {},
        // The candle columns set the price scale; the draw hook paints them.
        ...COLUMNS.slice(0, 4).map((label) => ({
          label,
          scale: "price",
          paths: () => null,
          points: { show: false },
        })),
        {
          label: "volume",
          scale: "volume",
          fill: "rgba(82, 81, 78, 0.18)",
          ...(volumeBars && { paths: volumeBars }),
        },
      ],
      axes: [
        {},
        { scale: "price", size: 64 },
        { scale: "volume", show: false },
      ],
      hooks: {
        draw: [drawCandles],
        setScale: [onScale],
        ready: [panAndZoom],
      },
    },
    [[], [], [], [], [], []],
    element,
  );

  const resize = new ResizeObserver(() => {
    plot.setSize({ width: element.clientWidth, height: HEIGHT });
  });
  resize.observe(element);

  return {
    draw(result) {
      const { timestamps, fields } = result;
      const columns = COLUMNS.map((name) => fields[name]);
      if (columns.some((column) => column === undefined)) return;
      countDraw(element, appendedFrom(drawn, result) !== undefined);
      drawn = result;
      const before = times.length > 0 ? times[times.length - 1] : undefined;
      times = timestamps;
      // An answer without bars clears the chart and keeps the time on
      // screen, so the bars of a later answer appear where the user was.
      const target =
        shown === undefined
          ? opening
          : keptRange(shown, before, timestamps.at(-1));
      shown = target;
      drawing = true;
      plot.batch(() => {
        plot.setData([timestamps, ...columns] as uPlot.AlignedData, false);
        // Setting x again re-ranges the price scale to the bars on screen.
        plot.setScale("x", { min: target.start, max: target.end });
      });
      drawing = false;
    },
    visible: () => shown,
    onScroll(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
      resize.disconnect();
      plot.destroy();
    },
  };
}
