import { describe, expect, it } from "vitest";
import type { Grid, SlotRange } from "../src/grid";
import { DenseSegment } from "../src/segment/dense";
import { segmentFromPayload } from "../src/segment/payload";
import type { Columns, Segment } from "../src/segment/types";
import type { Dtype, FieldArray } from "../src/types";

// Contract tests: architecture §4.2. No split policy or engine behavior here.
const grid: Grid = { interval: 10, alignmentOffset: 3 };
const fields: Readonly<Record<string, Dtype>> = { price: "f64", volume: "i16" };
const options = { grid, fields, slotCap: 32_768 };

function points(slots: number[], prices = slots, volumes = slots): Columns {
  return {
    slots: new Float64Array(slots),
    fields: {
      price: new Float64Array(prices),
      volume: new Float64Array(volumes),
    },
  };
}

function populated(slotCap = options.slotCap): Segment {
  const segment = new DenseSegment({ ...options, slotCap });
  segment.mergeFrom(points([-2, 0, 2], [10, 20, 30], [1, 2, 3]));
  return segment;
}

function snapshot(segment: Segment) {
  return {
    extent: segment.extent === undefined ? undefined : { ...segment.extent },
    size: segment.size,
    columns: segment.slice({ start: -20, end: 20 }),
    payload: segment.size === 0 ? undefined : segment.transferPayload(),
    rows: Array.from({ length: 41 }, (_, i) => segment.lookup(i - 20)),
  };
}

function expectAtomicRejection(
  segment: Segment,
  input: Columns,
  authority?: SlotRange,
): void {
  const before = snapshot(segment);
  expect(() => segment.mergeFrom(input, authority)).toThrow(RangeError);
  expect(snapshot(segment)).toEqual(before);
}

