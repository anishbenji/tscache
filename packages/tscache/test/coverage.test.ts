import { describe, expect, it } from "vitest";
import { CoverageIndex } from "../src/coverage";

// Structural §4.1 input type; tests do not require a type re-export.
type SlotRange = { start: number; end: number };

function indexWith(ranges: SlotRange[]): CoverageIndex {
  const index = new CoverageIndex();
  for (const range of ranges) index.add({ ...range });
  return index;
}

describe("CoverageIndex.add — authoritative inclusive slot ranges", () => {
  it("starts empty and records a range without requiring data points", () => {
    const index = new CoverageIndex();
    expect(index.ranges()).toEqual([]);
    expect(index.covered({ start: -2, end: 2 })).toEqual([]);
    expect(index.gaps({ start: -2, end: 2 })).toEqual([{ start: -2, end: 2 }]);
    index.add({ start: -2, end: 2 });
    expect(index.ranges()).toEqual([{ start: -2, end: 2 }]);
    expect(index.covered({ start: -2, end: 2 })).toEqual([
      { start: -2, end: 2 },
    ]);
    expect(index.gaps({ start: -2, end: 2 })).toEqual([]);
  });

  it("records start === end as one covered slot", () => {
    const index = indexWith([{ start: -3, end: -3 }]);
    expect(index.ranges()).toEqual([{ start: -3, end: -3 }]);
    expect(index.covered({ start: -3, end: -3 })).toEqual([
      { start: -3, end: -3 },
    ]);
    expect(index.gaps({ start: -3, end: -3 })).toEqual([]);
  });

  it.each([
    {
      name: "adjacent ranges",
      initial: [{ start: 1, end: 3 }],
      added: { start: 4, end: 6 },
      expected: [{ start: 1, end: 6 }],
    },
    {
      name: "adjacency on the left",
      initial: [{ start: 4, end: 6 }],
      added: { start: 1, end: 3 },
      expected: [{ start: 1, end: 6 }],
    },
    {
      name: "touching inclusive endpoints",
      initial: [{ start: 1, end: 3 }],
      added: { start: 3, end: 6 },
      expected: [{ start: 1, end: 6 }],
    },
    {
      name: "touching on the left",
      initial: [{ start: 3, end: 6 }],
      added: { start: 1, end: 3 },
      expected: [{ start: 1, end: 6 }],
    },
    {
      name: "overlapping ranges",
      initial: [{ start: 1, end: 4 }],
      added: { start: 2, end: 6 },
      expected: [{ start: 1, end: 6 }],
    },
    {
      name: "a nested addition",
      initial: [{ start: 1, end: 6 }],
      added: { start: 2, end: 4 },
      expected: [{ start: 1, end: 6 }],
    },
    {
      name: "an enclosing addition",
      initial: [{ start: 2, end: 4 }],
      added: { start: 1, end: 6 },
      expected: [{ start: 1, end: 6 }],
    },
    {
      name: "a repeated range",
      initial: [{ start: 1, end: 6 }],
      added: { start: 1, end: 6 },
      expected: [{ start: 1, end: 6 }],
    },
    {
      name: "one uncovered slot between ranges",
      initial: [{ start: 1, end: 3 }],
      added: { start: 5, end: 6 },
      expected: [
        { start: 1, end: 3 },
        { start: 5, end: 6 },
      ],
    },
    {
      name: "one uncovered slot on the left",
      initial: [{ start: 5, end: 6 }],
      added: { start: 1, end: 3 },
      expected: [
        { start: 1, end: 3 },
        { start: 5, end: 6 },
      ],
    },
    {
      name: "adjacent single slots",
      initial: [{ start: 0, end: 0 }],
      added: { start: 1, end: 1 },
      expected: [{ start: 0, end: 1 }],
    },
    {
      name: "a single slot bridging two ranges",
      initial: [
        { start: -3, end: -1 },
        { start: 1, end: 3 },
      ],
      added: { start: 0, end: 0 },
      expected: [{ start: -3, end: 3 }],
    },
    {
      name: "an addition spanning multiple ranges",
      initial: [
        { start: -8, end: -6 },
        { start: -3, end: -1 },
        { start: 2, end: 4 },
      ],
      added: { start: -6, end: 2 },
      expected: [{ start: -8, end: 4 }],
    },
  ])("normalizes $name", ({ initial, added, expected }) => {
    const index = indexWith(initial);
    index.add(added);
    expect(index.ranges()).toEqual(expected);
  });

  it("sorts ranges added out of order, including an insertion in the middle", () => {
    const index = indexWith([
      { start: 10, end: 12 },
      { start: -5, end: -3 },
      { start: 2, end: 4 },
    ]);
    expect(index.ranges()).toEqual([
      { start: -5, end: -3 },
      { start: 2, end: 4 },
      { start: 10, end: 12 },
    ]);
  });
});

