// `bun scripts/demo-bench.ts [--latency 50,300,1000] [--runs 5]`: the demo
// hub's benchmark page (examples/benchmark), run headless in Chromium, and
// its results written to docs/benchmarks/demo-comparison.md, the only
// source of any number the README or the docs quote.
//
// It builds the package and the page, serves the page with `vite preview`
// (its mock backend included) on DEMO_BENCH_PORT (default 5390), opens it
// once per latency with `autorun=1`, waits for the table and writes every
// latency's table, with each run's counts below it. It judges no
// result. Its options go through the page's own validation
// (examples/benchmark/src/run.ts) before anything is built. It fails on an
// option the page would reject, when a page does not finish, and on three
// checks of the method: a tscache run that reused a worker, a page whose run
// differs from the validated configuration, and a memo whose request count
// differs from what the workload's ranges allow.
// A heavy job: run it through the machine's heavy-job lock.

import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { arch, cpus, release, type } from "node:os";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "@playwright/test";
import {
  type Conditions,
  type freshWorkers,
  markdown,
  quantile,
  type Row,
  type RunResult,
} from "../examples/benchmark/src/report";
import {
  DEFAULT_RUNS,
  LATENCIES,
  parseRunConfig,
  type RunConfig,
  runQuery,
} from "../examples/benchmark/src/run";
import {
  exactKeyRequests,
  MODE_LABELS,
  type Mode,
  NEW_BARS,
  SCREEN,
  TABS,
  type View,
  workload,
} from "../examples/benchmark/src/workload";
import { Processes } from "./demo/processes";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT = "docs/benchmarks/demo-comparison.md";
/** A latency's whole run, five runs of four modes at 1000 ms included. */
const RUN_TIMEOUT_MS = 30 * 60_000;

interface Results {
  /** The configuration the page ran, as it validated it. */
  config: RunConfig;
  conditions: Conditions;
  /** The end of phase one's newest screen. */
  anchor: number;
  rows: Row[];
  runs: RunResult[];
  /** The check that every tscache run had a SharedWorker of its own. */
  workers: ReturnType<typeof freshWorkers>;
}

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

/**
 * One validated configuration per latency, by the page's own parser
 * (examples/benchmark/src/run.ts): a bad option fails here, before
 * anything is built.
 */
const configs = option("--latency", LATENCIES.join(","))
  .split(",")
  .map((latency) =>
    parseRunConfig({
      latency,
      runs: option("--runs", String(DEFAULT_RUNS)),
      modes: null,
      autorun: "1",
    }),
  );
const invalid = configs.flatMap((parsed) => (parsed.ok ? [] : parsed.errors));
if (invalid.length > 0) {
  throw new Error(`demo-bench: ${[...new Set(invalid)].join(" ")}`);
}
const runConfigs = configs.flatMap((parsed) =>
  parsed.ok ? [parsed.config] : [],
);
const port = Number(process.env.DEMO_BENCH_PORT ?? 5390);
const origin = `http://127.0.0.1:${port}/`;

const processes = new Processes();

async function build(label: string, cmd: string[]): Promise<void> {
  const run = processes.start(cmd, { cwd: ROOT, capture: true });
  if ((await run.exited) !== 0) {
    throw new Error(`${label}: build failed\n${run.output()}`);
  }
  console.log(`built ${label}`);
}

/** Resolves once the preview server answers. */
async function ready(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(250);
  }
  throw new Error(`no answer on ${origin}`);
}