describe("DenseSegment presence and reads — architecture §4.2", () => {
  it("starts empty, returns typed empty slices, and refuses an empty payload", () => {
    const segment: Segment = new DenseSegment(options);
    segment.mergeFrom(points([]));
    segment.mergeFrom(points([]), { start: -100, end: 100 });
    expect(segment.extent).toBeUndefined();
    expect(segment.size).toBe(0);
    expect(segment.lookup(0)).toBeUndefined();
    expect(segment.lookup(-1)).toBeUndefined();
    expect(segment.slice({ start: -10, end: 10 })).toEqual({
      slots: new Float64Array(),
      fields: { price: new Float64Array(), volume: new Int16Array() },
    });
    expect(() => segment.transferPayload()).toThrow(RangeError);
  });

  it("stores one negative slot on an offset grid and includes both slice endpoints", () => {
    const segment = new DenseSegment(options);
    segment.mergeFrom(points([-2], [42.5], [7]));
    expect(segment.extent).toEqual({ start: -2, end: -2 });
    expect(segment.size).toBe(1);
    expect(segment.lookup(-2)).toEqual({ price: 42.5, volume: 7 });
    expect(segment.lookup(-3)).toBeUndefined();
    expect(segment.lookup(-1)).toBeUndefined();
    expect(segment.slice({ start: -2, end: -2 })).toEqual({
      slots: new Float64Array([-2]),
      fields: { price: new Float64Array([42.5]), volume: new Int16Array([7]) },
    });
    expect(segment.transferPayload().start).toBe(-17);
  });

  it("distinguishes absent slots and outside slots from a present NaN row", () => {
    const segment = new DenseSegment(options);
    segment.mergeFrom(points([-2, 0, 2], [10, Number.NaN, 30], [1, 2, 3]));
    expect(segment.extent).toEqual({ start: -2, end: 2 });
    expect(segment.size).toBe(3);
    expect(segment.lookup(-2)).toEqual({ price: 10, volume: 1 });
    expect(segment.lookup(0)).toEqual({ price: Number.NaN, volume: 2 });
    expect(segment.lookup(2)).toEqual({ price: 30, volume: 3 });
    for (const slot of [-3, -1, 1, 3])
      expect(segment.lookup(slot)).toBeUndefined();
    expect(segment.slice({ start: 0, end: 0 }).fields.price).toEqual(
      new Float64Array([Number.NaN]),
    );
  });

  it.each([
    { name: "entire extent", range: { start: -2, end: 2 }, slots: [-2, 0, 2] },
    { name: "left clipped", range: { start: -10, end: 0 }, slots: [-2, 0] },
    { name: "right clipped", range: { start: 0, end: 10 }, slots: [0, 2] },
    {
      name: "both flanks beyond",
      range: { start: -10, end: 10 },
      slots: [-2, 0, 2],
    },
    {
      name: "single present endpoint",
      range: { start: 2, end: 2 },
      slots: [2],
    },
    { name: "single absent slot", range: { start: 1, end: 1 }, slots: [] },
    { name: "wholly before", range: { start: -10, end: -3 }, slots: [] },
    { name: "wholly after", range: { start: 3, end: 10 }, slots: [] },
  ])("slice returns present points only: $name", ({ range, slots }) => {
    const segment = new DenseSegment(options);
    segment.mergeFrom(points([-2, 0, 2]));
    expect(segment.slice(range)).toEqual({
      slots: new Float64Array(slots),
      fields: { price: new Float64Array(slots), volume: new Int16Array(slots) },
    });
  });

  it("lookup returns a fresh object with exactly the schema's fields", () => {
    const segment = populated();
    const first = segment.lookup(0);
    const second = segment.lookup(0);
    expect(first).toEqual({ price: 20, volume: 2 });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    if (first === undefined) throw new Error("Expected a present row");
    first.price = -999;
    first.extra = 1;
    delete first.volume;
    expect(segment.lookup(0)).toEqual({ price: 20, volume: 2 });
  });

  it("slice arrays are fresh, independent, and stable after later merges", () => {
    const segment = populated();
    const range = { start: -2, end: 2 };
    const first = segment.slice(range);
    const saved = segment.slice(range);
    expect(first.slots.buffer).not.toBe(saved.slots.buffer);
    for (const name of Object.keys(fields)) {
      const a = first.fields[name];
      const b = saved.fields[name];
      if (a === undefined || b === undefined) throw new Error("Missing field");
      expect(a.buffer).not.toBe(b.buffer);
      a.fill(-999);
    }
    first.slots.fill(999);
    expect(segment.slice(range)).toEqual(saved);
    segment.mergeFrom(points([0], [200], [20]));
    expect(saved).toEqual({
      slots: new Float64Array([-2, 0, 2]),
      fields: {
        price: new Float64Array([10, 20, 30]),
        volume: new Int16Array([1, 2, 3]),
      },
    });
  });
});

// Literal assignment expectations include truncation, wrapping and f32 rounding.
const dtypeCases: { dtype: Dtype; expected: FieldArray }[] = [
  {
    dtype: "f64",
    expected: new Float64Array([
      1.1,
      -1.9,
      257.9,
      65_537.9,
      4_294_967_297.9,
      Number.NaN,
    ]),
  },
  {
    dtype: "f32",
    expected: new Float32Array([
      Math.fround(1.1),
      Math.fround(-1.9),
      Math.fround(257.9),
      Math.fround(65_537.9),
      4_294_967_296,
      Number.NaN,
    ]),
  },
  { dtype: "i32", expected: new Int32Array([1, -1, 257, 65_537, 1, 0]) },
  {
    dtype: "u32",
    expected: new Uint32Array([1, 4_294_967_295, 257, 65_537, 1, 0]),
  },
  { dtype: "i16", expected: new Int16Array([1, -1, 257, 1, 1, 0]) },
  { dtype: "u16", expected: new Uint16Array([1, 65_535, 257, 1, 1, 0]) },
  { dtype: "i8", expected: new Int8Array([1, -1, 1, 1, 1, 0]) },
  { dtype: "u8", expected: new Uint8Array([1, 255, 1, 1, 1, 0]) },
];

