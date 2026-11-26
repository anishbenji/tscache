import { describe, expect, it } from "vitest";
import { includeRange } from "../src/engine/cache";
import type { SlotRange } from "../src/grid";
import { rng } from "./cache-model";

// The reader change's range lists (M7, architecture §4.6): `includeRange`
// merges a range into an ascending, disjoint list with no two adjacent
// ranges. Security lane S1.1 (step 114): it scanned from the front for
// every range, so a call collecting n ranges cost O(n²). These tests pin
// its result against that scan and count its work, never its time.

const env = (globalThis as { process?: { env: Record<string, string> } })
  .process?.env;
/**
 * The O(log n) test's timeout: 30 s (its comment gives the numbers), or the
 * mutation run's own, higher timeout, which vitest.mutation.config.ts sets
 * as TSCACHE_TEST_TIMEOUT and this one must not undercut.
 */
const scanTimeout = Math.max(30_000, Number(env?.TSCACHE_TEST_TIMEOUT ?? 0));

/** The scan `includeRange` replaced, kept as the reference result. */
function reference(list: SlotRange[], range: SlotRange): void {
  let first = 0;
  while (
    first < list.length &&
    (list[first] as SlotRange).end < range.start - 1
  ) {
    first++;
  }
  let { start, end } = range;
  let next = first;
  for (; next < list.length; next++) {
    const existing = list[next] as SlotRange;
    if (existing.start > end + 1) break;
    start = Math.min(start, existing.start);
    end = Math.max(end, existing.end);
  }
  list.splice(first, next - first, { start, end });
}

/** Ascending, disjoint, and no two ranges adjacent. */
function wellFormed(list: SlotRange[]): void {
  for (let i = 0; i < list.length; i++) {
    const range = list[i] as SlotRange;
    expect(range.start).toBeLessThanOrEqual(range.end);
    if (i > 0) {
      expect((list[i - 1] as SlotRange).end + 1).toBeLessThan(range.start);
    }
  }
}

type Order = "ascending" | "descending" | "random" | "touching" | "overlapping";

/** A sequence of ranges in one of the orders a test exercises. */
function sequence(seed: number, order: Order, n: number): SlotRange[] {
  const r = rng(seed);
  const ranges: SlotRange[] = [];
  let at = r.int(-50, 50);
  for (let i = 0; i < n; i++) {
    const length = r.int(0, 6);
    switch (order) {
      case "ascending":
        at += r.int(0, 8);
        break;
      case "descending":
        at -= r.int(length, length + 8);
        break;
      case "touching":
        // Starts right after the last end, or right at it.
        at += r.int(0, 1);
        break;
      case "overlapping":
        at += r.int(-4, 3);
        break;
      default:
        at = r.int(-200, 200);
    }
    ranges.push({ start: at, end: at + length });
    if (order === "ascending" || order === "touching") at += length + 1;
  }
  return ranges;
}

describe("includeRange", () => {
  const orders: Order[] = [
    "ascending",
    "descending",
    "random",
    "touching",
    "overlapping",
  ];
  const seeds = [1, 7, 42, 114, 2026, 65537, 0x7fffffff];

  for (const order of orders) {
    it.each(seeds)(
      `gives the scan's result for ${order} ranges, seed=%i`,
      (seed) => {
        const ranges = sequence(seed, order, 300);
        const got: SlotRange[] = [];
        const want: SlotRange[] = [];
        for (const [step, range] of ranges.entries()) {
          includeRange(got, range);
          reference(want, range);
          expect(got, `step ${step}`).toEqual(want);
        }
        wellFormed(got);
      },
    );
  }

  it("a mix of the orders, interleaved, gives the scan's result", () => {
    const r = rng(9);
    const got: SlotRange[] = [];
    const want: SlotRange[] = [];
    for (let i = 0; i < 40; i++) {
      for (const range of sequence(r.int(1, 1e6), r.pick(orders), 25)) {
        includeRange(got, range);
        reference(want, range);
      }
      expect(got).toEqual(want);
    }
    wellFormed(got);
  });

  it(
    "reads O(log n) list entries per range when collecting ascending ranges",
    () => {
      const n = 4096;
      let reads = 0;
      const counted = (list: SlotRange[]) =>
        new Proxy(list, {
          get(target, key, receiver) {
            if (typeof key === "string" && /^\d+$/.test(key)) reads++;
            return Reflect.get(target, key, receiver);
          },
        });
      const list = counted([]);
      for (let i = 0; i < n; i++)
        includeRange(list, { start: 3 * i, end: 3 * i });
      expect(list).toHaveLength(n);
      // log2(4096) = 12 probes, plus the look past the end: far below the
      // n²/2 ≈ 8.4 million reads the scan took.
      expect(reads).toBeLessThanOrEqual(n * 14);

      reads = 0;
      const scanned = counted([]);
      for (let i = 0; i < n; i++)
        reference(scanned, { start: 3 * i, end: 3 * i });
      // The control: the scan reads every entry before the end, n(n-1)/2 in
      // all.
      expect(reads).toBeGreaterThanOrEqual((n * (n - 1)) / 2);
      // The control's quadratic scan through a Proxy is the cost this test
      // checks, on the CPU with no waits, so its time grows with the
      // machine's load and Vitest's default 5 s was crossed under load.
      // Measured in a full Vitest run (step 154, docs/reviews/step-154.md):
      // 2.3 s at load 6, 6.4 s to 9.0 s with a second full run beside it
      // (load 34 and 68), and 6.4 s to 16.4 s in loaded pre-push runs on
      // 2026-11-25. 30 s is about twice that worst case. The test is
      // synchronous, so Vitest reports a timeout when it returns rather than
      // interrupting it.
    },
    scanTimeout,
  );
});
