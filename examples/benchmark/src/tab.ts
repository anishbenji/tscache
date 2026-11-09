// One tab of the benchmark (tab.html, in an iframe of the benchmark page):
// it opens the source its URL names and reads the views the page sends,
// one after another, drawing each with uPlot. Each view is timed from the
// read's start until the frame after setData returned, the same way for
// every mode. Before the page removes it, the tab disposes of its source.

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { openSource, type Source } from "./modes";
import type { PageMessage, TabMessage, ViewTiming } from "./protocol";
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

type RunMessage = Extract<PageMessage, { type: "run" }>;

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

let source: Source | undefined;

addEventListener("message", (event: MessageEvent<PageMessage>) => {
  if (event.origin !== location.origin) return;
  const message = event.data;
  if (message.type === "run") {
    if (source !== undefined) readAll(source, message).catch(fail);
    return;
  }
  // Answered even when the source never opened, so the page never waits.
  const disposing = source?.dispose() ?? Promise.resolve();
  source = undefined;
  disposing.then(
    () => post({ type: "disposed", tab }),
    (error: unknown) => fail(error),
  );
});

async function start(): Promise<void> {
  if (!isMode(mode)) throw new Error(`unknown mode ${mode}`);
  const openedAt = performance.now();
  source = await openSource(mode, run);
  post({ type: "ready", tab, setupMs: performance.now() - openedAt });
}

function fail(error: unknown): void {
  post({ type: "failed", tab, error: String(error) });
}

start().catch(fail);
