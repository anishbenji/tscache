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
export type Git = (...args: string[]) => string;

/** The source a trailer accepts: a later change to it voids the trailer. */
const SOURCE = "packages/tscache/src";

/**
 * Whether merge `merge` changes the source beyond merging its parents:
 * a conflict resolved by hand, or an edit made in the merge. Its source
 * is compared with what git's own merge of the parents gives.
 */
function resolvedBy(merge: string, git: Git): boolean {
  const [, ...parents] = git("rev-list", "--parents", "-n", "1", merge).split(
    " ",
  );
  if (parents.length !== 2) return true;
  let merged: string;
  try {
    merged = git("merge-tree", "--write-tree", "--no-messages", ...parents);
  } catch {
    // Conflicts: whatever the merge holds, someone wrote it.
    return true;
  }
  const tree = merged.split("\n")[0] as string;
  return git("diff", "--name-only", tree, merge, "--", SOURCE) !== "";
}

/**
 * What `Perf-Accepted` trailers in base..HEAD allow: per case (optionally
 * `case@runtime`), the highest head/base ratio accepted. A trailer counts
 * only while no later commit of the pull request changes the package's
 * source, so it accepts the code it was written for and not a later
 * change: no later commit that edits it, and no later merge that changes
 * it beyond merging (a resolved conflict). Commits the base brings in (a
 * pull request's merge ref merges in what landed since) do not void it.
 * `ignored` hears of each trailer voided so.
 */
export function acceptances(
  baseSha: string,
  git: Git,
  ignored: (commit: string) => void = () => {},
): Map<string, number> {
  const accepted = new Map<string, number>();
  for (const commit of git("rev-list", `${baseSha}..HEAD`).split("\n")) {
    if (commit === "") continue;
    const found = trailers(git("log", "-1", "--format=%B", commit));
    if (found.length === 0) continue;
    const later = git(
      "rev-list",
      "--no-merges",
      `${commit}..HEAD`,
      "--not",
      baseSha,
      "--",
      SOURCE,
    );
    const merges = git(
      "rev-list",
      "--merges",
      `${commit}..HEAD`,
      "--not",
      baseSha,
    );
    const resolved = merges
      .split("\n")
      .some((merge) => merge !== "" && resolvedBy(merge, git));
    if (later !== "" || resolved) {
      ignored(commit);
      continue;
    }
    for (const [name, ratio] of found) {
      accepted.set(name, Math.max(accepted.get(name) ?? 0, ratio));
    }
  }
  return accepted;
}

/** What a calibration run reports per runtime (.bench-results/*.json). */
export interface CalibrationReport {
  runtime: string;
  noisy: boolean;
  verdicts: Record<string, string>;
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