describe("CoverageIndex.subtract — inclusive invalidation", () => {
  it("subtracting from an empty index is a no-op", () => {
    const index = new CoverageIndex();
    index.subtract({ start: -2, end: 2 });
    expect(index.ranges()).toEqual([]);
  });

  it.each([
    {
      name: "a nested range splits coverage",
      removed: { start: 3, end: 5 },
      expected: [
        { start: 1, end: 2 },
        { start: 6, end: 7 },
      ],
    },
    {
      name: "one interior slot splits coverage",
      removed: { start: 4, end: 4 },
      expected: [
        { start: 1, end: 3 },
        { start: 5, end: 7 },
      ],
    },
    {
      name: "the first slot is removed",
      removed: { start: 1, end: 1 },
      expected: [{ start: 2, end: 7 }],
    },
    {
      name: "the last slot is removed",
      removed: { start: 7, end: 7 },
      expected: [{ start: 1, end: 6 }],
    },
    {
      name: "a left overlap clips coverage",
      removed: { start: -2, end: 3 },
      expected: [{ start: 4, end: 7 }],
    },
    {
      name: "a right overlap clips coverage",
      removed: { start: 5, end: 10 },
      expected: [{ start: 1, end: 4 }],
    },
    {
      name: "touching the first endpoint removes it",
      removed: { start: -2, end: 1 },
      expected: [{ start: 2, end: 7 }],
    },
    {
      name: "touching the last endpoint removes it",
      removed: { start: 7, end: 10 },
      expected: [{ start: 1, end: 6 }],
    },
    {
      name: "an adjacent range on the left is a no-op",
      removed: { start: -2, end: 0 },
      expected: [{ start: 1, end: 7 }],
    },
    {
      name: "an adjacent range on the right is a no-op",
      removed: { start: 8, end: 10 },
      expected: [{ start: 1, end: 7 }],
    },
    {
      name: "the entire range is removed",
      removed: { start: 1, end: 7 },
      expected: [],
    },
    {
      name: "an enclosing range removes everything",
      removed: { start: -10, end: 10 },
      expected: [],
    },
  ])("subtracts inclusively: $name", ({ removed, expected }) => {
    const index = indexWith([{ start: 1, end: 7 }]);
    index.subtract(removed);
    expect(index.ranges()).toEqual(expected);
  });

  it("subtracts across multiple ranges and leaves only the outside flanks", () => {
    const index = indexWith([
      { start: -8, end: -4 },
      { start: -1, end: 1 },
      { start: 4, end: 8 },
    ]);
    index.subtract({ start: -6, end: 6 });
    expect(index.ranges()).toEqual([
      { start: -8, end: -7 },
      { start: 7, end: 8 },
    ]);
  });

  it("subtracting an internal uncovered range is a no-op", () => {
    const initial = [
      { start: -5, end: -2 },
      { start: 2, end: 5 },
    ];
    const index = indexWith(initial);
    index.subtract({ start: -1, end: 1 });
    expect(index.ranges()).toEqual(initial);
  });

  it("removes a single-slot range and allows it to be covered again", () => {
    const index = indexWith([{ start: -3, end: -3 }]);
    index.subtract({ start: -3, end: -3 });
    expect(index.ranges()).toEqual([]);
    expect(index.gaps({ start: -3, end: -3 })).toEqual([
      { start: -3, end: -3 },
    ]);
    index.add({ start: -3, end: -3 });
    expect(index.ranges()).toEqual([{ start: -3, end: -3 }]);
  });
});

