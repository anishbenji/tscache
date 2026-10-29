// The paired sampler: times two implementations of one operation against
// each other in the same process, so what the machine does at the time
// (another job on the runner, the CPU's clock) affects both alike.
//
// Each side is warmed up, then timed in batches long enough for the clock
// (Chromium coarsens performance.now() to 100 µs without cross-origin
// isolation; a 40 ms batch keeps that under 0.3 %). The two sides run in
// rounds, ordered A B, B A, A B…, so neither always runs first, and each
// round gives one ratio, head over base. The result is the median ratio,
// with a distribution-free confidence interval from the order statistics
// of the rounds: no assumption about how the timings are distributed.

/** One operation. It returns a number, which the sampler keeps, so the work cannot be optimised away. */
export type Op = () => number;

export interface SampleOptions {
  /** Rounds, each timing both sides once. Default 20. */
  rounds?: number;
  /** Milliseconds a batch should take, at least. Default 40. */
  batchMs?: number;
  /** Milliseconds each side runs before timing starts. Default 500. */
  warmupMs?: number;
}

export interface Sample {
  /** Head over base, per round, in the order run. */
  ratios: number[];
  /** The median ratio. */
  ratio: number;
  /** The confidence interval of the median, about 95 %. */
  low: number;
  high: number;
  /** Milliseconds per operation, the median of the rounds, per side. */
  baseMs: number;
  headMs: number;
  /** Operations per batch, the same for both sides. */
  batch: number;
}

/** Keeps every result, so no operation's work is dead code. */
let sink = 0;

/** The sink, read after a run so it is live. */
export function checksum(): number {
  return sink;
}

function time(op: Op, n: number): number {
  const start = performance.now();
  let fold = 0;
  for (let i = 0; i < n; i++) fold += op();
  const ms = performance.now() - start;
  sink = (sink + fold) % 1_000_000_007;
  return ms;
}

function run(op: Op, ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) time(op, 1);
}

/** How many operations fill a batch of `ms`, for the slower side. */
function calibrate(a: Op, b: Op, ms: number): number {
  let n = 1;
  for (;;) {
    const slowest = Math.max(time(a, n), time(b, n));
    if (slowest >= ms || n >= 1 << 24) return n;
    n *= slowest < ms / 8 ? 8 : 2;
  }
}

