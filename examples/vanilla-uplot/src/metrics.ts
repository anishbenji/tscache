// Live server metrics: a dashboard that asks for the last ten minutes every
// second. The backend reports a watermark (meta.finalizedUntil) with each
// answer; points before it become covered and are never fetched again,
// points after it stay provisional (request counts still arriving), so each
// poll fetches only the provisional tail and the seconds since the last one.

import { datasets } from "@examples/mock-backend/datasets";
import type { CacheConfig, CacheHandle, GetResult } from "tscache";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { chartWidth, keepClient, log, show, watchFetches } from "./session";

const INTERVAL = 5000;
const WINDOW = 10 * 60_000;

const config: CacheConfig = {
  id: "metrics/web",
  interval: INTERVAL,
  fields: datasets.metrics.fields,
};

let cache: CacheHandle | undefined;
let polling = false;
/** The first timestamp after the covered part of the last answer. */
let provisionalFrom = Number.POSITIVE_INFINITY;

function shadeProvisional(u: uPlot): void {
  if (!Number.isFinite(provisionalFrom)) return;
  const left = Math.max(u.bbox.left, u.valToPos(provisionalFrom, "x", true));
  u.ctx.fillStyle = "rgba(234, 179, 8, 0.15)";
  u.ctx.fillRect(
    left,
    u.bbox.top,
    u.bbox.left + u.bbox.width - left,
    u.bbox.height,
  );
}

const bars = uPlot.paths.bars?.({ size: [0.7, 40] });
const chart = new uPlot(
  {
    width: chartWidth(),
    height: 320,
    ms: 1,
    scales: { cpu: { range: [0, 100] } },
    series: [
      {},
      { label: "CPU %", scale: "cpu", stroke: "#2563eb", width: 1.5 },
      {
        label: "Requests per 5 s",
        scale: "requests",
        stroke: "#9333ea",
        fill: "rgba(147, 51, 234, 0.2)",
        ...(bars && { paths: bars }),
      },
    ],
    axes: [
      {},
      { scale: "cpu", label: "CPU %" },
      { scale: "requests", side: 1, grid: { show: false } },
    ],
    hooks: { drawClear: [shadeProvisional] },
  },
  [[], [], []],
  document.querySelector<HTMLElement>("#chart") ?? document.body,
);

function draw(result: GetResult, now: number): void {
  const covered = result.coverage.at(-1)?.end;
  provisionalFrom = covered === undefined ? now - WINDOW : covered + INTERVAL;
  const { cpu, requests } = result.fields;
  if (!cpu || !requests) return;
  chart.batch(() => {
    chart.setData([result.timestamps, cpu, requests], false);
    chart.setScale("x", { min: now - WINDOW, max: now });
  });
  const final = result.timestamps.filter((t) => t < provisionalFrom).length;
  show("final", final);
  show("provisional", result.timestamps.length - final);
  for (const miss of result.misses) {
    if (miss.reason !== "uncached") log(`miss: ${miss.reason}`);
  }
  show("status", "live");
}

async function poll(): Promise<void> {
  if (polling || cache === undefined) return;
  polling = true;
  try {
    const now = Date.now();
    draw(await cache.get({ start: now - WINDOW, end: now }), now);
  } catch (error) {
    log(`get failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    polling = false;
  }
}

document.querySelector("#bump")?.addEventListener("click", async () => {
  const response = await fetch("/api/control", {
    method: "POST",
    body: JSON.stringify({ bumpVersion: true }),
  });
  const { version } = (await response.json()) as { version: string };
  log(`backend restated history as ${version}`);
});

addEventListener("resize", () => {
  chart.setSize({ width: chartWidth(), height: 320 });
});

watchFetches();
void keepClient(async (client) => {
  show("mode", client.mode);
  cache = await client.cache(config);
  await poll();
});
setInterval(() => void poll(), 1000);