describe("CoverageIndex.covered and gaps — ascending clipped partitions", () => {
  it.each([
    {
      name: "a query wider than all coverage",
      query: { start: -5, end: 8 },
      covered: [
        { start: -3, end: -1 },
        { start: 2, end: 5 },
      ],
      gaps: [
        { start: -5, end: -4 },
        { start: 0, end: 1 },
        { start: 6, end: 8 },
      ],
    },
    {
      name: "both outside ranges clipped",
      query: { start: -2, end: 3 },
      covered: [
        { start: -2, end: -1 },
        { start: 2, end: 3 },
      ],
      gaps: [{ start: 0, end: 1 }],
    },
    {
      name: "a wholly covered query",
      query: { start: 3, end: 4 },
      covered: [{ start: 3, end: 4 }],
      gaps: [],
    },
    {
      name: "a wholly uncovered internal query",
      query: { start: 0, end: 1 },
      covered: [],
      gaps: [{ start: 0, end: 1 }],
    },
    {
      name: "a query before the index",
      query: { start: -8, end: -4 },
      covered: [],
      gaps: [{ start: -8, end: -4 }],
    },
    {
      name: "a query after the index",
      query: { start: 6, end: 9 },
      covered: [],
      gaps: [{ start: 6, end: 9 }],
    },
    {
      name: "a query exactly matching coverage",
      query: { start: 2, end: 5 },
      covered: [{ start: 2, end: 5 }],
      gaps: [],
    },
    {
      name: "a single slot at the first covered endpoint",
      query: { start: -3, end: -3 },
      covered: [{ start: -3, end: -3 }],
      gaps: [],
    },
    {
      name: "a single slot at the last covered endpoint",
      query: { start: 5, end: 5 },
      covered: [{ start: 5, end: 5 }],
      gaps: [],
    },
    {
      name: "a single uncovered slot",
      query: { start: 0, end: 0 },
      covered: [],
      gaps: [{ start: 0, end: 0 }],
    },
    {
      name: "a query touching a covered start",
      query: { start: -4, end: -3 },
      covered: [{ start: -3, end: -3 }],
      gaps: [{ start: -4, end: -4 }],
    },
    {
      name: "a query touching a covered end",
      query: { start: 5, end: 6 },
      covered: [{ start: 5, end: 5 }],
      gaps: [{ start: 6, end: 6 }],
    },
  ])("partitions $name", ({ query, covered, gaps }) => {
    const initial = [
      { start: -3, end: -1 },
      { start: 2, end: 5 },
    ];
    const index = indexWith(initial);
    expect(index.covered(query)).toEqual(covered);
    expect(index.gaps(query)).toEqual(gaps);
    expect(index.ranges()).toEqual(initial);
  });
});

describe("CoverageIndex snapshots and reset", () => {
  it("ranges returns a copy of both the array and its range objects", () => {
    const initial = [
      { start: -5, end: -3 },
      { start: 2, end: 4 },
    ];
    const index = indexWith(initial);
    const snapshot = index.ranges();
    for (const range of snapshot) {
      range.start = -100;
      range.end = 100;
    }
    snapshot.splice(0, snapshot.length, { start: 50, end: 60 });
    expect(index.ranges()).toEqual(initial);
    expect(index.covered({ start: -5, end: 4 })).toEqual(initial);
    expect(index.gaps({ start: -5, end: 4 })).toEqual([{ start: -2, end: 1 }]);
  });

  it("clear empties all coverage, is repeatable, and permits reuse", () => {
    const index = indexWith([
      { start: -5, end: -3 },
      { start: 2, end: 4 },
    ]);
    index.clear();
    expect(index.ranges()).toEqual([]);
    expect(index.covered({ start: -10, end: 10 })).toEqual([]);
    expect(index.gaps({ start: -10, end: 10 })).toEqual([
      { start: -10, end: 10 },
    ]);
    index.clear();
    expect(index.ranges()).toEqual([]);
    index.add({ start: 0, end: 0 });
    expect(index.ranges()).toEqual([{ start: 0, end: 0 }]);
  });
});

describe("CoverageIndex malformed SlotRange rejection — architecture §4.1", () => {
  const malformed = [
    { name: "fractional start", range: { start: -1.5, end: 2 } },
    { name: "fractional end", range: { start: -2, end: 1.5 } },
    { name: "equal fractional endpoints", range: { start: 1.5, end: 1.5 } },
    { name: "NaN start", range: { start: Number.NaN, end: 2 } },
    { name: "NaN end", range: { start: -2, end: Number.NaN } },
    {
      name: "positive infinite start",
      range: { start: Number.POSITIVE_INFINITY, end: 2 },
    },
    {
      name: "negative infinite start",
      range: { start: Number.NEGATIVE_INFINITY, end: 2 },
    },
    {
      name: "positive infinite end",
      range: { start: -2, end: Number.POSITIVE_INFINITY },
    },
    {
      name: "negative infinite end",
      range: { start: -2, end: Number.NEGATIVE_INFINITY },
    },
    { name: "inverted integer endpoints", range: { start: 2, end: -2 } },
  ];

  for (const method of ["add", "subtract", "covered", "gaps"] as const) {
    it.each(malformed)(`${method} throws RangeError for $name`, ({ range }) => {
      expect(() => new CoverageIndex()[method](range)).toThrow(RangeError);
      const index = indexWith([
        { start: -5, end: -3 },
        { start: 2, end: 4 },
      ]);
      expect(() => index[method](range)).toThrow(RangeError);
    });
  }
});