function median(sorted: readonly number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The ranks (1-based) bounding a confidence interval of at least 95 % for
 * the median of `n` samples: the order statistics r and n + 1 − r, with r
 * the largest rank for which P(X < r) ≤ 2.5 %, X ~ Binomial(n, ½) (for
 * n = 20, ranks 6 and 15; for n = 30, 10 and 21).
 */
export function medianRanks(n: number): [number, number] {
  // 0.5 ** n underflows past about a thousand rounds, and below ten
  // there is no 95 % interval to speak of.
  if (!Number.isInteger(n) || n < 10 || n > 1000) {
    throw new RangeError(`rounds must be an integer from 10 to 1000, not ${n}`);
  }
  let below = 0;
  let term = 0.5 ** n;
  let r = 0;
  // Adds P(X = r) = C(n, r) / 2^n while P(X ≤ r) stays within 2.5 %; r
  // ends as the lowest rank inside the interval.
  while (below + term <= 0.025) {
    below += term;
    term = (term * (n - r)) / (r + 1);
    r++;
  }
  return [r, n + 1 - r];
}

/**
 * The sample of paired rounds: one batch of `batch` operations per side
 * per round, in the order run.
 */
export function summarise(
  baseTimes: readonly number[],
  headTimes: readonly number[],
  batch: number,
): Sample {
  const ratios = headTimes.map((b, i) => b / (baseTimes[i] as number));
  const sorted = [...ratios].sort((x, y) => x - y);
  const [lowRank, highRank] = medianRanks(ratios.length);
  return {
    ratios,
    ratio: median(sorted),
    low: sorted[lowRank - 1] as number,
    high: sorted[highRank - 1] as number,
    baseMs: median([...baseTimes].sort((x, y) => x - y)) / batch,
    headMs: median([...headTimes].sort((x, y) => x - y)) / batch,
    batch,
  };
}

/** Times `head` against `base`. Both must do the same work. */
export function sample(
  base: Op,
  head: Op,
  options: SampleOptions = {},
): Sample {
  const rounds = options.rounds ?? 20;
  const batchMs = options.batchMs ?? 40;
  const warmupMs = options.warmupMs ?? 500;
  run(base, warmupMs / 2);
  run(head, warmupMs / 2);
  run(base, warmupMs / 2);
  run(head, warmupMs / 2);
  const n = calibrate(base, head, batchMs);
  const baseTimes: number[] = [];
  const headTimes: number[] = [];
  for (let round = 0; round < rounds; round++) {
    if (round % 2 === 0) {
      baseTimes.push(time(base, n));
      headTimes.push(time(head, n));
    } else {
      headTimes.push(time(head, n));
      baseTimes.push(time(base, n));
    }
  }
  return summarise(baseTimes, headTimes, n);
}

/**
 * An operation that completes later, as a request to a worker does. It
 * returns a number, as `Op` does.
 */
export type AsyncOp = () => Promise<number>;

export interface AsyncSampleOptions extends SampleOptions {
  /**
   * Runs after every batch, outside the timer: resets what the batch left
   * behind (a cache it filled), so the next batch starts as this one did.
   */
  between?: () => Promise<void>;
}

/** Times a batch of `n`, then runs `between`, outside the timer. */
async function timeAsync(
  op: AsyncOp,
  n: number,
  between: () => Promise<void>,
): Promise<number> {
  const start = performance.now();
  let fold = 0;
  for (let i = 0; i < n; i++) fold += await op();
  const ms = performance.now() - start;
  sink = (sink + fold) % 1_000_000_007;
  await between();
  return ms;
}

/** Runs `op` one at a time for `ms`, then `between`. */
async function runAsync(
  op: AsyncOp,
  ms: number,
  between: () => Promise<void>,
): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const value = await op();
    sink = (sink + value) % 1_000_000_007;
  }
  await between();
}

/** `calibrate` for operations that complete later. */
async function calibrateAsync(
  a: AsyncOp,
  b: AsyncOp,
  ms: number,
  between: () => Promise<void>,
): Promise<number> {
  let n = 1;
  for (;;) {
    const first = await timeAsync(a, n, between);
    const slowest = Math.max(first, await timeAsync(b, n, between));
    if (slowest >= ms || n >= 1 << 24) return n;
    n *= slowest < ms / 8 ? 8 : 2;
  }
}

/**
 * `sample` for operations that complete later: the same warm-up, batches
 * and paired rounds, each operation awaited before the next starts.
 */
export async function sampleAsync(
  base: AsyncOp,
  head: AsyncOp,
  options: AsyncSampleOptions = {},
): Promise<Sample> {
  const rounds = options.rounds ?? 20;
  const batchMs = options.batchMs ?? 40;
  const warmupMs = options.warmupMs ?? 500;
  const between = options.between ?? (async () => {});
  for (const op of [base, head, base, head]) {
    await runAsync(op, warmupMs / 2, between);
  }
  const n = await calibrateAsync(base, head, batchMs, between);
  const baseTimes: number[] = [];
  const headTimes: number[] = [];
  for (let round = 0; round < rounds; round++) {
    if (round % 2 === 0) {
      baseTimes.push(await timeAsync(base, n, between));
      headTimes.push(await timeAsync(head, n, between));
    } else {
      headTimes.push(await timeAsync(head, n, between));
      baseTimes.push(await timeAsync(base, n, between));
    }
  }
  return summarise(baseTimes, headTimes, n);
}
