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
import { type FetchInsight, onInsight } from "@examples/mock-backend/insights";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { PageMessage, TabMessage, ViewTiming } from "./protocol";
import {
  type Conditions,
  cells,
  describeConditions,
  freshWorkers,
  HEADERS,
  HIT_RATIO_NOTE,
  markdown,
  type ReadView,
  type Row,
  type RunResult,
  reportedPages,
  requestedViews,
  rows,
  type Served,
} from "./report";
import { parseRunConfig, type RunConfig, type RunState, view } from "./run";
import {
  anchorFor,
  INTERVAL,
  MODES,
  type Mode,
  SERIES,
  sourceCacheId,
  type View,
  workload,
} from "./workload";
import "./style.css";
import { Mailbox, openTogether } from "./tabs";

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

/** What each open tab waits for, by tab id and message type. */
const mailbox = new Mailbox();

addEventListener("message", (event: MessageEvent<TabMessage>) => {
  if (event.origin !== location.origin) return;
  mailbox.deliver(event.data);
});

interface Tab {
  setupMs: number;
  run(views: View[]): Promise<ViewTiming[]>;
  /** Disposes of the tab's source, then removes the tab. */
  close(): Promise<void>;
}

/**
 * Opens a tab of `mode` for run `run`, once its source is open. A tab that
 * fails to open is removed.
 */
