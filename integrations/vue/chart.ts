// The chart every page of this snippet shows, the same component on the
// server and in the browser: the server renders it from its read, and the
// browser's hydration render from that same read, so the two agree. A
// render function rather than a .vue file, so tsc checks it as it is.

import type { Range } from "tscache";
import { defineComponent, h, shallowRef } from "vue";
import { candles, describe } from "../shared/candles";
import { type Answer, useSeries } from "./series";

export interface ChartProps {
  /** The range shown first. */
  range: Range;
  /** The server's read of `range`, shown until the browser's own answer. */
  initial?: Answer;
}

function line(answer: Answer | undefined, error: unknown): string {
  if (error !== undefined) return `Could not load the candles: ${error}`;
  if (answer === undefined) return "Loading the candles…";
  return describe(answer.result);
}

/** One chart of daily candles. */
export const Chart = defineComponent(
  function Chart(props: ChartProps) {
    // Scrolling the chart sets this to the visible range; the cache
    // fetches only what it does not hold.
    const visible = shallowRef(props.range);
    const { answer, pending, error } = useSeries(
      candles,
      visible,
      props.initial,
    );
    // A chart library would take answer.value.result.timestamps and
    // .fields here: create it in onMounted, hand it each answer in a watch
    // on answer, and set visible.value from its visible-range callback.
    return () =>
      h(
        "p",
        { id: "chart", "aria-busy": pending.value },
        line(answer.value, error.value),
      );
  },
  { props: ["range", "initial"] },
);
