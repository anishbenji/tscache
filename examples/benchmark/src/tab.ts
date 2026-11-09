// One tab of the benchmark (tab.html, in an iframe of the benchmark page):
// it opens the source its URL names and reads the views the page sends,
// one after another, drawing each with uPlot. Each view is timed from the
// read's start until the frame after setData returned, the same way for
// every mode.

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { openSource, type Source } from "./modes";
import type { RunMessage, TabMessage, ViewTiming } from "./protocol";
import { isMode } from "./workload";

const params = new URLSearchParams(location.search);
const mode = params.get("mode");
const run = params.get("run") ?? "";
const tab = params.get("tab") ?? "";

function post(message: TabMessage): void {
  parent.postMessage(message, location.origin);
}

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const chart = new uPlot(
  {
    width: 300,
    height: 140,
    ms: 1,
    legend: { show: false },
    series: [{}, { stroke: "#2563eb", width: 1 }],
    axes: [{ show: false }, { show: false }],
  },
  [[], []],
  document.body,
);

async function readAll(source: Source, { views }: RunMessage): Promise<void> {
  const timings: ViewTiming[] = [];
  for (const { range } of views) {
    const startedAt = performance.now();
    const bars = await source.read(range);
    chart.setData([bars.timestamps as number[], bars.close as number[]]);
    await nextFrame();
    timings.push({
      chartMs: performance.now() - startedAt,
      bars: bars.timestamps.length,
    });
  }
  post({ type: "done", tab, views: timings });
}

async function start(): Promise<void> {
  if (!isMode(mode)) throw new Error(`unknown mode ${mode}`);
  const openedAt = performance.now();
  const source = await openSource(mode, run);
  addEventListener("message", (event: MessageEvent<RunMessage>) => {
    if (event.origin !== location.origin || event.data.type !== "run") return;
    readAll(source, event.data).catch(fail);
  });
  post({ type: "ready", tab, setupMs: performance.now() - openedAt });
}

function fail(error: unknown): void {
  post({ type: "failed", tab, error: String(error) });
}

start().catch(fail);
