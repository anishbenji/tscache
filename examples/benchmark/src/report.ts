// The benchmark's results: what one run of one mode measured, and the
// table made of every run. Pure, so the page and scripts/demo-bench.ts
// render the same table from the same runs.

import type { Range } from "@anishbenji/tscache";
import { MODE_LABELS, type Mode } from "./workload";

/** What the backend served during a phase, read as counter deltas. */
export interface Served {
  /** Series pages answered: one per backend request. */
  requests: number;
  bars: number;
  bytes: number;
}

/** One run of one mode: both phases of the workload. */
export interface RunResult {
  mode: Mode;
  /** Which run, from 0; the modes take turns within a run. */
  run: number;
  /** Phase one (one tab) and phase two (three tabs at once). */
  one: Served;
  three: Served;
  /**
   * Time to chart of every view of every tab, in ms: phase one's tab, then
   * phase two's tabs in turn, so the first is the run's first view.
   */
  chartMs: number[];
  /** Whether each view, in the order of `chartMs`, waited for a request. */
  requested: boolean[];
  /** From opening the first tab to the last tab's last frame. */
  workloadMs: number;
  /**
   * Opening the first tab's source: for tscache, the client's connect to a
   * SharedWorker that every run starts anew (modes.ts).
   */
  setupMs: number;
  /** Main-thread long tasks during the run (PerformanceObserver). */
  longTasks: { count: number; ms: number };
}

export interface Conditions {
  latencyMs: number;
  runs: number;
  browser: string;
}

/** One mode's row: medians over its runs. */
export interface Row {
  mode: Mode;
  requests: number;
  requestsOne: number;
  requestsThree: number;
  /**
   * Every run made the same requests and answered the same views without
   * one; the counts are deterministic.
   */
  stable: boolean;
  /** Views answered without a request, and views, per run. */
  hits: number;
  views: number;
  bars: number;
  bytes: number;
  chartP50: number;
  chartP95: number;
  /** The p50 of the views answered without a request, and of the rest. */
  hitP50: number;
  missP50: number;
  /**
   * The run's first view, its first fetch included; timed from the read's
   * start, after the connect (`setupMs`): the median, and run 1's.
   */
  firstViewMs: number;
  coldFirstViewMs: number;
  workloadMs: number;
  /** The median first connect, and run 1's, the browser's coldest. */
  setupMs: number;
  coldSetupMs: number;
  longTasks: number;
  /** Requests and bytes as a share of no cache's. */
  vsNone: { requests: number; bytes: number } | undefined;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** The value at quantile `q` of `values` (nearest rank). */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil(q * sorted.length)),
  );
  return sorted[rank - 1] as number;
}

const total = (r: RunResult) => r.one.requests + r.three.requests;
const hitsOf = (r: RunResult) => r.requested.filter((asked) => !asked).length;

/** The time to chart of the views of `r` that did, or did not, request. */
function chartWhere(r: RunResult, requested: boolean): number[] {
  return r.chartMs.filter((_, i) => r.requested[i] === requested);
}

function rowOf(mode: Mode, runs: readonly RunResult[]): Row {
  const of = (f: (r: RunResult) => number) => median(runs.map(f));
  /** The median over the runs that have a value; NaN when none has. */
  const ofSome = (f: (r: RunResult) => number) =>
    median(runs.map(f).filter((n) => !Number.isNaN(n)));
  const first = runs.reduce((a, r) => (r.run < a.run ? r : a));
  const counts = (r: RunResult) => `${total(r)}:${hitsOf(r)}`;
  return {
    mode,
    requests: of(total),
    requestsOne: of((r) => r.one.requests),
    requestsThree: of((r) => r.three.requests),
    stable: new Set(runs.map(counts)).size <= 1,
    hits: of(hitsOf),
    views: of((r) => r.chartMs.length),
    bars: of((r) => r.one.bars + r.three.bars),
    bytes: of((r) => r.one.bytes + r.three.bytes),
    chartP50: of((r) => quantile(r.chartMs, 0.5)),
    chartP95: of((r) => quantile(r.chartMs, 0.95)),
    hitP50: ofSome((r) => quantile(chartWhere(r, false), 0.5)),
    missP50: ofSome((r) => quantile(chartWhere(r, true), 0.5)),
    firstViewMs: of((r) => r.chartMs[0] ?? Number.NaN),
    coldFirstViewMs: first.chartMs[0] ?? Number.NaN,
    workloadMs: of((r) => r.workloadMs),
    setupMs: of((r) => r.setupMs),
    coldSetupMs: first.setupMs,
    longTasks: of((r) => r.longTasks.count),
    vsNone: undefined,
  };
}

/** One row per mode that ran, in `order`, with its share of no cache's. */
export function rows(
  runs: readonly RunResult[],
  order: readonly Mode[],
): Row[] {
  const made = order
    .map((mode) => runs.filter((r) => r.mode === mode))
    .filter((of) => of.length > 0)
    .map((of) => rowOf((of[0] as RunResult).mode, of));
  const none = made.find((row) => row.mode === "none");
  return made.map((row) => ({
    ...row,
    vsNone:
      none === undefined
        ? undefined
        : {
            requests: row.requests / none.requests,
            bytes: row.bytes / none.bytes,
          },
  }));
}

const int = (n: number) => Math.round(n).toLocaleString("en-US");
// A value no view gave is NaN, and null once the page's JSON carried it.
const ms = (n: number | null) =>
  n === null || Number.isNaN(n)
    ? "–"
    : `${Math.round(n).toLocaleString("en-US")} ms`;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
