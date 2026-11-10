// How the benchmark page turns its inputs into a run and a run into
// published results. The inputs (the controls, and the URL parameters that
// set them) are parsed once into one validated configuration; a run is one
// explicit state, idle, running, done or failed; and results exist only in
// done, from the run that reached it, carrying its configuration. Pure, so
// the page and scripts/demo-bench.ts validate alike, and so it is tested.

import { isMode, MODES, type Mode } from "./workload";

/** The backend latencies the page offers, in ms per page. */
export const LATENCIES = [50, 300, 1000] as const;
export type Latency = (typeof LATENCIES)[number];
export const DEFAULT_LATENCY: Latency = 300;
export const DEFAULT_RUNS = 5;
/** The most runs per mode the page accepts (its input's maximum). */
export const MAX_RUNS = 20;

/** A run, as validated: nothing else starts one. */
export interface RunConfig {
  latencyMs: Latency;
  runs: number;
  /** The modes to run, in their order, each once. */
  modes: Mode[];
  /** Start as soon as the page is ready (`autorun=1`). */
  autorun: boolean;
}

/**
 * The raw inputs, as strings: a control's value or a URL parameter, null
 * where it is not set (the default then applies). A set but blank value is
 * an error, never a default.
 */
export interface RunInputs {
  latency: string | null;
  runs: string | null;
  modes: string | null;
  autorun: string | null;
}

export type Parsed =
  | { ok: true; config: RunConfig }
  | { ok: false; errors: string[] };

const WHOLE = /^[0-9]+$/;

/** Parses every input, and names each invalid one. */
export function parseRunConfig(inputs: RunInputs): Parsed {
  const errors: string[] = [];

  let latencyMs: Latency = DEFAULT_LATENCY;
  if (inputs.latency !== null) {
    const text = inputs.latency.trim();
    const offered = LATENCIES.find((l) => String(l) === text);
    if (offered === undefined) {
      errors.push(
        `Backend latency must be one of ${LATENCIES.join(", ")} ms, not "${inputs.latency}".`,
      );
    } else {
      latencyMs = offered;
    }
  }

  let runs = DEFAULT_RUNS;
  if (inputs.runs !== null) {
    const text = inputs.runs.trim();
    const n = WHOLE.test(text) ? Number(text) : Number.NaN;
    if (text === "") {
      errors.push("Runs per mode is blank.");
    } else if (!Number.isSafeInteger(n) || n < 1 || n > MAX_RUNS) {
      errors.push(
        `Runs per mode must be a whole number from 1 to ${MAX_RUNS}, not "${inputs.runs}".`,
      );
    } else {
      runs = n;
    }
  }

  let modes: Mode[] = [...MODES];
  if (inputs.modes !== null) {
    const names = inputs.modes.split(",").map((name) => name.trim());
    const unknown = names.filter((name) => !isMode(name));
    if (inputs.modes.trim() === "") {
      errors.push("The modes list is empty.");
    } else if (unknown.length > 0) {
      errors.push(
        `The modes list has ${unknown.map((n) => `"${n}"`).join(", ")}; the modes are ${MODES.join(", ")}.`,
      );
    } else if (new Set(names).size !== names.length) {
      errors.push("The modes list names a mode twice.");
    } else {
      modes = names.filter(isMode);
    }
  }

  if (inputs.autorun !== null && inputs.autorun !== "1") {
    errors.push(`autorun must be 1 when set, not "${inputs.autorun}".`);
  }

  return errors.length > 0
    ? { ok: false, errors }
    : {
        ok: true,
        config: { latencyMs, runs, modes, autorun: inputs.autorun === "1" },
      };
}

/**
 * The page's one run state. Results exist only in `done`, made by the run
 * that reached it; every other state has none.
 */
export type RunState<T> =
  | { kind: "idle" }
  | { kind: "running"; config: RunConfig; progress: string }
  | { kind: "done"; config: RunConfig; results: T }
  | { kind: "failed"; error: string };

/** What the page shows for `state`: the status, Run, and any results. */
export function view<T>(state: RunState<T>): {
  status: string;
  canRun: boolean;
  results: T | undefined;
} {
  switch (state.kind) {
    case "idle":
      return { status: "ready", canRun: true, results: undefined };
    case "running":
      return { status: state.progress, canRun: false, results: undefined };
    case "done":
      return { status: "done", canRun: true, results: state.results };
    case "failed":
      return {
        status: `failed: ${state.error}`,
        canRun: true,
        results: undefined,
      };
  }
}