describe("DenseSegment dtypes — architecture §4.2, N7", () => {
  it.each(dtypeCases)(
    "stores $dtype by typed-array assignment",
    ({ dtype, expected }) => {
      const segment = new DenseSegment({
        ...options,
        fields: { value: dtype },
      });
      segment.mergeFrom({
        slots: new Float64Array([0, 1, 2, 3, 4, 5]),
        fields: {
          value: new Float64Array([
            1.1,
            -1.9,
            257.9,
            65_537.9,
            4_294_967_297.9,
            Number.NaN,
          ]),
        },
      });
      const result = segment.slice({ start: 0, end: 5 });
      expect(result.fields.value).toBeInstanceOf(expected.constructor);
      expect(result.fields.value).toEqual(expected);
      expect(segment.size).toBe(6);
      Array.from(expected).forEach((value, slot) => {
        expect(segment.lookup(slot)).toEqual({ value });
      });
      // Overwriting must use the same conversion as the initial assignment.
      segment.mergeFrom({
        slots: new Float64Array([0]),
        fields: { value: new Float64Array([257.9]) },
      });
      expect(segment.lookup(0)).toEqual({ value: expected[2] });
      const empty = segment.slice({ start: 10, end: 10 }).fields.value;
      expect(empty).toBeInstanceOf(expected.constructor);
      expect(empty).toHaveLength(0);
    },
  );
});

describe("DenseSegment merge semantics — architecture §4.2, N11", () => {
  it("upsert overwrites whole rows, preserves omitted points and gaps, and grows both ways", () => {
    const segment = populated();
    segment.mergeFrom(
      points([-5, -1, 0, 5], [50, 11, 200, 55], [5, 11, 20, 55]),
    );
    expect(segment.extent).toEqual({ start: -5, end: 5 });
    expect(segment.size).toBe(6);
    expect(segment.slice({ start: -10, end: 10 })).toEqual({
      slots: new Float64Array([-5, -2, -1, 0, 2, 5]),
      fields: {
        price: new Float64Array([50, 10, 11, 200, 30, 55]),
        volume: new Int16Array([5, 1, 11, 20, 3, 55]),
      },
    });
    expect(segment.lookup(1)).toBeUndefined();
    const before = snapshot(segment);
    segment.mergeFrom(points([]));
    expect(snapshot(segment)).toEqual(before);
  });

  it("replace removes omitted points at inclusive authority endpoints but keeps both outside flanks", () => {
    const segment = new DenseSegment(options);
    segment.mergeFrom(points([-3, -2, -1, 0, 1, 2, 3]));
    segment.mergeFrom(points([0], [90], [9]), { start: -2, end: 2 });
    expect(segment.slice({ start: -10, end: 10 })).toEqual({
      slots: new Float64Array([-3, 0, 3]),
      fields: {
        price: new Float64Array([-3, 90, 3]),
        volume: new Int16Array([-3, 9, 3]),
      },
    });
    expect(segment.extent).toEqual({ start: -3, end: 3 });
    expect(segment.size).toBe(3);
    for (const slot of [-2, -1, 1, 2])
      expect(segment.lookup(slot)).toBeUndefined();
  });

  it("empty authority clears shrink the tight extent, then empty the segment and permit reuse", () => {
    const segment = populated();
    segment.mergeFrom(points([]), { start: -10, end: -1 });
    expect(segment.extent).toEqual({ start: 0, end: 2 });
    expect(segment.size).toBe(2);
    segment.mergeFrom(points([]), { start: 1, end: 10 });
    expect(segment.extent).toEqual({ start: 0, end: 0 });
    expect(segment.size).toBe(1);
    segment.mergeFrom(points([]), { start: 0, end: 0 });
    expect(segment.extent).toBeUndefined();
    expect(segment.size).toBe(0);
    expect(segment.lookup(0)).toBeUndefined();
    expect(segment.slice({ start: -10, end: 10 })).toEqual({
      slots: new Float64Array(),
      fields: { price: new Float64Array(), volume: new Int16Array() },
    });
    expect(() => segment.transferPayload()).toThrow(RangeError);
    segment.mergeFrom(points([-4], [40], [4]));
    expect(segment.extent).toEqual({ start: -4, end: -4 });
    expect(segment.lookup(-4)).toEqual({ price: 40, volume: 4 });
  });

  it("authority can extend beyond the cap because only the resulting present extent counts", () => {
    const segment = populated(5);
    segment.mergeFrom(points([10], [100], [10]), { start: -100, end: 100 });
    expect(segment.extent).toEqual({ start: 10, end: 10 });
    expect(segment.size).toBe(1);
    expect(segment.lookup(10)).toEqual({ price: 100, volume: 10 });
    segment.mergeFrom(points([]), { start: -100, end: -50 });
    expect(segment.extent).toEqual({ start: 10, end: 10 });
  });

  it("replacement checks the cap after deletions, allowing a disjoint move at cap one", () => {
    const segment = new DenseSegment({ ...options, slotCap: 1 });
    segment.mergeFrom(points([-10]));
    segment.mergeFrom(points([10]), { start: -10, end: 10 });
    expect(segment.extent).toEqual({ start: 10, end: 10 });
    expect(segment.size).toBe(1);
    expect(segment.lookup(-10)).toBeUndefined();
    expect(segment.lookup(10)).toEqual({ price: 10, volume: 10 });
  });

  it("copies input slots and field arrays, including views with nonzero byte offsets", () => {
    const segment = new DenseSegment(options);
    const slotStorage = new Float64Array([999, -2, 0, 2, 999]);
    const priceStorage = new Float64Array([999, 10, 20, 30, 999]);
    const volumeStorage = new Int16Array([999, 1, 2, 3, 999]);
    const input: Columns = {
      slots: slotStorage.subarray(1, 4),
      fields: {
        price: priceStorage.subarray(1, 4),
        volume: volumeStorage.subarray(1, 4),
      },
    };
    segment.mergeFrom(input);
    slotStorage.fill(100);
    priceStorage.fill(-100);
    volumeStorage.fill(-100);
    expect(snapshot(segment)).toEqual(snapshot(populated()));
    const replacement = points([0], [200], [20]);
    segment.mergeFrom(replacement, { start: -1, end: 1 });
    replacement.slots.fill(100);
    for (const array of Object.values(replacement.fields)) array.fill(-100);
    expect(segment.lookup(0)).toEqual({ price: 200, volume: 20 });
  });
});

