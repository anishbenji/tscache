// Sparse event counts: most one-minute slots hold no event. tscache splits
// a series into dense segments wherever more than gapSplitK slots in a row
// are empty (default 4), so memory follows the events rather than the span,
// while coverage still records every empty slot as known: zooming into the
// loaded week is answered from the cache, empty stretches included.

import { datasets } from "@examples/mock-backend/datasets";
import type { CacheConfig, CacheHandle, Range } from "tscache";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { chartWidth, keepClient, log, show, watchFetches } from "./session";

const INTERVAL = 60_000;
const WEEK = 7 * 24 * 3_600_000;

const config: CacheConfig = {
  id: "events/signups",
  interval: INTERVAL,
  fields: datasets.events.fields,
};

let cache: CacheHandle | undefined;
/** Set while this module moves the x scale, so the zoom hook ignores it. */
let moving = false;
/** Numbers each load; only the latest one may draw. */
let latest = 0;

function coveredSlots(coverage: Range[]): number {
  let slots = 0;
  for (const { start, end } of coverage) slots += (end - start) / INTERVAL + 1;
  return slots;
}

async function load(range: Range): Promise<void> {
  if (cache === undefined) return;
  const ticket = ++latest;
  const result = await cache.get(range);
  // A slower answer to an earlier request (a reset waiting on a fetch)
  // would otherwise undo the zoom that came after it.
  if (ticket !== latest) return;
  const { count } = result.fields;
  if (!count) return;
  moving = true;
  chart.batch(() => {
    chart.setData([result.timestamps, count], false);
    chart.setScale("x", { min: range.start, max: range.end });
  });
  moving = false;
  show("points", result.timestamps.length);
  show("empty", coveredSlots(result.coverage) - result.timestamps.length);
  show("status", "ready");
}

function onZoom(u: uPlot, key: string): void {
  if (key !== "x" || moving) return;
  const { min, max } = u.scales.x ?? {};
  if (min === undefined || max === undefined) return;
  void load({ start: min, end: max }).catch((error) => log(String(error)));
}

const bars = uPlot.paths.bars?.({ size: [1, 6] });
const chart = new uPlot(
  {
    width: chartWidth(),
    height: 300,
    ms: 1,
    series: [
      {},
      {
        label: "Events per minute",
        stroke: "#0f766e",
        fill: "rgba(15, 118, 110, 0.35)",
        ...(bars && { paths: bars }),
      },
    ],
    hooks: { setScale: [onZoom] },
  },
  [[], []],
  document.querySelector<HTMLElement>("#chart") ?? document.body,
);

function wholeWeek(): Range {
  const now = Date.now();
  return { start: now - WEEK, end: now };
}

document.querySelector("#reset")?.addEventListener("click", () => {
  void load(wholeWeek());
});

addEventListener("resize", () => {
  chart.setSize({ width: chartWidth(), height: 300 });
});

watchFetches();
void keepClient(async (client) => {
  show("mode", client.mode);
  cache = await client.cache(config);
  await load(wholeWeek());
});
