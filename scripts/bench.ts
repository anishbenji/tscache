// The benchmarks (docs/benchmarking.md). Runs under Bun.
//
//   bun scripts/bench.ts smoke
//       every case once on the working tree, its result checked; part of
//       `bun run ci`, about a second
//   bun scripts/bench.ts compare [--base <ref>] [--runtime bun,chromium,node]
//                                [--only a,b] [--rounds 20] [--gate]
//                                [--slowdown 0.15]
//       the working tree against a base revision, case by case, in each
//       runtime; prints a table, writes .bench-results/, and with --gate
//       fails on a confirmed regression in Chromium or Bun that no
//       Perf-Accepted trailer allows (Node only reports). --slowdown makes
//       the head that much slower, to calibrate the gate on a known
//       regression; with --base HEAD it measures a same-revision run.
//   bun scripts/bench.ts e2e [--base <ref>] [--only a,b] [--rounds 20]
//   bun scripts/bench.ts e2e --smoke
//       the end-to-end scenarios in Chromium (scripts/bench-e2e.ts): a new
//       tab's first read, a read through a SharedWorker, two tabs sharing a
//       fetch; paired against the base and report-only, or with --smoke
//       each once on the working tree, checked (part of `bun run ci`)
//
// One bundle carries both revisions of the engine: the base's source,
// taken from git (`git archive`, nothing checked out), and the working
// tree's. Each runtime loads it in a fresh process (or a fresh Chromium
// page): Bun stands in for Safari's engine (JSC), Chromium is the V8 that
// most users run, and Node is a second V8 without a browser.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";
import {
  acceptances,
  flagged,
  GATE,
  type Git,
  noisy,
  type Verdict,
  verdictOf,
} from "../packages/tscache/bench/gate";
import type { CaseResult, RunOptions } from "../packages/tscache/bench/run";
import type { Sample } from "../packages/tscache/bench/sample";
import { type E2eResult, runE2e } from "./bench-e2e";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE = join(ROOT, "packages/tscache");
const RESULTS = join(ROOT, ".bench-results");

type Runtime = "bun" | "node" | "chromium";

/**
 * The runtimes whose regressions fail the gate: Chromium (V8, what most
 * users run) and Bun (JSC, the engine of Safari). Node is a second V8 and
 * only reports.
 */
const GATED: ReadonlySet<Runtime> = new Set(["chromium", "bun"]);

interface Args {
  command: "smoke" | "compare" | "e2e";
  base: string;
  runtimes: Runtime[];
  only: string[] | undefined;
  rounds: number;
  gate: boolean;
  slowdown: number | undefined;
  /** e2e: each scenario once on the working tree, checked. */
  smoke: boolean;
}

/** 10 to 1000 rounds (medianRanks): fewer give no 95 % interval. */
function roundsOf(text: string | undefined): number {
  const rounds = Number(text ?? 20);
  if (!Number.isInteger(rounds) || rounds < 10 || rounds > 1000) {
    throw new Error(`--rounds must be an integer from 10 to 1000, not ${text}`);
  }
  return rounds;
}

function parseArgs(argv: string[]): Args {
  const [command = "", ...rest] = argv;
  if (command !== "smoke" && command !== "compare" && command !== "e2e") {
    throw new Error(
      "usage: bun scripts/bench.ts smoke | compare [options] | e2e [options]",
    );
  }
  // The scenarios run in Chromium only and never gate.
  const timingOnly = ["--runtime", "--gate", "--slowdown"];
  const misplaced = timingOnly.filter((flag) => rest.includes(flag));
  if (command === "e2e" && misplaced.length > 0) {
    throw new Error(`e2e takes no ${misplaced.join(", ")}`);
  }
  const value = (flag: string) => {
    const i = rest.indexOf(flag);
    return i === -1 ? undefined : rest[i + 1];
  };
  const slowdown = value("--slowdown");
  return {
    command,
    base: value("--base") ?? process.env.CI_BASE ?? "origin/main",
    runtimes: (value("--runtime") ?? "bun,chromium").split(",") as Runtime[],
    only: value("--only")?.split(","),
    rounds: roundsOf(value("--rounds")),
    gate: rest.includes("--gate"),
    slowdown: slowdown === undefined ? undefined : Number(slowdown),
    smoke: rest.includes("--smoke"),
  };
}

const git: Git = Object.assign(
  (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  },
  {
    lenient: (...args: string[]) =>
      spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }).stdout.trim(),
  },
);

