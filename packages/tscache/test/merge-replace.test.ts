import { describe, expect, it } from "vitest";
import { validateBatch } from "../src/engine/batch";
import { SegmentStore } from "../src/engine/merge";
import { resolveCacheConfig } from "../src/engine/validate";
import {
  expectRows,
  extents,
  points,
  snapshot,
  store,
} from "./merge-test-helpers";

describe("SegmentStore upsert and replace — architecture §2.4, §4.2, §4.3, N11", () => {
  it("upsert overwrites whole rows across segments/pages and preserves omitted points", () => {
    const s = store();
    s.put(points([-9, -8, -5, -1, 0, 3, 7, 8, 11]));
    s.put(points([-9, -1, 3, 8, 16], [90, 10, 30, 80, 160], [9, 1, 3, 8, 16]));
    expectRows(
      s,
      [-9, -8, -5, -1, 0, 3, 7, 8, 11, 16],
      [90, -8, -5, 10, 0, 30, 7, 80, 11, 160],
      [9, -8, -5, 1, 0, 3, 7, 8, 11, 16],
    );
    const before = snapshot(s);
    s.put(points([]));
    expect(snapshot(s)).toEqual(before);
  });

  it("replace deletes inclusive endpoints across segments and pages while keeping outside flanks", () => {
    const s = store();
    s.put(points([-9, -8, -5, -1, 0, 3, 7, 8, 11, 16]));
    s.put(points([-2, 2, 9], [20, 200, 90], [2, 20, 9]), {
      start: -8,
      end: 11,
    });
    expectRows(
      s,
      [-9, -2, 2, 9, 16],
      [-9, 20, 200, 90, 16],
      [-9, 2, 20, 9, 16],
    );
    expect(extents(s)).toEqual([
      { start: -9, end: -9 },
      { start: -2, end: -2 },
      { start: 2, end: 2 },
      { start: 9, end: 9 },
      { start: 16, end: 16 },
    ]);
    for (const segment of s.segments) {
      expect(segment.lookup(-8)).toBeUndefined();
      expect(segment.lookup(11)).toBeUndefined();
    }
  });

  it("a replacement that opens K+1 absent slots splits immediately; closing it joins again", () => {
    const s = store();
    s.put(points([0, 1, 2, 3, 4]));
    s.put(points([]), { start: 1, end: 3 });
    expect(extents(s)).toEqual([
      { start: 0, end: 0 },
      { start: 4, end: 4 },
    ]);
    expectRows(s, [0, 4]);
    s.put(points([2], [22], [2]));
    expect(extents(s)).toEqual([{ start: 0, end: 4 }]);
    expectRows(s, [0, 2, 4], [0, 22, 4], [0, 2, 4]);
  });

  it("a replacement leaving exactly K absent slots does not split", () => {
    const s = store();
    s.put(points([0, 1, 2, 3]));
    s.put(points([]), { start: 1, end: 2 });
    expect(extents(s)).toEqual([{ start: 0, end: 3 }]);
    expectRows(s, [0, 3]);
  });

  it("empty replacements trim extents, remove whole segments, and support one-slot deletion", () => {
    const s = store();
    s.put(points([-8, -7, -6, 0, 1, 8, 9]));
    s.put(points([]), { start: -8, end: -7 });
    s.put(points([]), { start: 1, end: 8 });
    expect(extents(s)).toEqual([
      { start: -6, end: -6 },
      { start: 0, end: 0 },
      { start: 9, end: 9 },
    ]);
    s.put(points([]), { start: 0, end: 0 });
    expectRows(s, [-6, 9]);
    s.put(points([]), { start: -100, end: 100 });
    expect(s.segments).toEqual([]);
    s.put(points([-1]));
    expectRows(s, [-1]);
  });

  it("replacement authority may span many pages; only present points occupy segments", () => {
    const s = store({ segmentSlotCap: 1 });
    s.put(points([-10, 0, 10]));
    s.put(points([-20, 20]), { start: -1000, end: 1000 });
    expect(extents(s)).toEqual([
      { start: -20, end: -20 },
      { start: 20, end: 20 },
    ]);
    expectRows(s, [-20, 20]);
  });

  it("empty replacement in an existing gap or outside all extents is a no-op", () => {
    const s = store();
    s.put(points([-8, 0, 8]));
    const before = snapshot(s);
    for (const authority of [
      { start: -7, end: -1 },
      { start: 100, end: 1000 },
      { start: -1000, end: -100 },
    ]) {
      s.put(points([]), authority);
      expect(snapshot(s)).toEqual(before);
    }
  });

  it("validated sparse puts upsert by default; an explicit inward range replaces", () => {
    const config = resolveCacheConfig({
      id: "path",
      interval: 10,
      alignmentOffset: 3,
      fields: { price: "f64", volume: "i16" },
      segmentSlotCap: 8,
    });
    const s = new SegmentStore(config);
    s.put(points([-1, 0, 1, 2, 3]));
    const input = {
      timestamps: [3, 23],
      fields: { price: [10, 20], volume: [1, 2] },
    };
    const upsert = validateBatch(input, config);
    s.put(upsert.points, upsert.authority);
    expectRows(s, [-1, 0, 1, 2, 3], [-1, 10, 1, 20, 3], [-1, 1, 1, 2, 3]);
    const replace = validateBatch(input, config, { start: -6.9, end: 32.9 });
    s.put(replace.points, replace.authority);
    expectRows(s, [-1, 0, 2, 3], [-1, 10, 20, 3], [-1, 1, 2, 3]);
    const gridless = validateBatch(
      { timestamps: [], fields: { price: [], volume: [] } },
      config,
      { start: 4, end: 12 },
    );
    const before = snapshot(s);
    s.put(gridless.points, gridless.authority);
    expect(snapshot(s)).toEqual(before);
  });

  it("copies incoming arrays and returns independent lookup/slice results", () => {
    const s = store();
    const input = points([0, 3, 8], [10, 30, 80], [1, 3, 8]);
    s.put(input);
    const before = snapshot(s);
    input.slots.fill(100);
    for (const field of Object.values(input.fields)) field.fill(999);
    for (const segment of s.segments) {
      const extent = segment.extent;
      if (extent === undefined) throw new Error("Empty segment");
      const row = segment.lookup(extent.start);
      if (row !== undefined) row.price = 999;
      const slice = segment.slice(extent);
      slice.slots.fill(999);
      for (const field of Object.values(slice.fields)) field.fill(999);
    }
    expect(snapshot(s)).toEqual(before);
  });

  it("clear removes all segments and allows subsequent reuse", () => {
    const s = store();
    s.put(points([-9, 0, 8]));
    s.clear();
    s.clear();
    expect(s.segments).toEqual([]);
    s.put(points([3]));
    expectRows(s, [3]);
  });
});
