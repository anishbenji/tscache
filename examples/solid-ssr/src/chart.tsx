// The sensor's readings in one uPlot chart, drawn in the browser only. A get
// result holds present points only, in typed arrays the page owns, so uPlot
// draws those arrays as they are: no copy, and no slot grid padded with
// nulls. The lines break where readings are more than a minute apart.

import { createEffect, onSettled } from "solid-js";
import type { GetResult, Range } from "tscache";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { INTERVAL } from "./sensor";

const HEIGHT = 320;

const SERIES = [
  {
    field: "temperature",
    label: "Temperature",
    scale: "celsius",
    unit: "°C",
    digits: 1,
    color: "#eb6834",
    width: 2,
  },
  {
    field: "humidity",
    label: "Humidity",
    scale: "percent",
    unit: "%",
    digits: 1,
    color: "#2a78d6",
    width: 2,
  },
  {
    field: "battery",
    label: "Battery",
    scale: "percent",
    unit: "%",
    digits: 0,
    color: "#1baf7a",
    width: 1,
  },
] as const;

const NO_VALUES = new Float32Array();

/**
 * uPlot joins consecutive points, so it would draw across a dropout. Each
 * pair of readings more than one interval apart becomes a gap, in canvas
 * pixels from one reading to the next, as uPlot makes of a run of nulls.
 */
function dropouts(
  u: uPlot,
  _series: number,
  first: number,
  last: number,
): uPlot.Series.Gaps {
  const xs = u.data[0];
  const px = (i: number) => Math.round(u.valToPos(xs[i] as number, "x", true));
  const gaps: uPlot.Series.Gaps = [];
  for (let i = first + 1; i <= last; i++) {
    if ((xs[i] as number) - (xs[i - 1] as number) > INTERVAL) {
      gaps.push([px(i - 1), px(i)]);
    }
  }
  return gaps;
}

function axis(scale: string, unit: string, side: 1 | 3): uPlot.Axis {
  return {
    scale,
    side,
    size: 56,
    grid: { show: side === 3 },
    values: (_u, ticks) => ticks.map((t) => `${t} ${unit}`),
  };
}

const options: uPlot.Options = {
  width: 600,
  height: HEIGHT,
  ms: 1,
  tzDate: (t) => uPlot.tzDate(new Date(t), "Etc/UTC"),
  cursor: { y: false },
  scales: { percent: { range: [0, 100] } },
  series: [
    { label: "UTC" },
    ...SERIES.map(
      ({ label, scale, unit, digits, color, width }): uPlot.Series => ({
        label,
        scale,
        stroke: color,
        width,
        gaps: dropouts,
        value: (_u, v) => (v === null ? "--" : `${v.toFixed(digits)} ${unit}`),
      }),
    ),
  ],
  axes: [{}, axis("celsius", "°C", 3), axis("percent", "%", 1)],
};

interface ChartProps {
  /** The browser's latest answer and its range; none before the first. */
  shown: { range: Range; result: GetResult } | undefined;
}

export function SensorChart(props: ChartProps) {
  let frame: HTMLDivElement | undefined;
  const chart = new uPlot(options, [[], [], [], []]);

  createEffect(
    () => props.shown,
    (shown) => {
      if (shown === undefined) return;
      const { range, result } = shown;
      chart.batch(() => {
        chart.setData(
          [
            result.timestamps,
            ...SERIES.map(({ field }) => result.fields[field] ?? NO_VALUES),
          ],
          false,
        );
        chart.setScale("x", { min: range.start, max: range.end });
      });
    },
  );

  onSettled(() => {
    const fit = () =>
      chart.setSize({ width: frame?.clientWidth ?? 0, height: HEIGHT });
    fit();
    addEventListener("resize", fit);
    return () => {
      removeEventListener("resize", fit);
      chart.destroy();
    };
  });

  return (
    <div class="plot" ref={frame}>
      {chart.root}
    </div>
  );
}
