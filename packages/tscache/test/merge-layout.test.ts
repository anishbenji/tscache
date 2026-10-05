import { describe, expect, it } from "vitest";
import { SegmentStore } from "../src/engine/merge";
import { resolveCacheConfig } from "../src/engine/validate";
import { expectRows, extents, points, store } from "./merge-test-helpers";

describe("SegmentStore layout — architecture §4.3, N14, N15", () => {
  it("starts empty and keeps an empty upsert empty", () => {
    const s = store();
    expect(s.segments).toEqual([]);
    expect(s.put(points([]))).toEqual([]);
    expect(s.segments).toEqual([]);
  });

  it("keeps single-slot extents tight, including negative pages", () => {
    const s = store();
    s.put(points([-9, -1, 0, 8]));
    expect(extents(s)).toEqual([
      { start: -9, end: -9 },
      { start: -1, end: -1 },
      { start: 0, end: 0 },
      { start: 8, end: 8 },
    ]);
    expectRows(s, [-9, -1, 0, 8]);
  });

  it.each([
    {
      k: 1,
      slots: [0, 2, 5],
      ends: [
        [0, 2],
        [5, 5],
      ],
    },
    {
      k: 2,
      slots: [0, 3, 7],
      ends: [
        [0, 3],
        [7, 7],
      ],
    },
    {
      k: 4,
      slots: [0, 5, 11],
      ends: [
        [0, 5],
        [11, 11],
      ],
    },
  ])("allows exactly K=$k absent slots and splits at K+1", ({
    k,
    slots,
    ends,
  }) => {
    const s = store({ gapSplitK: k, segmentSlotCap: 32 });
    s.put(points(slots));
    expect(extents(s)).toEqual(ends.map(([start, end]) => ({ start, end })));
    expectRows(s, slots);
    for (const segment of s.segments) expect(segment.lookup(1)).toBeUndefined();
  });

  it.each([
    {
      cap: 1,
      slots: [-2, -1, 0, 1],
      ends: [
        [-2, -2],
        [-1, -1],
        [0, 0],
        [1, 1],
      ],
    },
    {
      cap: 8,
      slots: [-9, -8, -1, 0, 7, 8],
      ends: [
        [-9, -9],
        [-8, -1],
        [0, 7],
        [8, 8],
      ],
    },
    {
      cap: 32_768,
      slots: [-32_769, -32_768, -1, 0, 32_767, 32_768],
      ends: [
        [-32_769, -32_769],
        [-32_768, -1],
        [0, 32_767],
        [32_768, 32_768],
      ],
    },
  ])("splits at fixed multiples of cap $cap, even with a large K", ({
    cap,
    slots,
    ends,
  }) => {
    const s = store({ segmentSlotCap: cap, gapSplitK: 32_768 });
    s.put(points(slots));
    expect(extents(s)).toEqual(ends.map(([start, end]) => ({ start, end })));
    expectRows(s, slots);
    for (const segment of s.segments) {
      const extent = segment.extent;
      if (extent === undefined) throw new Error("Empty segment");
      expect(extent.end - extent.start + 1).toBeLessThanOrEqual(cap);
    }
  });

  it("uses the documented default K=4 and cap=32768", () => {
    const s = new SegmentStore(
      resolveCacheConfig({
        id: "defaults",
        interval: 1,
        fields: { price: "f64", volume: "i16" },
      }),
    );
    s.put(points([0, 5, 11, 32_767, 32_768]));
    expect(extents(s)).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 11 },
      { start: 32_767, end: 32_767 },
      { start: 32_768, end: 32_768 },
    ]);
  });

  it("a bridge point joins neighboring segments on the same page", () => {
    const s = store();
    s.put(points([0, 6]));
    expect(extents(s)).toEqual([
      { start: 0, end: 0 },
      { start: 6, end: 6 },
    ]);
    s.put(points([3]));
    expect(extents(s)).toEqual([{ start: 0, end: 6 }]);
    expectRows(s, [0, 3, 6]);
  });

  it("bridging a gap never joins points across a page edge", () => {
    const s = store();
    s.put(points([5, 11]));
    s.put(points([7, 8]));
    expect(extents(s)).toEqual([
      { start: 5, end: 7 },
      { start: 8, end: 11 },
    ]);
    expectRows(s, [5, 7, 8, 11]);
  });

  it("prepending history does not move later page boundaries", () => {
    const s = store({ gapSplitK: 8 });
    s.put(points([7, 8, 15, 16]));
    s.put(points([-8, -1, 0, 6]));
    expect(extents(s)).toEqual([
      { start: -8, end: -1 },
      { start: 0, end: 7 },
      { start: 8, end: 15 },
      { start: 16, end: 16 },
    ]);
    expectRows(s, [-8, -1, 0, 6, 7, 8, 15, 16]);
  });
});
