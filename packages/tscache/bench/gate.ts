// What the timing gate decides, apart from running anything: whether a
// sample is a regression, whether the A/A control was quiet, and what a
// Perf-Accepted trailer allows (docs/benchmarking.md, "The gate").
//
// The thresholds are where three independent designs converged
// (docs/benchmarking.md). Measured on an Apple Silicon machine with a known
// regression injected, a median ratio of 1.10 with the interval's low end
// at 1.03, confirmed in a fresh process, caught 29 of 30 runs at +15 % and
// all at +25 % in one design's experiment, and 76–100 % at +15 % per
// runtime in another's, and fired in no same-revision run of either. A
// calibration on the CI runner decides whether they block.

import type { Sample } from "./sample";

export const GATE = {
  /** The median head/base ratio at or above which a case is flagged. */
  ratio: 1.1,
  /** The confidence interval's lower bound must clear this too. */
  low: 1.03,
  /**
   * And the head must be slower by at least this much per operation:
   * 0.25 µs, so a 3 µs read still fails at +10 %.
   */
  floorMs: 0.00025,
  /** A flagged case is timed again, in a fresh process, with more rounds. */
  confirmRounds: 30,
  /** The A/A control's interval must lie inside this, or the run is noisy. */
  control: [0.95, 1.05] as const,
};

/**
 * ok: within the gate. faster: clearly faster. flagged: over the gate once,
 * not confirmed. regression: over it twice. accepted: a regression a
 * Perf-Accepted trailer allows.
 */
export type Verdict = "ok" | "faster" | "flagged" | "regression" | "accepted";

/** Whether `sample` is over the gate: slower by ratio, interval and time. */
export function flagged(sample: Sample | undefined): boolean {
  if (sample === undefined) return false;
  return (
    sample.ratio >= GATE.ratio &&
    sample.low >= GATE.low &&
    sample.headMs - sample.baseMs >= GATE.floorMs
  );
}

/** Whether the A/A control left its bounds: then nothing fails. */
export function noisy(control: Sample | undefined): boolean {
  if (control === undefined) return true;
  return control.low < GATE.control[0] || control.high > GATE.control[1];
}

/**
 * The verdict on one case: its first sample, its confirmation in a fresh
 * process (when the first was flagged), and the ratio a trailer allows.
 */
export function verdictOf(
  first: Sample,
  confirmation: Sample | undefined,
  allowed: number | undefined,
): Verdict {
  if (!flagged(first)) return first.high <= 1 / GATE.ratio ? "faster" : "ok";
  if (!flagged(confirmation)) return "flagged";
  const { ratio } = confirmation as Sample;
  return allowed !== undefined && ratio <= allowed ? "accepted" : "regression";
}

/**
 * The `Perf-Accepted: <case>[@<runtime>] <max ratio> <reason>` trailers of
 * one commit message, as [case, ratio] pairs.
 */
export function trailers(message: string): [string, number][] {
  return [
    ...message.matchAll(/^Perf-Accepted:\s*(\S+)\s+(\d+(?:\.\d+)?)\b/gm),
  ].map(([, name, ratio]) => [name as string, Number(ratio)]);
}

/** Runs git with these arguments and returns its trimmed output. */
export interface Git {
  /** Throws when git exits with a failure. */
  (...args: string[]): string;
  /** Returns the output whatever the exit status (merge-tree's conflicts). */
  lenient(...args: string[]): string;
}

/** The source a trailer accepts: a later change to it voids the trailer. */
const SOURCE = "packages/tscache/src";

/**
 * Whether the head's source is what `commit` accepted: the source of
 * `commit`, merged as git would merge it on its own with the newest base
 * revision the head contains. Anything else in the head's source is a
 * later change: a later edit, a conflict resolved by hand (git's own merge
 * leaves markers there), a branch other than the base merged in. What
 * the base brings in is not (GitHub's merge ref merges in what landed on
 * main since), and neither is anything outside the source.
 */
function stillAccepted(commit: string, baseSha: string, git: Git): boolean {
  const base = git("merge-base", baseSha, "HEAD");
  const merged = git.lenient(
    "merge-tree",
    "--write-tree",
    "--no-messages",
    commit,
    base,
  );
  const tree = merged.split("\n")[0] ?? "";
  if (!/^[0-9a-f]{40,64}$/.test(tree)) return false;
  return git("diff", "--name-only", tree, "HEAD", "--", SOURCE) === "";
}