async function openTab(mode: Mode, run: string, n: number): Promise<Tab> {
  const id = `${run}/${n}`;
  const frame = document.createElement("iframe");
  const query = new URLSearchParams({ mode, run, tab: id });
  frame.src = `tab.html?${query}`;
  frame.title = `tab ${n}`;
  const ready = mailbox.next(id, "ready");
  tabs.append(frame);
  let opened: Awaited<typeof ready>;
  try {
    opened = await ready;
  } catch (error) {
    frame.remove();
    throw error;
  }
  return {
    setupMs: opened.setupMs,
    async run(views) {
      const done = mailbox.next(id, "done");
      const message: PageMessage = { type: "run", views };
      frame.contentWindow?.postMessage(message, location.origin);
      return (await done).views;
    },
    async close() {
      const disposed = mailbox.next(id, "disposed");
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
 * The fetch reports of every tab and worker of this origin, every mode's
 * fetches included: which views waited for a request, and the check that
 * each tscache run had a SharedWorker of its own.
 */
const reports: FetchInsight[] = [];
onInsight((insight) => reports.push(insight));

/** Resolves once `done()` holds, or after about five seconds. */
async function settled(done: () => boolean): Promise<boolean> {
  for (let wait = 0; ; wait++) {
    if (done() || wait >= 50) return done();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * The fresh-worker check, once a report of each of `runs` tscache runs has
 * arrived; the reports travel on a channel of their own, so wait a little
 * for the last.
 */
async function workersChecked(
  runs: number,
  nonce: string,
): Promise<ReturnType<typeof freshWorkers>> {
  await settled(() => freshWorkers(reports, nonce).runs >= runs);
  return freshWorkers(reports, nonce);
}

/**
 * Which of a run's views waited for a request, once the fetch reports of its
 * caches account for every page the backend served it. Reports that never
 * add up fail the run: the page and the backend would disagree.
 */
async function requestedOf(
  views: ReadView[],
  requests: number,
): Promise<boolean[]> {
  const cacheIds = new Set(views.map((view) => view.cacheId));
  const pages = () => reportedPages(reports, cacheIds);
  if (!(await settled(() => pages() >= requests)) || pages() !== requests) {
    throw new Error(
      `fetch reports account for ${pages()} pages; the backend served ${requests}`,
    );
  }
  return requestedViews(views, reports);
}

/** A tab's views, as drawn, matched to the cache its fetches report under. */
function readViews(
  mode: Mode,
  id: string,
  tab: number,
  views: View[],
  timings: ViewTiming[],
): ReadView[] {
  const cacheId = sourceCacheId(mode, id, `${id}/${tab}`);
  return timings.map((timing, i) => ({
    cacheId,
    range: (views[i] as View).range,
    askedAt: timing.askedAt,
    answeredAt: timing.answeredAt,
  }));
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
      ...(await openTogether([
        () => openTab(mode, id, 2),
        () => openTab(mode, id, 3),
      ])),
    );
    const three = await Promise.all(opened.map((tab) => tab.run(plan.three)));
    const workloadMs = performance.now() - startedAt;
    const after = await counters();
    const phases = {
      one: served(before, middle),
      three: served(middle, after),
    };
    const views = [
      ...readViews(mode, id, 1, plan.one, one),
      ...three.flatMap((timings, i) =>
        readViews(mode, id, i + 1, plan.three, timings),
      ),
    ];
    return {
      mode,
      run,
      ...phases,
      chartMs: [one, ...three].flat().map((view) => view.chartMs),
      requested: await requestedOf(
        views,
        phases.one.requests + phases.three.requests,
      ),
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
  element('[data-testid="hit-ratio"]').textContent = HIT_RATIO_NOTE;
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

/** What a run that reached done publishes: made from it alone. */
interface Published {
  conditions: Conditions;
  table: Row[];
  workers: ReturnType<typeof freshWorkers>;
  /** The results as JSON, for scripts and tests (`results-json`). */
  json: string;
}

/** The page's one run state (run.ts); `render` shows it. */
let state: RunState<Published> = { kind: "idle" };
/** The workload's preview has been read; until then nothing can run. */
let previewed = false;

function setState(next: RunState<Published>): void {
  state = next;
  render();
}

/**
 * Shows the state: the status, Run, and the results, which exist only in
 * done. Every other state takes the last results off the page.
 */
function render(): void {
  const shown = view(state);
  status.value = previewed || state.kind !== "idle" ? shown.status : "loading";
  runButton.disabled = !previewed || !shown.canRun;
  copyButton.disabled = shown.results === undefined;
  const { results } = shown;
  if (results === undefined) {
    element('[data-testid="conditions"]').textContent =
      state.kind === "running" ? "Running." : "Not run yet.";
    element('[data-testid="hit-ratio"]').textContent = "";
    element('[data-testid="workers"]').textContent = "";
    element('[data-testid="results-json"]').textContent = "";
    element("#results thead").replaceChildren();
    element("#results tbody").replaceChildren();
    return;
  }
  showTable(results.conditions, results.table);
  element('[data-testid="workers"]').textContent =
    `A new SharedWorker for each tscache run: ${results.workers.runs} runs, ${results.workers.workers} workers.`;
  element('[data-testid="results-json"]').textContent = results.json;
}

/** Runs `config`, the validated configuration, to done or failed. */
async function runAll(config: RunConfig): Promise<void> {
  const { latencyMs, runs, modes } = config;
  setState({ kind: "running", config, progress: "running" });
  try {
    // Each click starts with no reports; its checks read its own runs only.
    reports.length = 0;
    await setLatency(latencyMs);
    const plan = workload(anchorFor(Date.now()));
    const nonce = crypto.randomUUID().slice(0, 8);
    const results: RunResult[] = [];
    for (let run = 0; run < runs; run++) {
      for (const mode of rotated(modes, run)) {
        setState({
          kind: "running",
          config,
          progress: `running ${mode}, run ${run + 1} of ${runs}`,
        });
        results.push(await runMode(mode, run, `${nonce}-${run}-${mode}`, plan));
      }
    }
    const workers = await workersChecked(
      modes.includes("tscache") ? runs : 0,
      nonce,
    );
    if (!workers.fresh) {
      throw new Error(
        `a tscache run reused a worker: ${workers.runs} runs, ${workers.workers} workers`,
      );
    }
    const conditions = { latencyMs, runs, browser: browserName() };
    const table = rows(results, MODES);
    const json = JSON.stringify({
      config,
      conditions,
      anchor: plan.one.at(0)?.range.end,
      rows: table,
      runs: results,
      workers,
    });
    setState({
      kind: "done",
      config,
      results: { conditions, table, workers, json },
    });
  } catch (error) {
    setState({
      kind: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
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
// The URL's parameters, parsed once; a bad one fails before anything runs.
const fromUrl = parseRunConfig({
  latency: params.get("latency"),
  runs: params.get("runs"),
  modes: params.get("modes"),
  autorun: params.get("autorun"),
});
if (fromUrl.ok) {
  latencySelect.value = String(fromUrl.config.latencyMs);
  runsInput.value = String(fromUrl.config.runs);
}

/** The controls, with the URL's modes, as a validated configuration. */
function fromControls(): ReturnType<typeof parseRunConfig> {
  return parseRunConfig({
    latency: latencySelect.value,
    runs: runsInput.value,
    modes: params.get("modes"),
    autorun: null,
  });
}

runButton.addEventListener("click", () => {
  if (state.kind === "running") return;
  const parsed = fromControls();
  if (!parsed.ok) {
    setState({ kind: "failed", error: parsed.errors.join(" ") });
    return;
  }
  void runAll(parsed.config);
});
copyButton.addEventListener("click", () => {
  if (state.kind !== "done") return;
  const { conditions, table } = state.results;
  void navigator.clipboard.writeText(markdown(conditions, table));
});

render();
preview().then(
  () => {
    previewed = true;
    if (!fromUrl.ok) {
      setState({ kind: "failed", error: fromUrl.errors.join(" ") });
      return;
    }
    render();
    if (fromUrl.config.autorun) runButton.click();
  },
  (error: unknown) => {
    setState({ kind: "failed", error: `the preview: ${String(error)}` });
  },
);
