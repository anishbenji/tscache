// The page's choice between the two chart libraries, each loaded only when
// shown. A page with one chart imports its implementation directly.

import type { CreateChart } from "./view";

const chartKinds = ["lightweight", "uplot"] as const;
export type ChartKind = (typeof chartKinds)[number];

/**
 * The chart library a page asked for with `?chart=`, by default
 * Lightweight Charts.
 */
export function chartKindOf(search: string): ChartKind {
  const asked = new URLSearchParams(search).get("chart");
  return chartKinds.find((kind) => kind === asked) ?? "lightweight";
}

/** Loads only the library the page shows. */
export async function loadChart(kind: ChartKind): Promise<CreateChart> {
  switch (kind) {
    case "lightweight": {
      const { createLightweightChart } = await import("./lightweight");
      return createLightweightChart;
    }
    case "uplot": {
      const { createUplotChart } = await import("./uplot");
      return createUplotChart;
    }
  }
}