/**
 * What `Perf-Accepted` trailers in base..HEAD allow: per case (optionally
 * `case@runtime`), the highest head/base ratio accepted, from the trailers
 * that still accept the head's source (stillAccepted). The working tree's
 * source is what gets benchmarked, so any uncommitted change to it (staged,
 * unstaged or untracked) voids them all. `ignored` hears of each trailer a
 * later change voided.
 */
export function acceptances(
  baseSha: string,
  git: Git,
  ignored: (commit: string) => void = () => {},
): Map<string, number> {
  const accepted = new Map<string, number>();
  const uncommitted =
    git("status", "--porcelain", "--untracked-files=all", "--", SOURCE) !== "";
  for (const commit of git("rev-list", `${baseSha}..HEAD`).split("\n")) {
    if (commit === "") continue;
    const found = trailers(git("log", "-1", "--format=%B", commit));
    if (found.length === 0) continue;
    if (uncommitted || !stillAccepted(commit, baseSha, git)) {
      ignored(commit);
      continue;
    }
    for (const [name, ratio] of found) {
      accepted.set(name, Math.max(accepted.get(name) ?? 0, ratio));
    }
  }
  return accepted;
}

/**
 * The runtimes whose cases may gate: Chromium (V8, what most users run) and
 * Bun (JSC, the engine of Safari). Node is a second V8 and only reports.
 */
const GATEABLE: ReadonlySet<string> = new Set(["bun", "chromium"]);

/** Per runtime, the cases whose confirmed regression fails the gate. */
export type GatedCases = ReadonlyMap<string, readonly string[]>;

/**
 * The cases `bench/gated.json` gates, per runtime: those calibration on
 * GitHub's runner showed the gate judges reliably (docs/benchmarking.md).
 * Throws on anything but `{ "<bun|chromium>": ["<case>", …] }`.
 */
export function gatedCases(json: unknown): GatedCases {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("gated.json must map runtimes to lists of case names");
  }
  const gated = new Map<string, readonly string[]>();
  for (const [runtime, names] of Object.entries(json)) {
    if (!GATEABLE.has(runtime)) {
      throw new Error(
        `gated.json: ${runtime} cannot gate, only bun and chromium`,
      );
    }
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
      throw new Error(`gated.json: ${runtime} must list case names`);
    }
    if (new Set(names).size !== names.length) {
      throw new Error(`gated.json: ${runtime} lists a case twice`);
    }
    gated.set(runtime, names as string[]);
  }
  return gated;
}

/** What one runtime reports per run (.bench-results/*.json). */
export interface CalibrationReport {
  runtime: string;
  noisy: boolean;
  verdicts: Record<string, string>;
}

/**
 * The cases whose regression fails the gate in `report`: confirmed
 * regressions of the cases `gated` lists for its runtime, none when the
 * A/A control was noisy. Every other regression only reports.
 */
export function failing(
  report: CalibrationReport,
  gated: GatedCases,
): string[] {
  if (report.noisy) return [];
  const cases = gated.get(report.runtime) ?? [];
  return Object.entries(report.verdicts)
    .filter(
      ([name, verdict]) => verdict === "regression" && cases.includes(name),
    )
    .map(([name]) => name);
}

export interface CalibrationTally {
  /** runtime → case → [runs the gate fired in, quiet runs]. */
  cases: Map<string, Map<string, [number, number]>>;
  /** runtime → noisy runs, left out of the counts: nothing fails in them. */
  noisy: Map<string, number>;
}

/** Counts, per runtime and case, the quiet runs the gate fired in. */
export function tallyCalibration(
  reports: readonly CalibrationReport[],
): CalibrationTally {
  const cases = new Map<string, Map<string, [number, number]>>();
  const noisy = new Map<string, number>();
  for (const report of reports) {
    if (report.noisy) {
      noisy.set(report.runtime, (noisy.get(report.runtime) ?? 0) + 1);
      continue;
    }
    const counts = cases.get(report.runtime) ?? new Map();
    cases.set(report.runtime, counts);
    for (const [name, verdict] of Object.entries(report.verdicts)) {
      const [fired, runs] = counts.get(name) ?? [0, 0];
      counts.set(name, [fired + (verdict === "regression" ? 1 : 0), runs + 1]);
    }
  }
  return { cases, noisy };
}