const ratio = (n: number) => `${n.toFixed(2)}×`;

/** The cells of a row, as the page and the Markdown table show them. */
export function cells(row: Row): string[] {
  return [
    MODE_LABELS[row.mode],
    `${int(row.requests)} (${int(row.requestsOne)} + ${int(row.requestsThree)})${row.stable ? "" : " ⚠ varied"}`,
    `${int(row.hits)} of ${int(row.views)}`,
    int(row.bars),
    kb(row.bytes),
    ms(row.chartP50),
    `${ms(row.hitP50)} · ${ms(row.missP50)}`,
    ms(row.chartP95),
    `${ms(row.coldFirstViewMs)} · ${ms(row.firstViewMs)}`,
    ms(row.workloadMs),
    `${ms(row.coldSetupMs)} · ${ms(row.setupMs)}`,
    int(row.longTasks),
    row.vsNone === undefined
      ? "–"
      : `${ratio(row.vsNone.requests)} requests · ${ratio(row.vsNone.bytes)} bytes`,
  ];
}

export const HEADERS = [
  "Mode",
  "Backend requests (1 tab + 3 tabs)",
  "Views answered without a request",
  "Bars transferred",
  "Bytes",
  "Time to chart p50",
  "p50 without a request · with one",
  "Time to chart p95",
  "First view (run 1 · median)",
  "Workload",
  "First connect (run 1 · median)",
  "Long tasks",
  "vs no cache",
];

/**
 * The time-to-chart sentence every table carries: the p50 is mostly a hit
 * ratio, not a drawing speed.
 */
export const HIT_RATIO_NOTE =
  "The time-to-chart p50 reflects how many views a mode answers from its cache: a view answered without a request draws in about one frame in every mode that has one, as the column beside it shows.";

export function describeConditions(conditions: Conditions): string {
  const runs = `${conditions.runs} run${conditions.runs === 1 ? "" : "s"} per mode`;
  return `Backend latency ${conditions.latencyMs} ms per page · ${runs}, medians shown · ${conditions.browser}`;
}

/** The table as Markdown, with its conditions above it and its note below. */
export function markdown(
  conditions: Conditions,
  table: readonly Row[],
): string {
  const line = (values: readonly string[]) => `| ${values.join(" | ")} |`;
  return [
    describeConditions(conditions),
    "",
    line(HEADERS),
    line(HEADERS.map(() => "---")),
    ...table.map((row) => line(cells(row))),
    "",
    HIT_RATIO_NOTE,
  ].join("\n");
}

/**
 * What the page needs of a fetch report (FetchInsight in the mock backend's
 * insights.ts), kept structural so the script that writes the results file
 * compiles without the browser's types.
 */
export interface FetchReport {
  cacheId: string;
  range: Range;
  pages: number;
  endedAt: number;
  ok: boolean;
}

/** One view of a tab, as the page matches it to the fetch reports. */
export interface ReadView {
  /** The cache id its tab's fetches are reported under (sourceCacheId). */
  cacheId: string;
  range: Range;
  askedAt: number;
  answeredAt: number;
}

/**
 * Whether each view waited for a request: whether a fetch of its cache ended
 * while it was in flight and touched its range, the rule by which the demo
 * pages count a read's fetches (`provenance` in the mock backend's
 * read-insights.ts). A view that joined a fetch already in flight waited
 * for it too.
 */
export function requestedViews(
  views: readonly ReadView[],
  reports: readonly FetchReport[],
): boolean[] {
  return views.map((view) =>
    reports.some(
      (report) =>
        report.ok &&
        report.cacheId === view.cacheId &&
        report.endedAt >= view.askedAt &&
        report.endedAt <= view.answeredAt &&
        report.range.start <= view.range.end &&
        view.range.start <= report.range.end,
    ),
  );
}

/** Backend pages the fetch reports of `cacheIds` account for. */
export function reportedPages(
  reports: readonly FetchReport[],
  cacheIds: ReadonlySet<string>,
): number {
  return reports
    .filter((report) => report.ok && cacheIds.has(report.cacheId))
    .reduce((sum, report) => sum + report.pages, 0);
}

/** What the worker's fetch reports say about one fetch: its cache and worker. */
export interface WorkerReport {
  cacheId: string;
  worker: string;
}

/**
 * Whether every tscache run of one click of Run ran on a worker of its own:
 * each run's cache (`<series>/<nonce>-<run>-tscache`, `nonce` the click's)
 * saw exactly one worker, and no two runs saw the same one. Reports of an
 * earlier click's runs are left out.
 */
export function freshWorkers(
  reports: readonly WorkerReport[],
  nonce: string,
): {
  runs: number;
  workers: number;
  fresh: boolean;
} {
  const byRun = new Map<string, Set<string>>();
  for (const { cacheId, worker } of reports) {
    if (!cacheId.endsWith("-tscache") || !cacheId.includes(`/${nonce}-`)) {
      continue;
    }
    const seen = byRun.get(cacheId) ?? new Set<string>();
    seen.add(worker);
    byRun.set(cacheId, seen);
  }
  const all = new Set([...byRun.values()].flatMap((seen) => [...seen]));
  const onePerRun = [...byRun.values()].every((seen) => seen.size === 1);
  return {
    runs: byRun.size,
    workers: all.size,
    fresh: onePerRun && all.size === byRun.size,
  };
}