describe("DenseSegment slot cap — architecture §4.2", () => {
  it.each([1, 8, 32_768])(
    "allows exactly %i slots, rejects one more in either direction atomically",
    (slotCap) => {
      const segment = new DenseSegment({ ...options, slotCap });
      const start = -7;
      const end = start + slotCap - 1;
      segment.mergeFrom(points(slotCap === 1 ? [start] : [start, end]));
      expect(segment.extent).toEqual({ start, end });
      expect(segment.transferPayload().count).toBe(slotCap);
      expectAtomicRejection(segment, points([end + 1]));
      expectAtomicRejection(segment, points([start - 1]));
    },
  );

  it("rejects an oversized first merge and an oversized replacement without partial writes or clears", () => {
    const empty = new DenseSegment({ ...options, slotCap: 5 });
    expectAtomicRejection(empty, points([-3, 2]));
    const segment = populated(5);
    expectAtomicRejection(segment, points([-3, 0, 2], [99, 99, 99]), {
      start: -10,
      end: 10,
    });
  });
});

const invalidSlots = [
  { name: "fraction", value: 0.5 },
  { name: "NaN", value: Number.NaN },
  { name: "+Infinity", value: Number.POSITIVE_INFINITY },
  { name: "-Infinity", value: Number.NEGATIVE_INFINITY },
  { name: "above safe-integer maximum", value: 2 ** 53 },
  { name: "below safe-integer minimum", value: -(2 ** 53) },
];
const invalidRanges = [
  ...invalidSlots.flatMap(({ name, value }) => [
    { name: `${name} start`, range: { start: value, end: 2 } },
    { name: `${name} end`, range: { start: -2, end: value } },
  ]),
  { name: "inverted endpoints", range: { start: 2, end: -2 } },
];

