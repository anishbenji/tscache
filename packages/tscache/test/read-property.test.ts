import { describe, expect, it } from "vitest";
import { CoverageIndex } from "../src/coverage";
import { collect, read } from "../src/engine/read";
import type { Grid, SlotRange } from "../src/grid";
import type { GetResult, Range } from "../src/types";
import { points, schema, store } from "./merge-test-helpers";

// A small reproducible PRNG; no property-testing dependency is needed.
function randomInt(seed: number): (min: number, max: number) => number {
  let state = seed >>> 0;
  return (min, max) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return min + Math.floor((state / 2 ** 32) * (max - min + 1));
  };
}

function slotsIn(range: SlotRange): number[] {
  const slots: number[] = [];
  for (let slot = range.start; slot <= range.end; slot += 1) slots.push(slot);
  return slots;
}

// The oracle records individual slots, independently of the production
// index's range merge/subtraction and the store's segment layout.
function rangesOf(slots: number[]): Range[] {
  const runs: SlotRange[] = [];
  for (const slot of slots) {
    const last = runs.at(-1);
    if (last !== undefined && last.end === slot - 1) last.end = slot;
    else runs.push({ start: slot, end: slot });
  }
  // Literal grid arithmetic is exact for this small oracle domain; it does
  // not use production msOf/toMs, so omitted offsets are observable.
  return runs.map(({ start, end }) => ({
    start: start * 10 + 3,
    end: end * 10 + 3,
  }));
}

function expandMsRanges(ranges: Range[]): number[] {
  return ranges.flatMap(({ start, end }) =>
    slotsIn({ start: (start - 3) / 10, end: (end - 3) / 10 }),
  );
}

describe("read seeded slot-set properties — architecture §4.1, §4.4, §5, N1, N9, N16", () => {
  it.each([1, 0xc0ffee, 0xdeadbeef])(
    "random indices and requests preserve present rows and tile every requested slot exactly (seed %i)",
    (seed) => {
      const next = randomInt(seed);
      const grid: Grid = { interval: 10, alignmentOffset: 3 };
      const s = store({ gapSplitK: next(1, 4), segmentSlotCap: next(1, 8) });
      const present = new Set(
        slotsIn({ start: -24, end: 24 }).filter(() => next(0, 3) === 0),
      );
      const initial = [...present].sort((a, b) => a - b);
      s.put(
        points(
          initial,
          initial.map((slot) => slot + 0.25),
          initial.map((slot) => slot * 3),
        ),
      );
      const index = new CoverageIndex();
      const authoritative = new Set<number>();

      for (let step = 0; step < 120; step += 1) {
        const start = next(-28, 28);
        const change = { start, end: start + next(0, 8) };
        const operation = next(0, 9);
        if (operation === 0) {
          index.clear();
          authoritative.clear();
        } else if (operation <= 5) {
          index.add(change);
          for (const slot of slotsIn(change)) authoritative.add(slot);
        } else {
          index.subtract(change);
          for (const slot of slotsIn(change)) authoritative.delete(slot);
        }

        const a = next(-32, 32);
        const b = next(-32, 32);
        const request = { start: Math.min(a, b), end: Math.max(a, b) };
        // Avoid the unresolved meaning of "empty request result" with
        // nonempty coverage (§4.4) by keeping one point in every request.
        const anchor = Math.floor((request.start + request.end) / 2);
        present.add(anchor);
        s.put(points([anchor], [anchor + 0.25], [anchor * 3]));

        const requested = slotsIn(request);
        const selected = requested.filter((slot) => present.has(slot));
        const fields = {
          price: new Float64Array(selected.map((slot) => slot + 0.25)),
          volume: new Int16Array(selected.map((slot) => slot * 3)),
        };
        const expectedCoverage = rangesOf(
          requested.filter((slot) => authoritative.has(slot)),
        );
        const expectedGaps = rangesOf(
          requested.filter((slot) => !authoritative.has(slot)),
        );

        expect(collect(s.segments, request, schema)).toEqual({
          slots: new Float64Array(selected),
          fields,
        });
        const result: GetResult = read(
          request,
          s.segments,
          index,
          grid,
          schema,
        );
        expect(result).toEqual({
          timestamps: new Float64Array(selected.map((slot) => slot * 10 + 3)),
          fields,
          coverage: expectedCoverage,
          misses: expectedGaps.map((range) => ({ range, reason: "uncached" })),
        });
        for (const miss of result.misses)
          expect(miss).not.toHaveProperty("error");

        // Exact range assertions above bound expansion. This multiset
        // comparison rejects missing slots, overlaps and double counting.
        const coveredSlots = expandMsRanges(result.coverage);
        const missingSlots = expandMsRanges(
          result.misses.map((miss) => miss.range),
        );
        expect(
          [...coveredSlots, ...missingSlots].sort((x, y) => x - y),
        ).toEqual(requested);
      }
    },
  );
});
