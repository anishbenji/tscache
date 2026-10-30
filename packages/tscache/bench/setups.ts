// The bench setups that `bench.ts compare --setup <name>` can run, from the
// Chromium noise experiment (docs/benchmarking.md, "Calibration log"): each
// changes how Chromium is launched or how long it is timed, so a
// calibration dispatch can measure whether the A/A control stays quiet on
// GitHub's runner. `default` is what every run uses unless told otherwise:
// 30 rounds of 100 ms batches, the setup that kept the control quiet in 19
// of 20 runs there. The others are kept so the experiment can be rerun.

export interface BenchSetup {
  /** Extra command-line switches for Chromium, after Playwright's own. */
  chromiumArgs: readonly string[];
  /** Milliseconds a batch should take, at least (the sampler's default when absent). */
  batchMs?: number;
  /** Rounds when `--rounds` is not given (the bench's default when absent). */
  rounds?: number;
}

/**
 * Stop Chromium from lowering the priority of a page it considers in the
 * background: a headless page has no visible window, and its renderer and
 * timers may be deprioritised.
 */
const UNTHROTTLED: readonly string[] = [
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
];

/** One renderer process, so fewer processes share the runner's two vCPUs. */
const ONE_RENDERER: readonly string[] = ["--renderer-process-limit=1"];

/** Batches of 100 ms rather than the sampler's 40, and 30 rounds rather than 20. */
const LONG_BATCHES = { batchMs: 100, rounds: 30 };

type SetupName =
  | "default"
  | "short-batches"
  | "unthrottled"
  | "one-renderer"
  | "combined";

/**
 * `unthrottled` and `one-renderer` time as the experiment ran them, with
 * the sampler's 40 ms batches and 20 rounds.
 */
export const SETUPS: Readonly<Record<SetupName, BenchSetup>> = {
  default: { chromiumArgs: [], ...LONG_BATCHES },
  "short-batches": { chromiumArgs: [], batchMs: 40, rounds: 20 },
  unthrottled: { chromiumArgs: UNTHROTTLED },
  "one-renderer": { chromiumArgs: ONE_RENDERER },
  combined: {
    chromiumArgs: [...UNTHROTTLED, ...ONE_RENDERER],
    ...LONG_BATCHES,
  },
};

/** The setup called `name`; throws on a name it does not know. */
export function setupOf(name: string): BenchSetup {
  if (!Object.hasOwn(SETUPS, name)) {
    const known = Object.keys(SETUPS).join(", ");
    throw new Error(`--setup must be one of ${known}, not ${name}`);
  }
  return SETUPS[name as SetupName];
}