describe("DenseSegment programming-error rejection — architecture §4.2", () => {
  it.each(invalidSlots)(
    "lookup rejects $name with RangeError, even when empty",
    ({ value }) => {
      for (const segment of [new DenseSegment(options), populated()]) {
        expect(() => segment.lookup(value)).toThrow(RangeError);
      }
    },
  );

  it.each(invalidRanges)(
    "slice rejects $name with RangeError, even when empty",
    ({ range }) => {
      for (const segment of [new DenseSegment(options), populated()]) {
        expect(() => segment.slice(range)).toThrow(RangeError);
      }
    },
  );

  it.each(invalidRanges)(
    "mergeFrom rejects $name authority atomically, even for empty points",
    ({ range }) => {
      for (const input of [points([]), points([0], [999], [999])]) {
        expectAtomicRejection(populated(), input, range);
        expectAtomicRejection(new DenseSegment(options), input, range);
      }
    },
  );

  it.each(invalidSlots)(
    "mergeFrom rejects a $name slot atomically",
    ({ value }) => {
      expectAtomicRejection(populated(), points([value], [999], [999]));
      expectAtomicRejection(
        new DenseSegment(options),
        points([value], [999], [999]),
      );
    },
  );

  it.each([
    { name: "descending slots", slots: [1, 0] },
    { name: "duplicate slots", slots: [0, 0] },
    { name: "late duplicate", slots: [-1, 0, 0] },
    { name: "late invalid slot", slots: [-1, 0, Number.NaN] },
    { name: "late descending slot", slots: [-1, 1, 0] },
  ])("mergeFrom rejects $name before any mutation", ({ slots }) => {
    for (const authority of [undefined, { start: -2, end: 2 }]) {
      expectAtomicRejection(populated(), points(slots), authority);
    }
  });

  it.each([
    { name: "missing field", arrays: { price: new Float64Array([999]) } },
    {
      name: "extra field",
      arrays: {
        price: new Float64Array([999]),
        volume: new Int16Array([999]),
        extra: new Float64Array([999]),
      },
    },
    {
      name: "wrong field name",
      arrays: { price: new Float64Array([999]), other: new Int16Array([999]) },
    },
    {
      name: "short field",
      arrays: { price: new Float64Array(), volume: new Int16Array([999]) },
    },
    {
      name: "long field",
      arrays: {
        price: new Float64Array([999]),
        volume: new Int16Array([999, 999]),
      },
    },
  ])(
    "mergeFrom rejects $name atomically for upsert and replace",
    ({ arrays }) => {
      const input: Columns = { slots: new Float64Array([0]), fields: arrays };
      for (const authority of [undefined, { start: -2, end: 2 }]) {
        expectAtomicRejection(populated(), input, authority);
      }
    },
  );

  it("validates field names and lengths even when the slots array is empty", () => {
    expectAtomicRejection(
      populated(),
      { slots: new Float64Array(), fields: {} },
      { start: -2, end: 2 },
    );
    expectAtomicRejection(populated(), {
      slots: new Float64Array(),
      fields: { price: new Float64Array([1]), volume: new Int16Array() },
    });
  });

  it.each([
    { name: "before authority", slots: [-3, 0] },
    { name: "after authority", slots: [0, 3] },
  ])(
    "rejects a point $name without clearing or overwriting anything",
    ({ slots }) => {
      expectAtomicRejection(
        populated(),
        points(slots, [999, 999], [999, 999]),
        {
          start: -2,
          end: 2,
        },
      );
    },
  );

  it.each([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])(
    "accepts the safe slot boundary %i",
    (slot) => {
      // Unit interval makes these slots' timestamps representable as well.
      const segment = new DenseSegment({
        ...options,
        grid: { interval: 1, alignmentOffset: 0 },
        slotCap: 1,
      });
      segment.mergeFrom(points([slot], [42], [4]));
      expect(segment.extent).toEqual({ start: slot, end: slot });
      expect(segment.lookup(slot)).toEqual({ price: 42, volume: 4 });
      expect(segment.slice({ start: slot, end: slot }).slots).toEqual(
        new Float64Array([slot]),
      );
      expect(segment.transferPayload().start).toBe(slot);
    },
  );
});

