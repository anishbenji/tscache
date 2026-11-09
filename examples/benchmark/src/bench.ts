// The benchmark page: runs the workload (workload.ts) once per mode per
// run, in tabs that are same-origin iframes of this page, so tscache's
// tabs share one SharedWorker as real tabs of an origin do. Each mode of a
// run starts from nothing: its tabs are new, tscache's cache id is new, and
// so is its SharedWorker, whose URL carries the run's id (modes.ts). Tabs
// dispose of their sources before they are removed.
// The backend's counters are read before and after each phase, so its
// numbers are deltas of this mode's run alone. The modes take turns within
// each run, in an order rotated by one each run.
//
// URL parameters, for scripts/demo-bench.ts and the end-to-end test:
// `latency` (ms per backend page), `runs`, `modes` (a comma list) and
// `autorun=1`, which starts at once.

import type { Range } from "@anishbenji/tscache";
import { fetchSeries } from "@examples/mock-backend/fetcher";
import { onInsight } from "@examples/mock-backend/insights";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { PageMessage, TabMessage, ViewTiming } from "./protocol";
import {
  type Conditions,
  cells,
  describeConditions,
  freshWorkers,
  HEADERS,
  markdown,
  type Row,
  type RunResult,
  rows,
  type Served,
  type WorkerReport,
} from "./report";
import {
  anchorFor,
  INTERVAL,
  isMode,
  MODES,
  type Mode,
  SERIES,
  type View,
  workload,
} from "./workload";
import "./style.css";

const LATENCIES = [50, 300, 1000];
const DEFAULT_LATENCY = 300;
const DEFAULT_RUNS = 5;

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`index.html has no ${selector}`);
  return found;
}

const status = element<HTMLOutputElement>('[data-testid="status"]');
const latencySelect = element<HTMLSelectElement>("#latency");
const runsInput = element<HTMLInputElement>("#runs");
const runButton = element<HTMLButtonElement>("#run");
const copyButton = element<HTMLButtonElement>("#copy");
const tabs = element<HTMLElement>("#tabs");

// --- The backend -----------------------------------------------------------

/** The counters of GET /api/stats the benchmark reads. */
interface Counters {
  pages: Record<string, number>;
  points: number;
  bytes: number;
}

async function counters(): Promise<Counters> {
  const response = await fetch("/api/stats");
  return (await response.json()) as Counters;
}

function served(before: Counters, after: Counters): Served {
  const pages = (c: Counters) =>
    Object.values(c.pages).reduce((a, b) => a + b, 0);
  return {
    requests: pages(after) - pages(before),
    bars: after.points - before.points,
    bytes: after.bytes - before.bytes,
  };
}

async function setLatency(latencyMs: number): Promise<void> {
  await fetch("/api/control", {
    method: "POST",
    body: JSON.stringify({ latencyMs }),
  });
}

// --- Tabs ------------------------------------------------------------------

/** What each open tab waits for, by tab id. */
const waiting = new Map<string, (message: TabMessage) => void>();

addEventListener("message", (event: MessageEvent<TabMessage>) => {
  if (event.origin !== location.origin) return;
  waiting.get(event.data.tab)?.(event.data);
});

interface Tab {
  setupMs: number;
  run(views: View[]): Promise<ViewTiming[]>;
  /** Disposes of the tab's source, then removes the tab. */
  close(): Promise<void>;
}

/** The next message of tab `id`; rejects on a failure it reports. */
function next(id: string): Promise<TabMessage> {
  return new Promise((resolve, reject) => {
    waiting.set(id, (message) => {
      waiting.delete(id);
      if (message.type === "failed") reject(new Error(message.error));
      else resolve(message);
    });
  });
}

