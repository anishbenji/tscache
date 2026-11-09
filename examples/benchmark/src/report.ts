// The benchmark's results: what one run of one mode measured, and the
// table made of every run. Pure, so the page and scripts/demo-bench.ts
// render the same table from the same runs.

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
  /** Time to chart of every view of every tab, in ms. */
  chartMs: number[];
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
  /** Every run made the same requests; the counts are deterministic. */
  stable: boolean;
  bars: number;
  bytes: number;
  chartP50: number;
  chartP95: number;
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

function rowOf(mode: Mode, runs: readonly RunResult[]): Row {
  const of = (f: (r: RunResult) => number) => median(runs.map(f));
  return {
    mode,
    requests: of(total),
    requestsOne: of((r) => r.one.requests),
    requestsThree: of((r) => r.three.requests),
    stable: new Set(runs.map(total)).size <= 1,
    bars: of((r) => r.one.bars + r.three.bars),
    bytes: of((r) => r.one.bytes + r.three.bytes),
    chartP50: of((r) => quantile(r.chartMs, 0.5)),
    chartP95: of((r) => quantile(r.chartMs, 0.95)),
    workloadMs: of((r) => r.workloadMs),
    setupMs: of((r) => r.setupMs),
    coldSetupMs: runs.reduce((first, r) => (r.run < first.run ? r : first))
      .setupMs,
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
const ms = (n: number) => `${Math.round(n).toLocaleString("en-US")} ms`;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
const ratio = (n: number) => `${n.toFixed(2)}×`;

/** The cells of a row, as the page and the Markdown table show them. */
export function cells(row: Row): string[] {
  return [
    MODE_LABELS[row.mode],
    `${int(row.requests)} (${int(row.requestsOne)} + ${int(row.requestsThree)})${row.stable ? "" : " ⚠ varied"}`,
    int(row.bars),
    kb(row.bytes),
    ms(row.chartP50),
    ms(row.chartP95),
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
  "Bars transferred",
  "Bytes",
  "Time to chart p50",
  "Time to chart p95",
  "Workload",
  "First connect (run 1 · median)",
  "Long tasks",
  "vs no cache",
];

export function describeConditions(conditions: Conditions): string {
  const runs = `${conditions.runs} run${conditions.runs === 1 ? "" : "s"} per mode`;
  return `Backend latency ${conditions.latencyMs} ms per page · ${runs}, medians shown · ${conditions.browser}`;
}

/** The table as Markdown, with its conditions above it. */
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
  ].join("\n");
}

/** What the worker's fetch reports say about one fetch: its cache and worker. */
export interface WorkerReport {
  cacheId: string;
  worker: string;
}

/**
 * Whether every tscache run ran on a worker of its own: each run's cache
 * (`<series>/<nonce>-<run>-tscache`) saw exactly one worker, and no two
 * runs saw the same one.
 */
export function freshWorkers(reports: readonly WorkerReport[]): {
  runs: number;
  workers: number;
  fresh: boolean;
} {
  const byRun = new Map<string, Set<string>>();
  for (const { cacheId, worker } of reports) {
    if (!cacheId.endsWith("-tscache")) continue;
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
