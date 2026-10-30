// Runs the cases in whatever runtime loaded the bench bundle: Bun, Node or
// a Chromium page. scripts/bench.ts builds the bundle with two revisions
// of the engine in it, and calls `tscacheBench` with what to run.

import { type Case, cases, type Impl } from "./cases";
import { checksum, type Op, type Sample, sample } from "./sample";

export interface RunOptions {
  /**
   * smoke: each case once on the head, its result checked.
   * compare: each case, head against base.
   * control: one case, head against a second copy of itself (A/A).
   */
  mode: "smoke" | "compare" | "control";
  /** Only the cases whose name is in this list. */
  only?: string[];
  rounds?: number;
  /** Milliseconds a batch should take, at least (the sampler's default when absent). */
  batchMs?: number;
  /**
   * Calibration: makes the head this fraction slower (0.15 = 15 %), so the
   * gate's detection can be measured on a known regression.
   */
  slowdown?: number;
}

/**
 * `op`, made `fraction` slower, as a real regression would be. How is
 * decided once, from the mean of warm calls (a first, cold call can take
 * a hundred times as long): an operation of 2 ms or more, twenty times
 * Chromium's coarsest clock, then waits that fraction of its own time
 * after each call; a shorter one runs again that often, which over a
 * batch of thousands is the same, and reads no clock, whose cost would be
 * a slowdown of its own (0.17 µs a call in Chromium).
 */
function slowed(op: Op, fraction: number): Op {
  let calls = 0;
  const start = performance.now();
  do {
    op();
    calls++;
  } while (performance.now() - start < 5 && calls < 1000);
  const long = (performance.now() - start) / calls >= 2;
  let owed = 0;
  return () => {
    if (long) {
      const begin = performance.now();
      let value = op();
      const end = performance.now();
      const until = end + (end - begin) * fraction;
      while (performance.now() < until) value += 0;
      return value;
    }
    let value = op();
    owed += fraction;
    while (owed >= 1) {
      value += op() * 0;
      owed -= 1;
    }
    return value;
  };
}

export interface CaseResult {
  name: string;
  what: string;
  /** compare and control. */
  sample?: Sample;
  /** smoke: the value the operation returned, and the one expected. */
  value?: number;
  expected?: number;
}

/** The case the A/A control runs: the most-run operation, a chart's read. */
const CONTROL = "read-viewport";

function selected(all: Case[], options: RunOptions): Case[] {
  if (options.mode === "control") {
    return all.filter((c) => c.name === CONTROL);
  }
  const { only } = options;
  return only === undefined ? all : all.filter((c) => only.includes(c.name));
}

export function runBench(
  impls: { base: Impl; head: Impl; control: Impl },
  options: RunOptions,
): { results: CaseResult[]; checksum: number } {
  const results: CaseResult[] = [];
  for (const c of selected(cases(), options)) {
    if (options.mode === "smoke") {
      const value = c.prepare(impls.head)();
      results.push({ name: c.name, what: c.what, value, expected: c.expect });
      continue;
    }
    const base = c.prepare(
      options.mode === "control" ? impls.control : impls.base,
    );
    const prepared = c.prepare(impls.head);
    const { slowdown } = options;
    const head =
      slowdown === undefined || slowdown === 0
        ? prepared
        : slowed(prepared, slowdown);
    const { rounds, batchMs } = options;
    results.push({
      name: c.name,
      what: c.what,
      sample: sample(base, head, {
        ...(rounds === undefined ? {} : { rounds }),
        ...(batchMs === undefined ? {} : { batchMs }),
      }),
    });
  }
  return { results, checksum: checksum() };
}
