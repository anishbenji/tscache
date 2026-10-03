import { describe, expect, it } from "vitest";
import { CoverageIndex } from "../src/coverage";
import { InvalidRangeError } from "../src/errors";
import { isAligned, slotOf, snapOut, toMs } from "../src/grid";

// Implementer tests (not contract tests): the supported domain is safe
// integers (architecture §4.1), so every ±1 on a slot is exact.
const MAX = Number.MAX_SAFE_INTEGER;
const unit = { interval: 1, alignmentOffset: 0 };
const minute = { interval: 60_000, alignmentOffset: 0 };

describe("grid rejects values outside the safe-integer range", () => {
  it.each([
    2 ** 53,
    -(2 ** 53),
    2 ** 60,
    1e300,
  ])("treats timestamp %d as unaligned", (t) => {
    expect(isAligned(t, unit)).toBe(false);
    expect(() => slotOf(t, unit)).toThrow(RangeError);
  });

  it.each([
    { name: "start below the range", range: { start: -(2 ** 53), end: 0 } },
    { name: "end above the range", range: { start: 0, end: 2 ** 53 } },
    { name: "a huge finite end", range: { start: 0, end: 1e300 } },
  ])("snapOut rejects $name", ({ range }) => {
    expect(() => snapOut(range, unit)).toThrow(InvalidRangeError);
  });

  it("snapOut rejects a range whose outward snap leaves the range", () => {
    // MAX is not on the minute grid; the next grid point is beyond 2^53.
    expect(() => snapOut({ start: 0, end: MAX }, minute)).toThrow(
      InvalidRangeError,
    );
    expect(() => snapOut({ start: -MAX, end: 0 }, minute)).toThrow(
      InvalidRangeError,
    );
  });

  it("accepts the extreme safe timestamps and returns them exactly", () => {
    const slots = snapOut({ start: -MAX, end: MAX }, unit);
    expect(slots).toEqual({ start: -MAX, end: MAX });
    expect(toMs(slots, unit)).toEqual({ start: -MAX, end: MAX });
  });
});

describe("CoverageIndex at the safe-integer bounds", () => {
  it.each([
    "add",
    "subtract",
    "covered",
    "gaps",
  ] as const)("%s throws RangeError for a slot beyond the safe range", (method) => {
    const index = new CoverageIndex();
    expect(() => index[method]({ start: 2 ** 53, end: 2 ** 53 })).toThrow(
      RangeError,
    );
    expect(() => index[method]({ start: -(2 ** 53), end: 0 })).toThrow(
      RangeError,
    );
  });

  it("partitions exactly at both extremes", () => {
    const index = new CoverageIndex();
    index.add({ start: MAX, end: MAX });
    index.add({ start: -MAX, end: -MAX });
    expect(index.gaps({ start: MAX, end: MAX })).toEqual([]);
    expect(index.gaps({ start: -MAX, end: -MAX })).toEqual([]);
    expect(index.covered({ start: MAX - 1, end: MAX })).toEqual([
      { start: MAX, end: MAX },
    ]);
    expect(index.gaps({ start: MAX - 1, end: MAX })).toEqual([
      { start: MAX - 1, end: MAX - 1 },
    ]);
    index.add({ start: MAX - 1, end: MAX - 1 });
    index.add({ start: -MAX + 1, end: -MAX + 1 });
    expect(index.ranges()).toEqual([
      { start: -MAX, end: -MAX + 1 },
      { start: MAX - 1, end: MAX },
    ]);
    index.subtract({ start: MAX, end: MAX });
    index.subtract({ start: -MAX, end: -MAX });
    expect(index.ranges()).toEqual([
      { start: -MAX + 1, end: -MAX + 1 },
      { start: MAX - 1, end: MAX - 1 },
    ]);
  });
});
