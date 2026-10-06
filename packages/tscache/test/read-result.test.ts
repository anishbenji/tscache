import { describe, expect, it } from "vitest";
import { CoverageIndex } from "../src/coverage";
import { SegmentStore } from "../src/engine/merge";
import { collect, read } from "../src/engine/read";
import { resolveCacheConfig } from "../src/engine/validate";
import type { Grid } from "../src/grid";
import type { Columns } from "../src/segment/types";
import type { GetResult } from "../src/types";
import { points, schema, store } from "./merge-test-helpers";

const grid: Grid = { interval: 10, alignmentOffset: 3 };

describe("read results — architecture §2.3, §4.1, §4.4, N1, N9, N16", () => {
  it("returns one fully covered segment as present-only columns with no misses", () => {
    const s = store();
    s.put(points([1, 3, 4], [11, Number.NaN, 44], [1, 3, 4]));
    const index = new CoverageIndex();
    index.add({ start: 1, end: 4 });

    expect(read({ start: 1, end: 4 }, s.segments, index, grid, schema)).toEqual(
      {
        timestamps: new Float64Array([13, 33, 43]),
        fields: {
          price: new Float64Array([11, Number.NaN, 44]),
          volume: new Int16Array([1, 3, 4]),
        },
        coverage: [{ start: 13, end: 43 }],
        misses: [],
      },
    );
  });

  it("clips several covered ranges and returns exact unextended misses across segments", () => {
    const s = store();
    s.put(points([-10, -8, -1, 0, 7, 8, 15, 16, 18]));
    const index = new CoverageIndex();
    for (const range of [
      { start: -20, end: -8 },
      { start: -1, end: 0 },
      { start: 7, end: 9 },
      { start: 16, end: 30 },
    ])
      index.add(range);

    expect(
      read({ start: -9, end: 17 }, s.segments, index, grid, schema),
    ).toEqual({
      timestamps: new Float64Array([-77, -7, 3, 73, 83, 153, 163]),
      fields: {
        price: new Float64Array([-8, -1, 0, 7, 8, 15, 16]),
        volume: new Int16Array([-8, -1, 0, 7, 8, 15, 16]),
      },
      coverage: [
        { start: -87, end: -77 },
        { start: -7, end: 3 },
        { start: 73, end: 93 },
        { start: 163, end: 173 },
      ],
      misses: [
        { range: { start: -67, end: -17 }, reason: "uncached" },
        { range: { start: 13, end: 63 }, reason: "uncached" },
        { range: { start: 103, end: 153 }, reason: "uncached" },
      ],
    });
  });

  it("reports uncovered flanks when a request extends beyond data and coverage", () => {
    const s = store();
    s.put(points([0, 2, 8], [10, 20, 80]));
    const index = new CoverageIndex();
    index.add({ start: 0, end: 8 });

    expect(
      read({ start: -2, end: 12 }, s.segments, index, grid, schema),
    ).toEqual({
      timestamps: new Float64Array([3, 23, 83]),
      fields: {
        price: new Float64Array([10, 20, 80]),
        volume: new Int16Array([0, 2, 8]),
      },
      coverage: [{ start: 3, end: 83 }],
      misses: [
        { range: { start: -17, end: -7 }, reason: "uncached" },
        { range: { start: 93, end: 123 }, reason: "uncached" },
      ],
    });
  });

  it.each([
    { slot: -1, timestamps: [-7], values: [-1], covered: true },
    { slot: 0, timestamps: [3], values: [0], covered: false },
    { slot: 1, timestamps: [], values: [], covered: false },
    { slot: 2, timestamps: [23], values: [2], covered: true },
  ])(
    "handles an inclusive single-slot request at $slot",
    ({ slot, timestamps, values, covered }) => {
      const s = store();
      s.put(points([-1, 0, 2]));
      const index = new CoverageIndex();
      index.add({ start: -1, end: -1 });
      index.add({ start: 2, end: 2 });
      const range = { start: slot * 10 + 3, end: slot * 10 + 3 };

      expect(
        read({ start: slot, end: slot }, s.segments, index, grid, schema),
      ).toEqual({
        timestamps: new Float64Array(timestamps),
        fields: {
          price: new Float64Array(values),
          volume: new Int16Array(values),
        },
        coverage: covered ? [range] : [],
        misses: covered ? [] : [{ range, reason: "uncached" }],
      });
    },
  );

  it("applies a nonzero offset to negative and positive timestamps and both range endpoints", () => {
    const shifted: Grid = { interval: 60_000, alignmentOffset: 15_000 };
    const s = store(shifted);
    s.put(points([-2, -1, 0, 1, 2]));
    const index = new CoverageIndex();
    index.add({ start: -2, end: 0 });

    expect(
      read({ start: -1, end: 1 }, s.segments, index, shifted, schema),
    ).toEqual({
      timestamps: new Float64Array([-45_000, 15_000, 75_000]),
      fields: {
        price: new Float64Array([-1, 0, 1]),
        volume: new Int16Array([-1, 0, 1]),
      },
      coverage: [{ start: -45_000, end: 15_000 }],
      misses: [{ range: { start: 75_000, end: 75_000 }, reason: "uncached" }],
    });
  });

  it("returns an uncovered live tail alongside its uncached miss", () => {
    const s = store();
    s.put(points([0, 1, 2, 3], [10, 11, 12, 13]));
    const index = new CoverageIndex();
    // Step 07 supplies coverage with the volatile region already excluded.
    index.add({ start: 0, end: 1 });

    expect(read({ start: 0, end: 3 }, s.segments, index, grid, schema)).toEqual(
      {
        timestamps: new Float64Array([3, 13, 23, 33]),
        fields: {
          price: new Float64Array([10, 11, 12, 13]),
          volume: new Int16Array([0, 1, 2, 3]),
        },
        coverage: [{ start: 3, end: 13 }],
        misses: [{ range: { start: 23, end: 33 }, reason: "uncached" }],
      },
    );
  });

  it("keeps invalidated points visible while reporting their slots as uncached", () => {
    const s = store();
    s.put(points([0, 1, 3, 5]));
    const index = new CoverageIndex();
    index.add({ start: 0, end: 5 });
    index.subtract({ start: 1, end: 3 });

    expect(read({ start: 0, end: 5 }, s.segments, index, grid, schema)).toEqual(
      {
        timestamps: new Float64Array([3, 13, 33, 53]),
        fields: {
          price: new Float64Array([0, 1, 3, 5]),
          volume: new Int16Array([0, 1, 3, 5]),
        },
        coverage: [
          { start: 3, end: 3 },
          { start: 43, end: 53 },
        ],
        misses: [{ range: { start: 13, end: 33 }, reason: "uncached" }],
      },
    );
  });

  it("returns a whole-request miss and zero timestamps when no segments exist", () => {
    const result: GetResult = read(
      { start: -2, end: 2 },
      [],
      new CoverageIndex(),
      grid,
      schema,
    );
    expect(result.timestamps).toEqual(new Float64Array(0));
    expect(result.coverage).toEqual([]);
    expect(result.misses).toEqual([
      { range: { start: -17, end: 23 }, reason: "uncached" },
    ]);
    // The no-segment field schema is unresolved in §4.4.
    for (const field of Object.values(result.fields))
      expect(field.length).toBe(0);
  });
});