/** The per-run counts under a table: every run is shown, none dropped. */
function runTable(results: RunResult[]): string {
  const line = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
  const headers = [
    "Run",
    "Mode",
    "Requests (1 tab)",
    "Requests (3 tabs)",
    "Views without a request",
    "Bars (1 tab)",
    "Bars (3 tabs)",
    "Time to chart p50 ms",
    "Time to chart p95 ms",
    "First view ms",
    "Workload ms",
  ];
  return [
    line(headers),
    line(headers.map(() => "---")),
    ...results.map((r) =>
      line([
        r.run + 1,
        MODE_LABELS[r.mode],
        r.one.requests,
        r.three.requests,
        `${r.requested.filter((asked) => !asked).length} of ${r.requested.length}`,
        r.one.bars,
        r.three.bars,
        Math.round(quantile(r.chartMs, 0.5)),
        Math.round(quantile(r.chartMs, 0.95)),
        Math.round(r.chartMs[0] ?? Number.NaN),
        Math.round(r.workloadMs),
      ]),
    ),
  ].join("\n");
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** The commit, flagged when the working tree differs from it. */
function commit(): string {
  const dirty = git("status", "--porcelain") !== "";
  return `\`${git("rev-parse", "--short", "HEAD")}\`${dirty ? " (with uncommitted changes)" : ""}`;
}

function machine(): string {
  const cpu = cpus()[0]?.model.trim() ?? "unknown CPU";
  return `${type()} ${release()} (${arch()}), ${cpu}, ${cpus().length} logical cores`;
}

/** The median phase-one bars of `mode` over `results`' runs. */
function barsOne(results: Results, mode: Mode): number {
  const of = results.runs.filter((r) => r.mode === mode).map((r) => r.one.bars);
  return quantile(of, 0.5);
}

const int = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * The Limits item that splits tscache's saving, from the workload and the
 * first latency's measured counts (the counts do not depend on latency).
 * The per-tab exact-key count is the memo's, worked out from the ranges and
 * checked against the measured row; the shared one is a counterfactual.
 */
function savingSplit(results: Results): string {
  const row = (mode: Mode) => results.rows.find((r) => r.mode === mode);
  const none = row("none");
  const memo = row("memo");
  const tscache = row("tscache");
  if (none === undefined || memo === undefined || tscache === undefined) {
    return "- The saving is not split: a run left out no cache, the memo or tscache.";
  }
  const plan = workload(results.anchor);
  const perTab = exactKeyRequests(plan, "per tab");
  const shared = exactKeyRequests(plan, "shared");
  if (perTab.total !== memo.requests) {
    throw new Error(
      `the memo made ${memo.requests} requests; its ranges allow ${perTab.total}`,
    );
  }
  const same = tscache.requestsOne === memo.requestsOne;
  const oneTab = same
    ? `the same ${int(memo.requestsOne)} requests as the memo and TanStack Query`
    : `${int(tscache.requestsOne)} requests, against the memo's and TanStack Query's ${int(memo.requestsOne)}`;
  const views = (list: View[]) => list.length;
  return `- In a single tab (phase one) tscache makes ${oneTab}, and moves fewer
  bars (${int(barsOne(results, "tscache"))} against ${int(barsOne(results, "memo"))}): its zoomed-out view fetches only the bars it lacks. Of
  the ${int(none.requests - tscache.requests)} requests it saves against no cache over both phases (${int(views(plan.one) + TABS * views(plan.three))} views), ${int(none.requests - perTab.total)} are exact
  repeats within a tab, which any cache saves: the memo and TanStack Query save them too. A cache keyed
  by exact range but shared by the tabs, with requests in flight joined, would make ${int(shared.total)} (worked out
  from the ranges; no mode runs it), so ${int(perTab.total - shared.total)} are saved by sharing across tabs. The remaining ${int(shared.total - tscache.requests)}
  are saved because tscache reads the shifted ranges of phase two from the bars it holds and fetches
  only the ${NEW_BARS} new ones.`;
}

/** One latency's section: its table, the worker check and every run. */
function latencySection(results: Results): string {
  return `## Backend latency ${results.conditions.latencyMs} ms

${markdown(results.conditions, results.rows)}

A new SharedWorker for each tscache run, checked from the workers' fetch reports:
${results.workers.runs} runs, ${results.workers.workers} workers, one per run.

<details><summary>Every run</summary>

${runTable(results.runs)}

</details>`;
}

/** The Limits section, with the saving split from the first latency's run. */
function limits(first: Results | undefined): string {
  return `## Limits

- This is TanStack Query keyed by exact range, in memory, per tab. An application can approach
  tscache's request counts by keying aligned chunks and persisting the cache across tabs
  (\`persistQueryClient\` or \`broadcastQueryClient\`), writing chunk assembly and forming-bar refresh
  itself. That configuration is not measured here.
${first === undefined ? "" : `${savingSplit(first)}\n`}- The workload reads settled history only, which favours the exact-key baselines' counts: tscache
  refetches still-forming bars on every read and they do not. With live data, an exact-key cache's key
  for the newest screen changes every minute, a new full fetch, and it can serve a stale forming bar.
  Which way that nets out is not measured.
- The three tabs are iframes on one main thread, so their timings share a thread that real tabs would
  not. Request, bar and byte counts do not depend on it.
- The backend is a mock on the same machine: latency is simulated per page, and bandwidth is not
  limited. Timings vary between machines and runs; the counts do not.`;
}

function document(all: Results[], browser: string): string {
  const generated = new Date().toISOString().slice(0, 16).replace("T", " ");
  const sections = all.map(latencySection);
  return `# Demo benchmark: tscache and three baselines

Generated by \`bun scripts/demo-bench.ts\` from commit ${commit()} on ${generated} UTC, in headless
${browser}, on ${machine()}. This file is the only source of any number quoted in the README or the docs; regenerate it
rather than editing it. The page that runs the benchmark is the demo hub's Benchmark entry
(\`examples/benchmark\`), and its design and fairness rules are in \`docs/reviews/step-67.md\`.

## What runs

One workload, the same for every mode. A chart of one-minute candles opens on the newest screen
(${SCREEN} bars), scrolls back five screens, zooms out to four screens and back in, and returns to the
newest screen: nine views. Then the market moves on by ${NEW_BARS} bars and ${TABS} tabs do the same at once:
the first tab again and two new ones. The tabs are same-origin iframes, so tscache's tabs share one
SharedWorker. Every range is computed from one anchor in yesterday's final history.

- **No cache**: every view fetches its range.
- **${MODE_LABELS.memo}**: a \`Map\` per tab, keyed by the exact range.
- **${MODE_LABELS.tanstack}** (\`@tanstack/query-core\`): one QueryClient per tab, key
  \`[series, start, end]\`, \`staleTime: Infinity\`.
- **tscache**: one client per tab, all on one shared cache.

Every mode fetches with the same fetcher code from the same mock backend and draws with the same uPlot
chart. The fetcher's requests are \`cache: "no-store"\`, like the backend's pages: without it,
Chromium's HTTP cache lock held identical requests made at once from several tabs behind the first,
which roughly doubled the p95 of the modes that make such requests (the baselines) and lengthened their
workload. The comparison is of caching in the application, so all four modes skip the HTTP cache. Each mode of each run starts empty (new tabs, a new tscache cache id and a new SharedWorker), the
backend's counters are read as deltas, and the modes take turns in an order rotated each run. Backend requests, bars and
bytes are what the backend served; time to chart runs from the read's start to the frame after
\`setData\` returned, p50 and p95 over every view of every tab of a run; workload time covers both
phases, tabs opening included. A view is answered without a request when no fetch of its cache ended
while it was in flight (every mode's fetches report through the same fetcher wrapper, and the reports
must account for every page the backend served); a view that joined a fetch already in flight waited
for a request. The p50 is also given for the two kinds of view apart. First view is the time to chart
of the run's first view, the first fetch included; its clock starts once the tab's source is open, so
it leaves out the connect. First connect is opening the first tab's source: for tscache, the client's
connect to the run's new SharedWorker, which loads the fetcher module there; the workload time
includes it. Run 1's first
view and first connect are shown beside the medians. Medians over the runs are shown.

${limits(all[0])}

${sections.join("\n\n")}
`;
}

/**
 * Runs `config` on a new page and returns its results, checked: the page
 * finished, every tscache run had a worker of its own, and the page ran
 * `config` as validated.
 */
async function runLatency(
  browser: Browser,
  config: RunConfig,
): Promise<Results> {
  const latency = config.latencyMs;
  const page = await browser.newPage();
  await page.goto(`${origin}${runQuery(config, { autorun: true })}`);
  const status = page.getByTestId("status");
  await status.filter({ hasText: /^(done|failed)/ }).waitFor({
    timeout: RUN_TIMEOUT_MS,
  });
  const text = await status.textContent();
  if (text !== "done") throw new Error(`latency ${latency}: ${text}`);
  const results = JSON.parse(
    (await page.getByTestId("results-json").textContent()) ?? "",
  ) as Results;
  if (!results.workers.fresh) {
    throw new Error(`latency ${latency}: a tscache run reused a worker`);
  }
  if (JSON.stringify(results.config) !== JSON.stringify(config)) {
    throw new Error(
      `latency ${latency}: the page ran ${JSON.stringify(results.config)}, not ${JSON.stringify(config)}`,
    );
  }
  console.log(`latency ${latency} ms: done`);
  await page.close();
  return results;
}

async function main(): Promise<void> {
  await build("tscache", ["bun", "run", "build"]);
  await build("benchmark", [
    "bun",
    "run",
    "--cwd",
    "examples/benchmark",
    "build",
  ]);
  const server = processes.start(
    [
      "bun",
      "run",
      "--cwd",
      "examples/benchmark",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: ROOT, capture: true },
  );
  void server.exited.then((code) => {
    if (!processes.stopping) {
      console.error(`vite preview exited with ${code}\n${server.output()}`);
    }
  });
  await ready();
  const browser = await chromium.launch();
  try {
    const all: Results[] = [];
    for (const config of runConfigs)
      all.push(await runLatency(browser, config));
    await writeFile(
      new URL(`../${OUTPUT}`, import.meta.url),
      document(all, `Chromium ${browser.version()}`),
    );
    console.log(`wrote ${OUTPUT}`);
  } finally {
    await browser.close();
  }
}

try {
  await main();
} finally {
  await processes.stop();
}
