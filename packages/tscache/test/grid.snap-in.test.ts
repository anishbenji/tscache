import { describe, expect, it } from "vitest";
import { InvalidRangeError } from "../src/errors";
import { snapIn, toMs } from "../src/grid";
import type { Range } from "../src/types";

const grid = { interval: 10, alignmentOffset: 3 };

describe("snapIn — architecture §4.1, N1, N9, N13", () => {
  it.each([
    { range: { start: 3, end: 23 }, slots: { start: 0, end: 2 } },
    { range: { start: 4, end: 22 }, slots: { start: 1, end: 1 } },
    { range: { start: 2.5, end: 23.5 }, slots: { start: 0, end: 2 } },
    { range: { start: -18, end: -6 }, slots: { start: -2, end: -1 } },
    { range: { start: -16.5, end: 2.5 }, slots: { start: -1, end: -1 } },
    { range: { start: -8, end: 4 }, slots: { start: -1, end: 0 } },
  ])("keeps exactly the grid points inside $range", ({ range, slots }) => {
    expect(snapIn(range, grid)).toEqual(slots);
    const ms = toMs(slots, grid);
    expect(ms.start).toBeGreaterThanOrEqual(range.start);
    expect(ms.end).toBeLessThanOrEqual(range.end);
  });

  it.each([-17, -7, 3, 13])("keeps the aligned singleton %i", (t) => {
    const slots = snapIn({ start: t, end: t }, grid);
    expect(slots).toBeDefined();
    if (slots === undefined) throw new Error("Missing singleton");
    expect(slots.start).toBe(slots.end);
    expect(toMs(slots, grid)).toEqual({ start: t, end: t });
  });

  it.each([
    { start: 4, end: 12 },
    { start: 4, end: 4 },
    { start: -6, end: 2 },
    { start: 3.1, end: 12.9 },
  ])("returns undefined when $start to $end holds no grid point", (range) => {
    expect(snapIn(range, grid)).toBeUndefined();
  });

  it.each([
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  ])("accepts the safe timestamp boundary %i on a unit grid", (t) => {
    expect(
      snapIn({ start: t, end: t }, { interval: 1, alignmentOffset: 0 }),
    ).toEqual({ start: t, end: t });
  });

  it("keeps exact negative slots when timestamp minus offset exceeds the safe domain", () => {
    const t = Number.MIN_SAFE_INTEGER;
    // (t - 2) / 3 is exact in integer arithmetic, but t - 2 rounds in JS.
    expect(
      snapIn({ start: t, end: t + 3 }, { interval: 3, alignmentOffset: 2 }),
    ).toEqual({ start: -3_002_399_751_580_331, end: -3_002_399_751_580_330 });
  });

  it.each([
    null,
    undefined,
    1,
    "range",
    {},
    { start: 0 },
    { end: 0 },
    { start: 2, end: 1 },
    ...[
      Number.NaN,
      Infinity,
      -Infinity,
      2 ** 53,
      -(2 ** 53),
      "3",
      null,
      true,
    ].flatMap((value) => [
      { start: value, end: 23 },
      { start: -17, end: value },
    ]),
  ])("rejects malformed range %j with InvalidRangeError", (range) => {
    expect(() => snapIn(range as Range, grid)).toThrow(InvalidRangeError);
  });
});
