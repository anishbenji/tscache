import { describe, expect, it } from "vitest";
import { CoverageIndex } from "../src/coverage";
import { collect, read } from "../src/engine/read";
import type { Grid } from "../src/grid";
import type { Columns } from "../src/segment/types";
import type { GetResult } from "../src/types";
import { points, schema, store } from "./merge-test-helpers";

const grid: Grid = { interval: 10, alignmentOffset: 3 };

describe("fresh read results — architecture §2.3, §4.2, §4.4", () => {
  it("collect arrays have independent buffers and mutating them cannot change stored rows", () => {
    const s = store();
    s.put(points([-9, -8, -1, 0, 7, 8, 10]));
    const request = { start: -8, end: 8 };
    const expected = {
      slots: new Float64Array([-8, -1, 0, 7, 8]),
      fields: {
        price: new Float64Array([-8, -1, 0, 7, 8]),
        volume: new Int16Array([-8, -1, 0, 7, 8]),
      },
    };
    const first: Columns = collect(s.segments, request, schema);
    const retained: Columns = collect(s.segments, request, schema);
    expect(first).toEqual(expected);
    expect(retained).toEqual(expected);
    expect(first.slots.buffer).not.toBe(retained.slots.buffer);
    first.slots.fill(999);
    for (const [name, field] of Object.entries(first.fields)) {
      expect(field.buffer).not.toBe(retained.fields[name]?.buffer);
      field.fill(999);
    }
    first.fields.price = new Float64Array([123]);
    delete first.fields.volume;

    expect(retained).toEqual(expected);
    expect(collect(s.segments, request, schema)).toEqual(expected);
    expect(request).toEqual({ start: -8, end: 8 });
    // Copying also protects a retained result from subsequent cache writes.
    s.put(points([-8, 0, 8], [100, 200, 300], [1, 2, 3]));
    expect(retained).toEqual(expected);
  });

  it("read arrays, coverage and miss objects can be mutated without changing the cache or another result", () => {
    const s = store();
    s.put(points([-1, 0, 7, 8], [10, 20, 70, 80], [1, 2, 7, 8]));
    const index = new CoverageIndex();
    index.add({ start: -1, end: 0 });
    index.add({ start: 7, end: 7 });
    const request = { start: -1, end: 8 };
    const expected = {
      timestamps: new Float64Array([-7, 3, 73, 83]),
      fields: {
        price: new Float64Array([10, 20, 70, 80]),
        volume: new Int16Array([1, 2, 7, 8]),
      },
      coverage: [
        { start: -7, end: 3 },
        { start: 73, end: 73 },
      ],
      misses: [
        { range: { start: 13, end: 63 }, reason: "uncached" },
        { range: { start: 83, end: 83 }, reason: "uncached" },
      ],
    };
    const first: GetResult = read(request, s.segments, index, grid, schema);
    const retained: GetResult = read(request, s.segments, index, grid, schema);
    expect(first).toEqual(expected);
    expect(retained).toEqual(expected);
    expect(first.timestamps.buffer).not.toBe(retained.timestamps.buffer);
    first.timestamps.fill(999);
    for (const [name, field] of Object.entries(first.fields)) {
      expect(field.buffer).not.toBe(retained.fields[name]?.buffer);
      field.fill(999);
    }
    first.fields.price = new Float64Array([123]);
    delete first.fields.volume;
    for (const range of first.coverage) {
      range.start = -999;
      range.end = 999;
    }
    for (const miss of first.misses) {
      miss.range.start = -999;
      miss.range.end = 999;
      miss.reason = "auth-pending";
    }
    first.coverage.length = 0;
    first.misses.length = 0;

    expect(retained).toEqual(expected);
    expect(read(request, s.segments, index, grid, schema)).toEqual(expected);
    expect(index.ranges()).toEqual([
      { start: -1, end: 0 },
      { start: 7, end: 7 },
    ]);
    expect(request).toEqual({ start: -1, end: 8 });
    s.put(points([0, 8], [200, 800], [20, 80]));
    index.clear();
    expect(retained).toEqual(expected);
  });

  it("does not retain the caller's request range when it returns a whole-request miss", () => {
    const s = store();
    s.put(points([0]));
    const request = { start: 8, end: 9 };
    const result = read(request, s.segments, new CoverageIndex(), grid, schema);
    request.start = -100;
    request.end = 100;

    expect(result.misses).toEqual([
      { range: { start: 83, end: 93 }, reason: "uncached" },
    ]);
  });
});