/** The base's `src`, extracted from git into `into`; returns its SHA. */
function extractBase(ref: string, into: string): string {
  const sha = git("rev-parse", "--verify", `${ref}^{commit}`);
  const archive = spawnSync(
    "sh",
    ["-c", `git archive ${sha} packages/tscache/src | tar -x -C "${into}"`],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (archive.status !== 0) throw new Error(archive.stderr);
  return sha;
}

/**
 * Builds the bench bundle with `base` and `head` as the two revisions, and a
 * copy of the head's source as the control's (a separate path, so the
 * bundler keeps it a separate copy of the code).
 */
async function bundle(baseSrc: string, headSrc: string, out: string) {
  const controlSrc = join(out, "..", "control-src");
  cpSync(headSrc, controlSrc, { recursive: true });
  const sources = { base: baseSrc, head: headSrc, control: controlSrc };
  const revisions: BunPlugin = {
    name: "tscache-bench-revisions",
    setup(build) {
      build.onResolve(
        { filter: /^tscache-bench:(base|head|control)$/ },
        ({ path }) => {
          const which = path.slice("tscache-bench:".length);
          const src = sources[which as keyof typeof sources];
          return { path: join(src, "entries/engine.ts") };
        },
      );
    },
  };
  const result = await Bun.build({
    entrypoints: [join(PACKAGE, "bench/entry.ts")],
    target: "browser",
    format: "iife",
    plugins: [revisions],
  });
  const output = result.success ? result.outputs[0] : undefined;
  if (output === undefined) {
    throw new AggregateError(result.logs, "bench build failed");
  }
  writeFileSync(out, await output.text());
}

/** Loads the bundle in a fresh Bun or Node process and runs `options`. */
function runProcess(
  runtime: "bun" | "node",
  bundlePath: string,
  options: RunOptions,
): CaseResult[] {
  const runner = `
    const { readFileSync } = require("node:fs");
    (0, eval)(readFileSync(${JSON.stringify(bundlePath)}, "utf8"));
    process.stdout.write(JSON.stringify(globalThis.tscacheBench(${JSON.stringify(options)})));`;
  const result = spawnSync(runtime, ["-e", runner], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${runtime} bench failed:\n${result.stderr}`);
  }
  return (JSON.parse(result.stdout) as { results: CaseResult[] }).results;
}

/** Loads the bundle in a fresh Chromium page and runs `options`. */
async function runChromium(
  bundlePath: string,
  options: RunOptions,
): Promise<CaseResult[]> {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(0);
    await page.addScriptTag({ path: bundlePath });
    const out = await page.evaluate(
      (o) =>
        (
          globalThis as unknown as {
            tscacheBench(o: unknown): { results: unknown };
          }
        ).tscacheBench(o),
      options as unknown as Record<string, unknown>,
    );
    return (out as { results: CaseResult[] }).results;
  } finally {
    await browser.close();
  }
}

async function run(
  runtime: Runtime,
  bundlePath: string,
  options: RunOptions,
): Promise<CaseResult[]> {
  return runtime === "chromium"
    ? runChromium(bundlePath, options)
    : runProcess(runtime, bundlePath, options);
}

/** What one runtime measured and decided. */
interface RuntimeReport {
  runtime: Runtime;
  control: CaseResult | undefined;
  results: CaseResult[];
  confirmed: CaseResult[];
  verdicts: Record<string, Verdict>;
  noisy: boolean;
  /** Regressions that fail the gate here. */
  failures: number;
}

interface Comparison {
  args: Args;
  bundlePath: string;
  accepted: Map<string, number>;
}

/** Times every case in `runtime`, confirms what is flagged, and decides. */
async function measure(
  runtime: Runtime,
  { args, bundlePath, accepted }: Comparison,
): Promise<RuntimeReport> {
  const options = (rounds: number, only?: string[]): RunOptions => ({
    mode: "compare",
    rounds,
    ...(only === undefined ? {} : { only }),
    ...(args.slowdown === undefined ? {} : { slowdown: args.slowdown }),
  });
  const control = (
    await run(runtime, bundlePath, { mode: "control", rounds: args.rounds })
  )[0];
  const results = await run(
    runtime,
    bundlePath,
    options(args.rounds, args.only),
  );
  // Each flagged case again, in a fresh process, with more rounds.
  const suspects = results.filter((r) => flagged(r.sample)).map((r) => r.name);
  const confirmed =
    suspects.length === 0
      ? []
      : await run(runtime, bundlePath, options(GATE.confirmRounds, suspects));
  const again = new Map(confirmed.map((r) => [r.name, r.sample]));
  const quiet = !noisy(control?.sample);
  const gated = quiet && GATED.has(runtime);
  const verdicts: Record<string, Verdict> = {};
  for (const { name, sample } of results) {
    if (sample === undefined) continue;
    const allowed = accepted.get(`${name}@${runtime}`) ?? accepted.get(name);
    verdicts[name] = verdictOf(sample, again.get(name), allowed);
  }
  const regressions = Object.values(verdicts).filter((v) => v === "regression");
  return {
    runtime,
    control,
    results,
    confirmed,
    verdicts,
    noisy: !quiet,
    failures: gated ? regressions.length : 0,
  };
}

const ms = (value: number) =>
  value >= 1 ? `${value.toFixed(2)} ms` : `${(value * 1000).toFixed(1)} µs`;

const interval = (s: Sample | undefined) =>
  s === undefined
    ? "–"
    : `${s.ratio.toFixed(3)} [${s.low.toFixed(3)}, ${s.high.toFixed(3)}]`;

function row(name: string, s: Sample, verdict: Verdict | undefined): string {
  const cells = [
    `\`${name}\``,
    ms(s.baseMs),
    ms(s.headMs),
    s.ratio.toFixed(3),
    `${s.low.toFixed(3)}–${s.high.toFixed(3)}`,
    verdict ?? "",
  ];
  return `| ${cells.join(" | ")} |`;
}

function render(report: RuntimeReport): string[] {
  const reported = GATED.has(report.runtime) ? "" : " (reported, never gated)";
  const noise = report.noisy
    ? " (noisy: the A/A control left its bounds, nothing fails)"
    : "";
  const rows = report.results.flatMap(({ name, sample }) =>
    sample === undefined ? [] : [row(name, sample, report.verdicts[name])],
  );
  return [
    `#### ${report.runtime}${reported}${noise}`,
    "",
    `A/A control (\`${report.control?.name}\`): ${interval(report.control?.sample)}`,
    "",
    "| Case | Base | Head | Head/base | 95 % CI | |",
    "|---|---:|---:|---:|---:|---|",
    ...rows,
    "",
  ];
}

function publish(summary: string, file = "summary.md"): void {
  console.log(summary);
  writeFileSync(join(RESULTS, file), `${summary}\n`);
  const step = process.env.GITHUB_STEP_SUMMARY;
  if (step) appendFileSync(step, `${summary}\n`);
}

async function compare(args: Args): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), "tscache-bench-"));
  const baseSha = extractBase(args.base, work);
  const headSha = git("rev-parse", "HEAD");
  const bundlePath = join(work, "bench.js");
  const baseSrc = join(work, "packages/tscache/src");
  await bundle(baseSrc, join(PACKAGE, "src"), bundlePath);
  const accepted = acceptances(baseSha, git, (commit) =>
    console.warn(
      `Perf-Accepted in ${commit.slice(0, 9)} ignored: the source changed after it.`,
    ),
  );
  const comparison = { args, bundlePath, accepted };
  mkdirSync(RESULTS, { recursive: true });

  const lines = [
    `### Benchmarks: \`${headSha.slice(0, 9)}\` against \`${baseSha.slice(0, 9)}\` (${args.base})`,
    "",
  ];
  let failures = 0;
  for (const runtime of args.runtimes) {
    const report = await measure(runtime, comparison);
    failures += report.failures;
    const record = {
      schema: 1,
      base: baseSha,
      head: headSha,
      gate: GATE,
      ...report,
    };
    const file = join(RESULTS, `${runtime}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    lines.push(...render(report));
  }
  publish(lines.join("\n"));
  if (failures > 0) {
    console.error(
      `\n${failures} confirmed regression(s). If deliberate, add a trailer to a commit of the pull request: Perf-Accepted: <case> <max ratio> <reason> (docs/benchmarking.md).`,
    );
  }
  return args.gate && failures > 0 ? 1 : 0;
}

async function smoke(): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), "tscache-bench-"));
  const bundlePath = join(work, "bench.js");
  const src = join(PACKAGE, "src");
  await bundle(src, src, bundlePath);
  return checks(runProcess("bun", bundlePath, { mode: "smoke" }));
}

function checks(results: (CaseResult & { ms?: number })[]): number {
  for (const { name, value, expected, ms: time } of results) {
    const note = value === expected ? "ok  " : "FAIL";
    const took = time === undefined ? "" : `, ${ms(time)}`;
    console.log(`${note} ${name}: ${value} (expected ${expected})${took}`);
  }
  return results.every((r) => r.value === r.expected) ? 0 : 1;
}

/**
 * The end-to-end scenarios in Chromium, paired against the base and
 * reported, or with --smoke each once, checked. Never fails on a timing;
 * a wrong result or a fetch too many throws.
 */
async function e2e(args: Args): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), "tscache-bench-"));
  const headSrc = join(PACKAGE, "src");
  const run = { headSrc, work, rounds: args.rounds, only: args.only };
  if (args.smoke) return checks(await runE2e({ ...run, baseSrc: undefined }));
  const baseSha = extractBase(args.base, work);
  const headSha = git("rev-parse", "HEAD");
  const baseSrc = join(work, "packages/tscache/src");
  const results: E2eResult[] = await runE2e({ ...run, baseSrc });
  mkdirSync(RESULTS, { recursive: true });
  const record = { schema: 1, base: baseSha, head: headSha, results };
  const file = join(RESULTS, "e2e.json");
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  const rows = results.flatMap(({ name, sample }) =>
    sample === undefined ? [] : [row(name, sample, undefined)],
  );
  const lines = [
    `### End-to-end scenarios, Chromium: \`${headSha.slice(0, 9)}\` against \`${baseSha.slice(0, 9)}\` (${args.base})`,
    "",
    "Report-only: no timing here fails a pull request (docs/benchmarking.md).",
    "",
    "| Scenario | Base | Head | Head/base | 95 % CI | |",
    "|---|---:|---:|---:|---:|---|",
    ...rows,
    "",
  ];
  publish(lines.join("\n"), "e2e-summary.md");
  return 0;
}

const args = parseArgs(process.argv.slice(2));
const commands = { smoke, compare, e2e } as const;
process.exit(await commands[args.command](args));
