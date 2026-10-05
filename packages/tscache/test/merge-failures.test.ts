import { afterEach, describe, expect, it, vi } from "vitest";
import { DenseSegment } from "../src/segment/dense";
import { expectRows, extents, points, store } from "./merge-test-helpers";

const mergeFrom = DenseSegment.prototype.mergeFrom;

// Implementer tests (not contract tests): what a put leaves behind when it
// fails part-way (architecture §4.3, allocation failure), and a replace that
// splits one segment into very many.

describe("SegmentStore failure part-way through a join", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: "target on the right", stored: [0, 6, 12, 13, 14] },
    { name: "target on the left", stored: [0, 1, 2, 8, 14] },
    { name: "target in the middle", stored: [0, 6, 7, 8, 14] },
  ])("keeps the list ascending and disjoint: $name", ({ stored }) => {
    for (let failAt = 1; failAt <= 2; failAt++) {
      const s = store({ segmentSlotCap: 100 });
      s.put(points(stored));
      expect(s.segments).toHaveLength(3);
      const slice = DenseSegment.prototype.slice;
      let calls = 0;
      vi.spyOn(DenseSegment.prototype, "slice").mockImplementation(function (
        this: DenseSegment,
        range,
      ) {
        if (++calls === failAt) {
          throw new RangeError("Array buffer allocation failed");
        }
        return slice.call(this, range);
      });
      expect(() => s.put(points([3, 5, 7, 9, 11]))).toThrow(RangeError);
      vi.restoreAllMocks();
      const after = extents(s);
      for (let i = 1; i < after.length; i++) {
        expect(after[i]?.start).toBeGreaterThan(after[i - 1]?.end as number);
      }
      expectRows(s, stored);
      // The same put succeeds once allocation works again.
      s.put(points([3, 5, 7, 9, 11]));
      expect(extents(s)).toEqual([{ start: 0, end: 14 }]);
    }
  });
});

describe("SegmentStore failure after a replace cleared its range", () => {
  afterEach(() => vi.restoreAllMocks());

  it("still splits the segment whose middle was removed", () => {
    const s = store({ segmentSlotCap: 100 });
    s.put(points([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    let failed = false;
    vi.spyOn(DenseSegment.prototype, "mergeFrom").mockImplementation(function (
      this: DenseSegment,
      incoming,
      authority,
    ) {
      if (incoming.slots.length > 0 && !failed) {
        failed = true;
        throw new RangeError("Array buffer allocation failed");
      }
      return mergeFrom.call(this, incoming, authority);
    });
    expect(() => s.put(points([4]), { start: 1, end: 7 })).toThrow(RangeError);
    vi.restoreAllMocks();
    expect(extents(s)).toEqual([
      { start: 0, end: 0 },
      { start: 8, end: 8 },
    ]);
    expectRows(s, [0, 8]);
  });
});

describe("SegmentStore replace that splits one segment into very many", () => {
  it("keeps the points outside the authority", () => {
    const cap = 400_002;
    const s = store({ interval: 1, gapSplitK: 1, segmentSlotCap: cap });
    const all = Float64Array.from({ length: cap }, (_, i) => i);
    s.put({
      slots: all,
      fields: { price: all, volume: new Float64Array(cap) },
    });
    const kept = all.filter(
      (slot) => slot % 3 === 0 && slot > 0 && slot < cap - 1,
    );
    s.put(
      {
        slots: kept,
        fields: { price: kept, volume: new Float64Array(kept.length) },
      },
      { start: 1, end: cap - 2 },
    );
    // Slot 0 stands alone; the last kept point is one empty slot away from
    // the point after the authority, so they share a segment.
    expect(s.segments).toHaveLength(kept.length + 1);
    expect(s.segments[0]?.extent).toEqual({ start: 0, end: 0 });
    expect(s.segments.at(-1)?.extent).toEqual({ start: cap - 3, end: cap - 1 });
    expect(s.segments.at(-1)?.lookup(cap - 1)).toEqual({
      price: cap - 1,
      volume: 0,
    });
  });
});
