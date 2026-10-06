import { describe, expect, it } from "vitest";
import { collect } from "../src/engine/read";
import type { Columns } from "../src/segment/types";
import { points, schema, store } from "./merge-test-helpers";

// Contract tests: architecture §4.4. Inputs use the store's documented
// segment order; expectations describe rows, not the extraction algorithm.
describe("collect present points — architecture §4.2–§4.4, N1, N14, N15", () => {
  it("clips one sparse segment inclusively and preserves NaN-valued points", () => {
    const s = store({ segmentSlotCap: 16 });
    s.put(points([1, 2, 4, 6], [11, 22, Number.NaN, 66], [1, 2, 4, 6]));

    expect(collect(s.segments, { start: 2, end: 6 }, schema)).toEqual({
      slots: new Float64Array([2, 4, 6]),
      fields: {
        price: new Float64Array([22, Number.NaN, 66]),
        volume: new Int16Array([2, 4, 6]),
      },
    });
  });

  it("concatenates selected points across K-gap splits and page edges", () => {
    const s = store();
    s.put(points([0, 3, 7, 8, 11, 16, 19], [10, 30, 70, 80, 110, 160, 190]));

    expect(collect(s.segments, { start: 3, end: 16 }, schema)).toEqual({
      slots: new Float64Array([3, 7, 8, 11, 16]),
      fields: {
        price: new Float64Array([30, 70, 80, 110, 160]),
        volume: new Int16Array([3, 7, 8, 11, 16]),
      },
    });
  });

  it("keeps adjacent points on both sides of negative, zero and positive page edges", () => {
    const s = store({ gapSplitK: 8 });
    s.put(points([-9, -8, -1, 0, 7, 8, 15, 16]));

    expect(collect(s.segments, { start: -8, end: 15 }, schema)).toEqual({
      slots: new Float64Array([-8, -1, 0, 7, 8, 15]),
      fields: {
        price: new Float64Array([-8, -1, 0, 7, 8, 15]),
        volume: new Int16Array([-8, -1, 0, 7, 8, 15]),
      },
    });
  });

  it("allows a request to reach beyond both data flanks without filling holes", () => {
    const s = store();
    s.put(points([1, 3, 8, 10], [101, 103, 108, 110]));

    expect(collect(s.segments, { start: -20, end: 30 }, schema)).toEqual({
      slots: new Float64Array([1, 3, 8, 10]),
      fields: {
        price: new Float64Array([101, 103, 108, 110]),
        volume: new Int16Array([1, 3, 8, 10]),
      },
    });
  });

  it.each([
    { slot: -9, slots: [-9], prices: [90], volumes: [9] },
    { slot: -8, slots: [], prices: [], volumes: [] },
    { slot: 0, slots: [0], prices: [100], volumes: [10] },
    { slot: 1, slots: [], prices: [], volumes: [] },
    { slot: 8, slots: [8], prices: [180], volumes: [18] },
    { slot: 9, slots: [], prices: [], volumes: [] },
  ])(
    "selects only the requested single slot $slot",
    ({ slot, slots, prices, volumes }) => {
      const s = store();
      s.put(points([-9, 0, 8], [90, 100, 180], [9, 10, 18]));

      expect(collect(s.segments, { start: slot, end: slot }, schema)).toEqual({
        slots: new Float64Array(slots),
        fields: {
          price: new Float64Array(prices),
          volume: new Int16Array(volumes),
        },
      });
    },
  );

  it.each([
    { name: "before all data", range: { start: -8, end: -1 } },
    { name: "inside an internal gap", range: { start: 2, end: 3 } },
    { name: "between segments", range: { start: 6, end: 7 } },
    { name: "after all data", range: { start: 10, end: 20 } },
  ])("returns typed zero-length arrays $name", ({ range }) => {
    const s = store();
    s.put(points([1, 4, 8, 9]));

    expect(collect(s.segments, range, schema)).toEqual({
      slots: new Float64Array(0),
      fields: {
        price: new Float64Array(0),
        volume: new Int16Array(0),
      },
    });
  });

  it("returns schema-shaped zero-length arrays when there are no segments", () => {
    const result: Columns = collect([], { start: -2, end: 2 }, schema);
    expect(result).toEqual({
      slots: new Float64Array(0),
      fields: { price: new Float64Array(0), volume: new Int16Array(0) },
    });
  });
});
