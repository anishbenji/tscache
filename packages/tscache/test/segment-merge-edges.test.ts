import { describe, expect, it } from "vitest";
import { DenseSegment } from "../src/segment/dense";
import type { Columns } from "../src/segment/types";

// Implementer tests (not contract tests): edge cases from review round 3.
const options = {
  grid: { interval: 1, alignmentOffset: 0 },
  fields: { x: "f64" } as const,
  slotCap: 32_768,
};
const empty: Columns = {
  slots: new Float64Array(),
  fields: { x: new Float64Array() },
};

function single(): DenseSegment {
  const segment = new DenseSegment(options);
  segment.mergeFrom({
    slots: new Float64Array([0, 10]),
    fields: { x: new Float64Array([1, 2]) },
  });
  return segment;
}

describe("replacement with an authority away from the extent", () => {
  it.each([
    { name: "far right", authority: { start: 2 ** 32 + 1, end: 2 ** 32 + 1 } },
    { name: "far left", authority: { start: -(2 ** 32) - 9, end: -(2 ** 32) } },
    { name: "just right", authority: { start: 11, end: 20 } },
    { name: "just left", authority: { start: -20, end: -1 } },
    {
      name: "at the safe-integer extremes",
      authority: {
        start: Number.MAX_SAFE_INTEGER - 1,
        end: Number.MAX_SAFE_INTEGER,
      },
    },
  ])("clearing a range $name leaves the segment unchanged", ({ authority }) => {
    const segment = single();
    segment.mergeFrom(empty, authority);
    expect(segment.extent).toEqual({ start: 0, end: 10 });
    expect(segment.size).toBe(2);
    expect(segment.lookup(0)).toEqual({ x: 1 });
    expect(segment.lookup(10)).toEqual({ x: 2 });
  });

  it("clearing an interior gap between points leaves them in place", () => {
    const segment = single();
    segment.mergeFrom(empty, { start: 1, end: 9 });
    expect(segment.extent).toEqual({ start: 0, end: 10 });
    expect(segment.size).toBe(2);
  });
});

describe("field-name validation uses the batch's enumerable own fields", () => {
  it("rejects a batch hiding a schema field behind a non-enumerable property", () => {
    const segment = single();
    const fields = Object.defineProperty(
      { extra: new Float64Array([99]) },
      "x",
      { value: new Float64Array([99]) },
    ) as unknown as Columns["fields"];
    const batch: Columns = { slots: new Float64Array([0]), fields };
    for (const authority of [undefined, { start: 0, end: 0 }]) {
      expect(() => segment.mergeFrom(batch, authority)).toThrow(RangeError);
      expect(segment.lookup(0)).toEqual({ x: 1 });
    }
  });
});