/** Opens a tab of `mode` for run `run`, once its source is open. */
async function openTab(mode: Mode, run: string, n: number): Promise<Tab> {
  const id = `${run}/${n}`;
  const frame = document.createElement("iframe");
  const query = new URLSearchParams({ mode, run, tab: id });
  frame.src = `tab.html?${query}`;
  frame.title = `tab ${n}`;
  const ready = next(id);
  tabs.append(frame);
  const opened = await ready;
  if (opened.type !== "ready") throw new Error(`tab ${id}: ${opened.type}`);
  return {
    setupMs: opened.setupMs,
    async run(views) {
      const done = next(id);
      const message: PageMessage = { type: "run", views };
      frame.contentWindow?.postMessage(message, location.origin);
      const answer = await done;
      if (answer.type !== "done") throw new Error(`tab ${id}: ${answer.type}`);
      return answer.views;
    },
    async close() {
      const disposed = next(id);
      const message: PageMessage = { type: "dispose" };
      frame.contentWindow?.postMessage(message, location.origin);
      try {
        await disposed;
      } finally {
        frame.remove();
      }
    },
  };
}

/** Counts the main thread's long tasks until `stop`. */
function longTasks(): { stop(): { count: number; ms: number } } {
  const seen = { count: 0, ms: 0 };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      seen.count++;
      seen.ms += entry.duration;
    }
  });
  try {
    observer.observe({ type: "longtask" });
  } catch {
    // A browser without long-task timing reports none.
  }
  return {
    stop() {
      observer.disconnect();
      return seen;
    },
  };
}

// --- Workers ---------------------------------------------------------------

/**
 * Which worker fetched for which cache, from the fetch reports of every
 * worker of this origin: the check that each tscache run had a SharedWorker
 * of its own.
 */
const workerReports: WorkerReport[] = [];
onInsight(({ cacheId, worker }) => workerReports.push({ cacheId, worker }));

/**
 * The fresh-worker check, once a report of each of `runs` tscache runs has
 * arrived; the reports travel on a channel of their own, so wait a little
 * for the last.
 */
