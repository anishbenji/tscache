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
  const ratios: number[] = [];
  const baseTimes: number[] = [];
  const headTimes: number[] = [];
  for (let round = 0; round < rounds; round++) {
    let a: number;
    let b: number;
    if (round % 2 === 0) {
      a = time(base, n);
      b = time(head, n);
    } else {
      b = time(head, n);
      a = time(base, n);
    }
    baseTimes.push(a);
    headTimes.push(b);
    ratios.push(b / a);
  }
  const sorted = [...ratios].sort((x, y) => x - y);
  const [lowRank, highRank] = medianRanks(rounds);
  return {
    ratios,
    ratio: median(sorted),
    low: sorted[lowRank - 1] as number,
    high: sorted[highRank - 1] as number,
    baseMs: median(baseTimes.sort((x, y) => x - y)) / n,
    headMs: median(headTimes.sort((x, y) => x - y)) / n,
    batch: n,
  };
}