function randomInt(seed: number): (min: number, max: number) => number {
  let state = seed >>> 0;
  return (min, max) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return min + (state % (max - min + 1));
  };
}

const universe: SlotRange = { start: -16, end: 16 };
type Row = { price: number; volume: number };

function expectModel(segment: Segment, model: Map<number, Row>): void {
  const slots = [...model.keys()].sort((a, b) => a - b);
  expect(segment.size).toBe(slots.length);
  expect(segment.extent).toEqual(
    slots.length === 0 ? undefined : { start: slots[0], end: slots.at(-1) },
  );
  for (let slot = universe.start - 1; slot <= universe.end + 1; slot += 1) {
    expect(segment.lookup(slot)).toEqual(model.get(slot));
  }
  for (const range of [
    universe,
    { start: -8, end: 7 },
    { start: 0, end: 0 },
    { start: -30, end: 30 },
  ]) {
    const selected = slots.filter(
      (slot) => range.start <= slot && slot <= range.end,
    );
    expect(segment.slice(range)).toEqual({
      slots: new Float64Array(selected),
      fields: {
        price: new Float64Array(
          selected.map((slot) => model.get(slot)?.price ?? Number.NaN),
        ),
        volume: new Int16Array(
          selected.map((slot) => model.get(slot)?.volume ?? 0),
        ),
      },
    });
  }
}

describe("DenseSegment seeded row-model properties — architecture §5, starter §6", () => {
  it.each([1, 0xc0ffee, 0xdeadbeef])(
    "upsert/replace sequences and payload round trips match a Map (seed %i)",
    (seed) => {
      const next = randomInt(seed);
      const segment = new DenseSegment(options);
      const model = new Map<number, Row>();
      for (let step = 0; step < 100; step += 1) {
        const a = next(universe.start, universe.end);
        const b = next(universe.start, universe.end);
        const authority =
          step % 3 === 0
            ? undefined
            : { start: Math.min(a, b), end: Math.max(a, b) };
        const inputSlots = new Set<number>();
        const n = next(0, 6);
        for (let i = 0; i < n; i += 1)
          inputSlots.add(
            next(
              authority?.start ?? universe.start,
              authority?.end ?? universe.end,
            ),
          );
        const slots = [...inputSlots].sort((x, y) => x - y);
        const prices = slots.map(() =>
          next(0, 9) === 0 ? Number.NaN : next(-1000, 1000) / 10,
        );
        const volumes = slots.map(() => next(-100_000, 100_000) + 0.75);
        if (authority !== undefined) {
          for (const slot of model.keys())
            if (authority.start <= slot && slot <= authority.end)
              model.delete(slot);
        }
        slots.forEach((slot, i) => {
          const price = prices[i];
          const volume = volumes[i];
          if (price === undefined || volume === undefined)
            throw new Error("Missing generated value");
          // Independent row model; language typed-array assignment is the specified conversion.
          model.set(slot, { price, volume: new Int16Array([volume])[0] ?? 0 });
        });
        segment.mergeFrom(points(slots, prices, volumes), authority);
        expectModel(segment, model);
        if (model.size > 0) {
          const payload = segment.transferPayload();
          const decoded = segmentFromPayload(structuredClone(payload), options);
          expectModel(decoded, model);
          expect(decoded.transferPayload()).toEqual(payload);
          // The reconstructed value remains usable at the same merge seam.
          decoded.mergeFrom(points([0], [777], [7]));
          const changedModel = new Map(model);
          changedModel.set(0, { price: 777, volume: 7 });
          expectModel(decoded, changedModel);
          expectModel(segment, model);
        } else {
          expect(() => segment.transferPayload()).toThrow(RangeError);
        }
      }
    },
  );
});