async function workersChecked(
  runs: number,
): Promise<ReturnType<typeof freshWorkers>> {
  for (let wait = 0; ; wait++) {
    const check = freshWorkers(workerReports);
    if (check.runs >= runs || wait >= 50) return check;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// --- Runs ------------------------------------------------------------------

/** One run of `mode`: phase one in a tab, then phase two in three. */
async function runMode(
  mode: Mode,
  run: number,
  id: string,
  plan: ReturnType<typeof workload>,
): Promise<RunResult> {
  const tasks = longTasks();
  const before = await counters();
  const startedAt = performance.now();
  const first = await openTab(mode, id, 1);
  const opened = [first];
  try {
    const one = await first.run(plan.one);
    const middle = await counters();
    opened.push(
      ...(await Promise.all([openTab(mode, id, 2), openTab(mode, id, 3)])),
    );
    const three = await Promise.all(opened.map((tab) => tab.run(plan.three)));
    const workloadMs = performance.now() - startedAt;
    const after = await counters();
    return {
      mode,
      run,
      one: served(before, middle),
      three: served(middle, after),
      chartMs: [one, ...three].flat().map((view) => view.chartMs),
      workloadMs,
      setupMs: first.setupMs,
      longTasks: tasks.stop(),
    };
  } finally {
    tasks.stop();
    await Promise.all(opened.map((tab) => tab.close()));
  }
}

/** `modes`, rotated left by `by`. */
function rotated(modes: readonly Mode[], by: number): Mode[] {
  const k = by % modes.length;
  return [...modes.slice(k), ...modes.slice(0, k)];
}

function browserName(): string {
  const chrome = /(?:HeadlessChrome|Chrome)\/([\d.]+)/.exec(
    navigator.userAgent,
  );
  return chrome === null ? navigator.userAgent : `Chromium ${chrome[1]}`;
}

function showTable(conditions: Conditions, table: Row[]): void {
  element('[data-testid="conditions"]').textContent =
    describeConditions(conditions);
  const head = document.createElement("tr");
  for (const header of HEADERS) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = header;
    head.append(th);
  }
  element("#results thead").replaceChildren(head);
  const body = element("#results tbody");
  body.replaceChildren(
    ...table.map((row) => {
      const tr = document.createElement("tr");
      tr.dataset.mode = row.mode;
      for (const cell of cells(row)) {
        const td = document.createElement("td");
        td.textContent = cell;
        tr.append(td);
      }
      return tr;
    }),
  );
}

let last: { conditions: Conditions; table: Row[] } | undefined;

async function runAll(
  latencyMs: number,
  runs: number,
  modes: readonly Mode[],
): Promise<void> {
  runButton.disabled = true;
  copyButton.disabled = true;
  try {
    await setLatency(latencyMs);
    const plan = workload(anchorFor(Date.now()));
    const nonce = crypto.randomUUID().slice(0, 8);
    const results: RunResult[] = [];
    for (let run = 0; run < runs; run++) {
      for (const mode of rotated(modes, run)) {
        status.value = `running ${mode}, run ${run + 1} of ${runs}`;
        results.push(await runMode(mode, run, `${nonce}-${run}-${mode}`, plan));
      }
    }
    const conditions = { latencyMs, runs, browser: browserName() };
    const table = rows(results, MODES);
    const workers = await workersChecked(modes.includes("tscache") ? runs : 0);
    last = { conditions, table };
    showTable(conditions, table);
    element('[data-testid="workers"]').textContent = workers.fresh
      ? `A new SharedWorker for each tscache run: ${workers.runs} runs, ${workers.workers} workers.`
      : `A tscache run reused a worker: ${workers.runs} runs, ${workers.workers} workers.`;
    element('[data-testid="results-json"]').textContent = JSON.stringify({
      conditions,
      anchor: plan.one.at(0)?.range.end,
      rows: table,
      runs: results,
      workers,
    });
    status.value = "done";
  } catch (error) {
    status.value = `failed: ${error instanceof Error ? error.message : error}`;
  } finally {
    runButton.disabled = false;
    copyButton.disabled = last === undefined;
  }
}

// --- The page --------------------------------------------------------------

/** The workload's first screen, fetched once without a cache. */
async function preview(): Promise<void> {
  const range: Range = workload(anchorFor(Date.now())).one[0]?.range ?? {
    start: 0,
    end: 0,
  };
  const response = await fetchSeries(
    {
      cacheId: SERIES,
      range,
      interval: INTERVAL,
      alignmentOffset: 0,
      context: {},
    },
    { page() {} },
  );
  const close = (response.fields.close ?? []) as number[];
  new uPlot(
    {
      width: Math.min(document.body.clientWidth, 720),
      height: 180,
      ms: 1,
      series: [{}, { label: "BENCH close", stroke: "#2563eb", width: 1.5 }],
    },
    [response.timestamps as number[], close],
    element("#preview"),
  );
  element('[data-testid="preview-bars"]').textContent = String(
    response.timestamps.length,
  );
}

const params = new URLSearchParams(location.search);
const asked = Number(params.get("latency"));
latencySelect.value = String(
  LATENCIES.includes(asked) ? asked : DEFAULT_LATENCY,
);
const askedRuns = Number(params.get("runs"));
runsInput.value = String(
  Number.isSafeInteger(askedRuns) && askedRuns > 0 ? askedRuns : DEFAULT_RUNS,
);
const modes = (params.get("modes")?.split(",") ?? [...MODES]).filter(isMode);

runButton.addEventListener("click", () => {
  void runAll(Number(latencySelect.value), Number(runsInput.value), modes);
});
copyButton.addEventListener("click", () => {
  if (last === undefined) return;
  void navigator.clipboard.writeText(markdown(last.conditions, last.table));
});

preview().then(
  () => {
    status.value = "ready";
    runButton.disabled = false;
    if (params.get("autorun") === "1") runButton.click();
  },
  (error: unknown) => {
    status.value = `failed: ${String(error)}`;
  },
);