describe("result field dtypes — architecture §2.3, §4.2, §4.4, N7, N10", () => {
  const config = resolveCacheConfig({
    id: "read-dtypes",
    ...grid,
    segmentSlotCap: 8,
    fields: {
      f64: "f64",
      f32: "f32",
      i32: "i32",
      u32: "u32",
      i16: "i16",
      u16: "u16",
      i8: "i8",
      u8: "u8",
    },
  });
  const selected: Columns["fields"] = {
    f64: new Float64Array([1.5, Number.NaN, Infinity]),
    f32: new Float32Array([1.25, Number.NaN, -Infinity]),
    i32: new Int32Array([-2_147_483_648, 0, 2_147_483_647]),
    u32: new Uint32Array([0, 42, 4_294_967_295]),
    i16: new Int16Array([-32_768, 0, 32_767]),
    u16: new Uint16Array([0, 321, 65_535]),
    i8: new Int8Array([-128, 0, 127]),
    u8: new Uint8Array([0, 7, 255]),
  };
  const empty: Columns["fields"] = {
    f64: new Float64Array(0),
    f32: new Float32Array(0),
    i32: new Int32Array(0),
    u32: new Uint32Array(0),
    i16: new Int16Array(0),
    u16: new Uint16Array(0),
    i8: new Int8Array(0),
    u8: new Uint8Array(0),
  };

  it.each([
    {
      name: "populated",
      request: { start: 7, end: 16 },
      slots: [7, 8, 16],
      timestamps: [73, 83, 163],
      fields: selected,
      missRange: { start: 73, end: 163 },
    },
    {
      name: "empty",
      request: { start: 32, end: 40 },
      slots: [],
      timestamps: [],
      fields: empty,
      missRange: { start: 323, end: 403 },
    },
  ])(
    "preserves every schema dtype in $name collect and read arrays",
    ({ request, slots, timestamps, fields, missRange }) => {
      const s = new SegmentStore(config);
      s.put({ slots: new Float64Array([7, 8, 16]), fields: selected });
      const columns: Columns = collect(s.segments, request, config.fields);
      const result: GetResult = read(
        request,
        s.segments,
        new CoverageIndex(),
        grid,
        config.fields,
      );

      expect(columns).toEqual({ slots: new Float64Array(slots), fields });
      expect(result).toEqual({
        timestamps: new Float64Array(timestamps),
        fields,
        coverage: [],
        misses: [{ range: missRange, reason: "uncached" }],
      });
      for (const [name, array] of Object.entries(fields)) {
        expect(columns.fields[name]).toBeInstanceOf(array.constructor);
        expect(result.fields[name]).toBeInstanceOf(array.constructor);
        expect(columns.fields[name]?.length).toBe(columns.slots.length);
        expect(result.fields[name]?.length).toBe(result.timestamps.length);
      }
    },
  );
});
