import { describe, expect, it } from "vitest";
import { DenseSegment } from "../src/segment/dense";

// Implementer test (not a contract test): a merge whose buffers cannot be
// allocated must leave the segment unchanged, like any other rejected merge.
describe("DenseSegment allocation failure", () => {
  it("keeps existing points when a replacement cannot allocate", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const segment = new DenseSegment({
      grid: { interval: 1, alignmentOffset: 0 },
      fields: { v: "f64" },
      slotCap: max,
    });
    segment.mergeFrom({
      slots: new Float64Array([0]),
      fields: { v: new Float64Array([42]) },
    });
    // Passes the cap check, but no engine can allocate 2^53 - 1 slots.
    const merge = () =>
      segment.mergeFrom(
        {
          slots: new Float64Array([1, max]),
          fields: { v: new Float64Array([1, 2]) },
        },
        { start: 0, end: max },
      );
    expect(merge).toThrow();
    expect(segment.size).toBe(1);
    expect(segment.extent).toEqual({ start: 0, end: 0 });
    expect(segment.lookup(0)).toEqual({ v: 42 });
  });
});
