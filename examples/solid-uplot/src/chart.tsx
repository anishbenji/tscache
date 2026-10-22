// One uPlot chart per sensor field, stacked on one time axis. Each chart gets
// every slot of the range with null where the slot holds no point, so its
// line breaks there. Under the lines, a grey band marks each confirmed gap
// and a hatched band marks time that is not loaded.

import { createEffect, onSettled } from "solid-js";
import type { Range } from "tscache";
import uPlot from "uplot";
import type { Frame } from "./frame";

interface Panel {
  field: string;
  label: string;
  dtype: string;
  unit: string;
  digits: number;
  color: string;
  height: number;
  stepped?: boolean;
  range?: [min: number, max: number];
  /** Draw the time axis under this chart; the stack shares one. */
  timeAxis?: boolean;
}

export const PANELS: readonly Panel[] = [
  {
    field: "temperature",
    label: "Temperature",
    dtype: "f32",
    unit: "°C",
    digits: 1,
    color: "#eb6834",
    height: 150,
  },
  {
    field: "humidity",
    label: "Humidity",
    dtype: "f32",
    unit: "%",
    digits: 1,
    color: "#2a78d6",
    height: 150,
  },
  {
    field: "battery",
    label: "Battery",
    dtype: "u8",
    unit: "%",
    digits: 0,
    color: "#1baf7a",
    height: 160,
    stepped: true,
    range: [0, 100],
    timeAxis: true,
  },
];

const GAP_FILL = "rgba(82, 81, 78, 0.16)";

let hatch: CanvasPattern | null | undefined;

function hatchPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (hatch !== undefined) return hatch;
  const tile = document.createElement("canvas");
  tile.width = tile.height = 8;
  const pen = tile.getContext("2d");
  if (pen) {
    pen.strokeStyle = "rgba(82, 81, 78, 0.5)";
    pen.beginPath();
    pen.moveTo(0, 8);
    pen.lineTo(8, 0);
    pen.stroke();
  }
  hatch = ctx.createPattern(tile, "repeat");
  return hatch;
}

/** Fills the slots of `range` across the plot, at least one CSS pixel wide. */
function band(
  u: uPlot,
  range: Range,
  interval: number,
  fill: string | CanvasPattern,
): void {
  const plotRight = u.bbox.left + u.bbox.width;
  const left = Math.max(
    u.bbox.left,
    u.valToPos(range.start - interval / 2, "x", true),
  );
  const right = Math.min(
    plotRight,
    u.valToPos(range.end + interval / 2, "x", true),
  );
  if (right < u.bbox.left || left > plotRight) return;
  u.ctx.fillStyle = fill;
  u.ctx.fillRect(
    left,
    u.bbox.top,
    Math.max(right - left, uPlot.pxRatio),
    u.bbox.height,
  );
}

function chartWidth(): number {
  return Math.min(document.body.clientWidth, 1024);
}

interface ChartProps {
  panel: Panel;
  frame: Frame;
  /** A range dragged across the chart. */
  onSelect: (range: Range) => void;
  /** The chart drew data. */
  onDraw: () => void;
}

export function SensorChart(props: ChartProps) {
  // A chart keeps its panel for life; only the frame changes.
  const { panel } = props;
  let shown: Frame | undefined;

  function drawBands(u: uPlot): void {
    if (shown === undefined) return;
    const { gaps, unloaded, interval } = shown;
    for (const gap of gaps) band(u, gap, interval, GAP_FILL);
    const pattern = hatchPattern(u.ctx);
    if (pattern === null) return;
    for (const range of unloaded) band(u, range, interval, pattern);
  }

  function select(u: uPlot): void {
    const { left, width } = u.select;
    u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    if (width < 2) return;
    props.onSelect({
      start: u.posToVal(left, "x"),
      end: u.posToVal(left + width, "x"),
    });
  }

  const stepped = panel.stepped && uPlot.paths.stepped?.({ align: 1 });
  const chart = new uPlot(
    {
      title: `${panel.label} (${panel.unit}, ${panel.dtype})`,
      width: chartWidth(),
      height: panel.height,
      ms: 1,
      // Fixed padding and axis sizes line the plots up, gaps included.
      padding: [12, 24, 0, 0],
      cursor: {
        y: false,
        drag: { x: true, y: false, setScale: false },
        // Share the crosshair, not the drag: each chart reports its own.
        sync: {
          key: "sensor",
          filters: {
            pub: (type) => type !== "mousedown" && type !== "mouseup",
          },
        },
      },
      scales: panel.range ? { y: { range: panel.range } } : {},
      series: [
        {},
        {
          label: panel.label,
          stroke: panel.color,
          width: 2,
          value: (_u, v, _series, slot) => {
            if (slot === null) return "--";
            if (v === null) return "no reading";
            return `${v.toFixed(panel.digits)} ${panel.unit}`;
          },
          ...(stepped && { paths: stepped }),
        },
      ],
      // Without vertical grid lines, every vertical mark in a plot is a gap.
      axes: [
        { show: panel.timeAxis === true, grid: { show: false } },
        { size: 56 },
      ],
      hooks: {
        drawClear: [drawBands],
        draw: [
          (u) => {
            if (u.data[0].length > 0) props.onDraw();
          },
        ],
        setSelect: [select],
      },
    },
    [[], []],
  );

  createEffect(
    () => props.frame,
    (frame) => {
      shown = frame;
      chart.batch(() => {
        chart.setData([frame.slots, frame.values[panel.field] ?? []], false);
        chart.setScale("x", { min: frame.range.start, max: frame.range.end });
      });
    },
  );

  onSettled(() => {
    const resize = () =>
      chart.setSize({ width: chartWidth(), height: panel.height });
    addEventListener("resize", resize);
    return () => {
      removeEventListener("resize", resize);
      chart.destroy();
    };
  });

  return <figure class="chart">{chart.root}</figure>;
}