// Independent reference model: individual authoritative slots in a small
// finite universe. No production range merge/subtraction logic is reproduced.
const universe = { start: -24, end: 24 };

function randomInt(seed: number): (min: number, max: number) => number {
  let state = seed >>> 0;
  return (min, max) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return min + (state % (max - min + 1));
  };
}

function randomRange(next: (min: number, max: number) => number): SlotRange {
  const a = next(universe.start, universe.end);
  const b = next(universe.start, universe.end);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function slotsIn(range: SlotRange): number[] {
  const slots: number[] = [];
  for (let slot = range.start; slot <= range.end; slot += 1) slots.push(slot);
  return slots;
}

function referenceRanges(slots: number[]): SlotRange[] {
  const ranges: SlotRange[] = [];
  for (const slot of slots) {
    const last = ranges.at(-1);
    if (last !== undefined && last.end === slot - 1) last.end = slot;
    else ranges.push({ start: slot, end: slot });
  }
  return ranges;
}

function expectModel(index: CoverageIndex, model: Set<number>): void {
  expect(index.ranges()).toEqual(
    referenceRanges(slotsIn(universe).filter((slot) => model.has(slot))),
  );
}

function expectPartition(
  index: CoverageIndex,
  model: Set<number>,
  query: SlotRange,
): void {
  const requested = slotsIn(query);
  const covered: SlotRange[] = index.covered({ ...query });
  const gaps: SlotRange[] = index.gaps({ ...query });
  expect(covered).toEqual(
    referenceRanges(requested.filter((slot) => model.has(slot))),
  );
  expect(gaps).toEqual(
    referenceRanges(requested.filter((slot) => !model.has(slot))),
  );
  // Exact expected ranges above bound expansion even for a broken index.
  const coveredSlots = covered.flatMap(slotsIn);
  const gapSlots = gaps.flatMap(slotsIn);
  const coveredSet = new Set(coveredSlots);
  expect(gapSlots.some((slot) => coveredSet.has(slot))).toBe(false);
  expect([...coveredSlots, ...gapSlots].sort((a, b) => a - b)).toEqual(
    requested,
  );
}

describe("CoverageIndex seeded set-model properties — architecture §5", () => {
  const seeds = [1, 0xc0ffee, 0xdeadbeef];

  it.each(
    seeds,
  )("merge matches the covered-slot set after every addition (seed %i)", (seed) => {
    const next = randomInt(seed);
    const index = new CoverageIndex();
    const model = new Set<number>();
    for (let step = 0; step < 100; step += 1) {
      const start = next(universe.start, universe.end);
      const range = { start, end: Math.min(universe.end, start + next(0, 5)) };
      for (const slot of slotsIn(range)) model.add(slot);
      index.add(range);
      expectModel(index, model);
      expectPartition(index, model, universe);
    }
  });

  it.each(
    seeds,
  )("subtraction matches set deletion after every removal (seed %i)", (seed) => {
    const next = randomInt(seed);
    const index = indexWith([universe]);
    const model = new Set(slotsIn(universe));
    for (let step = 0; step < 100; step += 1) {
      const start = next(universe.start - 5, universe.end + 5);
      const range = { start, end: start + next(0, 3) };
      for (const slot of slotsIn(range)) model.delete(slot);
      index.subtract(range);
      expectModel(index, model);
      expectPartition(index, model, universe);
    }
  });

  it.each(
    seeds,
  )("covered and gaps tile queries after mixed add/subtract/clear operations (seed %i)", (seed) => {
    const next = randomInt(seed);
    const index = new CoverageIndex();
    const model = new Set<number>();
    for (let step = 0; step < 150; step += 1) {
      const range = randomRange(next);
      const operation = next(0, 9);
      if (operation === 0) {
        index.clear();
        model.clear();
      } else if (operation <= 5) {
        for (const slot of slotsIn(range)) model.add(slot);
        index.add(range);
      } else {
        for (const slot of slotsIn(range)) model.delete(slot);
        index.subtract(range);
      }
      expectModel(index, model);
      expectPartition(index, model, universe);
      expectPartition(index, model, randomRange(next));
      const slot = next(universe.start, universe.end);
      expectPartition(index, model, { start: slot, end: slot });
      expectPartition(index, model, {
        start: universe.start - 5,
        end: universe.end + 5,
      });
    }
  });
});
