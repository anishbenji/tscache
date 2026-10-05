import { describe, expect, it } from "vitest";
import { TscacheError } from "../src/errors";
import type { Grid } from "../src/grid";
import { DenseSegment } from "../src/segment/dense";
import { segmentFromPayload } from "../src/segment/payload";
import type { Columns, Segment } from "../src/segment/types";
import type { Dtype, FieldArray } from "../src/types";

type Payload = ReturnType<Segment["transferPayload"]>;
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

// A literal wire fixture tests the decoder independently of the encoder.
function fixture(): Payload {
  return {
    format: 1,
    layout: "dense",
    start: -17,
    count: 5,
    interval: 10,
    alignmentOffset: 3,
    mask: new Uint8Array([0x15]),
    fields: [
      {
        name: "price",
        dtype: "f64",
        data: new Float64Array([10, 0, 20, 0, 30]).buffer,
      },
      {
        name: "volume",
        dtype: "i16",
        data: new Int16Array([1, 0, 2, 0, 3]).buffer,
      },
    ],
  };
}

function field(payload: Payload, name: string): Payload["fields"][number] {
  const result = payload.fields.find((entry) => entry.name === name);
  if (result === undefined) throw new Error(`Missing payload field ${name}`);
  return result;
}

function expectFixtureRows(segment: Segment): void {
  expect(segment.extent).toEqual({ start: -2, end: 2 });
  expect(segment.size).toBe(3);
  expect(segment.slice({ start: -10, end: 10 })).toEqual({
    slots: new Float64Array([-2, 0, 2]),
    fields: {
      price: new Float64Array([10, 20, 30]),
      volume: new Int16Array([1, 2, 3]),
    },
  });
  expect(segment.lookup(-2)).toEqual({ price: 10, volume: 1 });
  expect(segment.lookup(0)).toEqual({ price: 20, volume: 2 });
  expect(segment.lookup(2)).toEqual({ price: 30, volume: 3 });
  for (const slot of [-3, -1, 1, 3])
    expect(segment.lookup(slot)).toBeUndefined();
}

describe("DenseSegment payload layout — architecture §3.4, §4.2", () => {
  it("encodes a sparse offset-grid segment as the specified self-describing object", () => {
    const segment = new DenseSegment(options);
    segment.mergeFrom(points([-2, 0, 2], [10, 20, 30], [1, 2, 3]));
    const payload = segment.transferPayload();
    expect(payload).toEqual(fixture());
    expect([Object.prototype, null]).toContain(Object.getPrototypeOf(payload));
    expect(payload.mask).toBeInstanceOf(Uint8Array);
    for (const entry of payload.fields) {
      expect([Object.prototype, null]).toContain(Object.getPrototypeOf(entry));
      expect(entry.data).toBeInstanceOf(ArrayBuffer);
    }
  });

  it.each([
    { count: 1, slots: [0], bytes: [0x01] },
    { count: 7, slots: [0, 3, 6], bytes: [0x49] },
    { count: 8, slots: [0, 3, 7], bytes: [0x89] },
    { count: 9, slots: [0, 3, 7, 8], bytes: [0x89, 0x01] },
    { count: 16, slots: [0, 3, 7, 8, 15], bytes: [0x89, 0x81] },
    { count: 17, slots: [0, 3, 7, 8, 15, 16], bytes: [0x89, 0x81, 0x01] },
  ])("count $count has exactly ceil(count/8) bytes, low-bit-first presence, and zero trailing bits", ({
    count,
    slots,
    bytes,
  }) => {
    const segment = new DenseSegment(options);
    segment.mergeFrom(points(slots));
    const payload = segment.transferPayload();
    expect(payload.count).toBe(count);
    expect(payload.mask).toEqual(new Uint8Array(bytes));
    expect(payload.mask.byteLength).toBe(Math.ceil(count / 8));
    expect(field(payload, "price").data.byteLength).toBe(count * 8);
    expect(field(payload, "volume").data.byteLength).toBe(count * 2);
  });

  it("clears deleted-slot mask bits and emits zeros for all absent field values", () => {
    const segment = new DenseSegment(options);
    segment.mergeFrom(
      points([0, 1, 2, 3, 4], [10, 11, 12, 13, 14], [1, 2, 3, 4, 5]),
    );
    segment.mergeFrom(points([2], [22], [2]), { start: 1, end: 3 });
    const payload = segment.transferPayload();
    expect(payload.mask).toEqual(new Uint8Array([0x15]));
    expect(new Float64Array(field(payload, "price").data)).toEqual(
      new Float64Array([10, 0, 22, 0, 14]),
    );
    expect(new Int16Array(field(payload, "volume").data)).toEqual(
      new Int16Array([1, 0, 2, 0, 5]),
    );
    const equivalent = new DenseSegment(options);
    equivalent.mergeFrom(points([0, 2, 4], [10, 22, 14], [1, 2, 5]));
    expect(payload).toEqual(equivalent.transferPayload());
  });

  it("shrinking an extent rebases the mask, start timestamp, count, and field buffers", () => {
    const segment = new DenseSegment(options);
    segment.mergeFrom(points([-8, -1, 0, 8]));
    segment.mergeFrom(points([]), { start: -8, end: -2 });
    segment.mergeFrom(points([]), { start: 1, end: 8 });
    const payload = segment.transferPayload();
    expect(payload.start).toBe(-7);
    expect(payload.count).toBe(2);
    expect(payload.mask).toEqual(new Uint8Array([0x03]));
    expect(new Float64Array(field(payload, "price").data)).toEqual(
      new Float64Array([-1, 0]),
    );
    expect(new Int16Array(field(payload, "volume").data)).toEqual(
      new Int16Array([-1, 0]),
    );
  });

  it("emits fields in schema declaration order regardless of input field order", () => {
    const segment = new DenseSegment({
      ...options,
      fields: { zeta: "i16", alpha: "f64", middle: "u8" },
    });
    segment.mergeFrom({
      slots: new Float64Array([0]),
      fields: {
        middle: new Uint8Array([3]),
        alpha: new Float64Array([2]),
        zeta: new Int16Array([1]),
      },
    });
    expect(
      segment
        .transferPayload()
        .fields.map(({ name, dtype }) => ({ name, dtype })),
    ).toEqual([
      { name: "zeta", dtype: "i16" },
      { name: "alpha", dtype: "f64" },
      { name: "middle", dtype: "u8" },
    ]);
  });

  it("returns fresh buffers for every transfer and keeps old payloads stable after a merge", () => {
    const segment = new DenseSegment(options);
    segment.mergeFrom(points([-2, 0, 2], [10, 20, 30], [1, 2, 3]));
    const first = segment.transferPayload();
    const saved = segment.transferPayload();
    expect(first).not.toBe(saved);
    expect(first.mask.buffer).not.toBe(saved.mask.buffer);
    expect(first.fields).not.toBe(saved.fields);
    const buffers = [
      first.mask.buffer,
      ...first.fields.map(({ data }) => data),
    ];
    expect(new Set(buffers).size).toBe(buffers.length);
    for (const entry of first.fields) {
      expect(entry).not.toBe(field(saved, entry.name));
      expect(entry.data).not.toBe(field(saved, entry.name).data);
      new Uint8Array(entry.data).fill(0xff);
    }
    first.mask.fill(0);
    first.start = 999;
    first.fields.reverse();
    expectFixtureRows(segment);
    expect(segment.transferPayload()).toEqual(fixture());
    segment.mergeFrom(points([0], [200], [20]));
    expect(saved).toEqual(fixture());
  });

  it("supports structured cloning and transferring every copied buffer without detaching segment data", () => {
    const segment = new DenseSegment(options);
    segment.mergeFrom(points([-2, 0, 2], [10, 20, 30], [1, 2, 3]));
    const payload = segment.transferPayload();
    const cloned = structuredClone(payload);
    expect(cloned).toEqual(fixture());
    expect(cloned.mask.buffer).not.toBe(payload.mask.buffer);
    for (const entry of cloned.fields)
      expect(entry.data).not.toBe(field(payload, entry.name).data);
    const moved = structuredClone(payload, {
      transfer: [
        payload.mask.buffer,
        ...payload.fields.map(({ data }) => data),
      ],
    });
    expect(payload.mask.byteLength).toBe(0);
    for (const entry of payload.fields) expect(entry.data.byteLength).toBe(0);
    expect(moved).toEqual(fixture());
    expectFixtureRows(segment);
    expect(segment.transferPayload()).toEqual(fixture());
    expectFixtureRows(segmentFromPayload(moved, options));
  });
});

const dtypeCases: {
  dtype: Dtype;
  value: number;
  array: FieldArray;
  bytes: number[];
}[] = [
  {
    dtype: "f64",
    value: 1.5,
    array: new Float64Array([1.5]),
    bytes: [0, 0, 0, 0, 0, 0, 0xf8, 0x3f],
  },
  {
    dtype: "f32",
    value: 1.5,
    array: new Float32Array([1.5]),
    bytes: [0, 0, 0xc0, 0x3f],
  },
  {
    dtype: "i32",
    value: -2,
    array: new Int32Array([-2]),
    bytes: [0xfe, 0xff, 0xff, 0xff],
  },
  {
    dtype: "u32",
    value: 0x12345678,
    array: new Uint32Array([0x12345678]),
    bytes: [0x78, 0x56, 0x34, 0x12],
  },
  { dtype: "i16", value: -2, array: new Int16Array([-2]), bytes: [0xfe, 0xff] },
  {
    dtype: "u16",
    value: 0x1234,
    array: new Uint16Array([0x1234]),
    bytes: [0x34, 0x12],
  },
  { dtype: "i8", value: -2, array: new Int8Array([-2]), bytes: [0xfe] },
  { dtype: "u8", value: 0xab, array: new Uint8Array([0xab]), bytes: [0xab] },
];

describe("Payload dtypes and round trips — architecture §3.4, §4.2, N7, N10", () => {
  it.each(
    dtypeCases,
  )("$dtype has correctly sized little-endian bytes, zero absent values, and decodes to its dtype", ({
    dtype,
    value,
    array,
    bytes,
  }) => {
    const dtypeOptions = { ...options, fields: { value: dtype } };
    const segment = new DenseSegment(dtypeOptions);
    segment.mergeFrom({
      slots: new Float64Array([-1, 1]),
      fields: { value: new Float64Array([value, value]) },
    });
    const payload = segment.transferPayload();
    expect(payload.fields).toHaveLength(1);
    const entry = field(payload, "value");
    expect(entry.dtype).toBe(dtype);
    const denseBytes = new Uint8Array([
      ...bytes,
      ...new Uint8Array(bytes.length),
      ...bytes,
    ]);
    expect(entry.data.byteLength).toBe(bytes.length * 3);
    expect(new Uint8Array(entry.data)).toEqual(denseBytes);
    // Decode manually supplied bytes, not just the encoder's output.
    const manual: Payload = {
      format: 1,
      layout: "dense",
      start: -7,
      count: 3,
      interval: 10,
      alignmentOffset: 3,
      mask: new Uint8Array([5]),
      fields: [{ name: "value", dtype, data: denseBytes.buffer }],
    };
    for (const decoded of [
      segmentFromPayload(manual, dtypeOptions),
      segmentFromPayload(structuredClone(payload), dtypeOptions),
    ]) {
      expect(decoded.extent).toEqual({ start: -1, end: 1 });
      expect(decoded.size).toBe(2);
      expect(decoded.lookup(-1)).toEqual({ value });
      expect(decoded.lookup(0)).toBeUndefined();
      expect(decoded.lookup(1)).toEqual({ value });
      const result = decoded.slice({ start: -2, end: 0 }).fields.value;
      expect(result).toBeInstanceOf(array.constructor);
      expect(result).toEqual(array);
      expect(decoded.transferPayload()).toEqual(payload);
    }
  });

  it("round trips NaN as present for both floating dtypes beside absent slots", () => {
    const nanOptions = {
      ...options,
      fields: { double: "f64", single: "f32", integer: "i8" } satisfies Record<
        string,
        Dtype
      >,
    };
    const segment = new DenseSegment(nanOptions);
    segment.mergeFrom({
      slots: new Float64Array([-1, 1]),
      fields: {
        double: new Float64Array([Number.NaN, 3]),
        single: new Float64Array([Number.NaN, 3]),
        integer: new Int8Array([0, 3]),
      },
    });
    const payload = segment.transferPayload();
    const decoded = segmentFromPayload(structuredClone(payload), nanOptions);
    expect(decoded.size).toBe(2);
    expect(decoded.lookup(-1)).toEqual({
      double: Number.NaN,
      single: Number.NaN,
      integer: 0,
    });
    expect(decoded.lookup(0)).toBeUndefined();
    expect(decoded.lookup(1)).toEqual({ double: 3, single: 3, integer: 3 });
    expect(decoded.slice({ start: -10, end: 10 })).toEqual(
      segment.slice({ start: -10, end: 10 }),
    );
    expect(decoded.transferPayload()).toEqual(payload);
  });
});

describe("segmentFromPayload valid decoding — architecture §4.2", () => {
  it("decodes the independent fixture on a nonzero-offset grid", () => {
    const decoded: Segment = segmentFromPayload(fixture(), options);
    expectFixtureRows(decoded);
    expect(decoded.transferPayload()).toEqual(fixture());
    decoded.mergeFrom(points([0], [200], [20]), { start: -1, end: 1 });
    expect(decoded.lookup(0)).toEqual({ price: 200, volume: 20 });
  });

  it("copies incoming mask and buffers so later mutations and transfer cannot affect the segment", () => {
    const payload = fixture();
    const decoded = segmentFromPayload(payload, options);
    payload.mask.fill(0);
    for (const entry of payload.fields) new Uint8Array(entry.data).fill(0);
    payload.start = 999;
    payload.fields.reverse();
    expectFixtureRows(decoded);
    const source = fixture();
    const second = segmentFromPayload(source, options);
    structuredClone(source, {
      transfer: [source.mask.buffer, ...source.fields.map(({ data }) => data)],
    });
    expectFixtureRows(second);
  });

  it("does not mutate the incoming payload when the decoded segment is later modified", () => {
    const payload = fixture();
    const decoded = segmentFromPayload(payload, options);
    decoded.mergeFrom(points([0], [999], [99]), { start: -2, end: 2 });
    expect(payload).toEqual(fixture());
    expect(decoded.extent).toEqual({ start: 0, end: 0 });
  });

  it("tightens absent flanks and rebases a payload crossing a mask-byte boundary", () => {
    const payload: Payload = {
      format: 1,
      layout: "dense",
      start: -37,
      count: 9,
      interval: 10,
      alignmentOffset: 3,
      mask: new Uint8Array([0x80, 0]),
      fields: [
        {
          name: "price",
          dtype: "f64",
          data: new Float64Array([0, 0, 0, 0, 0, 0, 0, 42, 0]).buffer,
        },
        {
          name: "volume",
          dtype: "i16",
          data: new Int16Array([0, 0, 0, 0, 0, 0, 0, 4, 0]).buffer,
        },
      ],
    };
    const decoded = segmentFromPayload(payload, options);
    expect(decoded.extent).toEqual({ start: 3, end: 3 });
    expect(decoded.size).toBe(1);
    expect(decoded.lookup(3)).toEqual({ price: 42, volume: 4 });
    for (const slot of [-4, 2, 4]) expect(decoded.lookup(slot)).toBeUndefined();
    const encoded = decoded.transferPayload();
    expect(encoded.start).toBe(33);
    expect(encoded.count).toBe(1);
    expect(encoded.mask).toEqual(new Uint8Array([1]));
    expect(new Float64Array(field(encoded, "price").data)).toEqual(
      new Float64Array([42]),
    );
  });

  it("decodes a valid all-zero mask to an empty segment", () => {
    const payload = fixture();
    payload.mask.fill(0);
    for (const entry of payload.fields) new Uint8Array(entry.data).fill(0);
    const decoded = segmentFromPayload(payload, options);
    expect(decoded.extent).toBeUndefined();
    expect(decoded.size).toBe(0);
    expect(decoded.lookup(-2)).toBeUndefined();
    expect(decoded.slice({ start: -10, end: 10 })).toEqual({
      slots: new Float64Array(),
      fields: { price: new Float64Array(), volume: new Int16Array() },
    });
    expect(() => decoded.transferPayload()).toThrow(RangeError);
  });

  it("accepts a payload exactly at the configured slot cap", () => {
    const count = options.slotCap;
    const mask = new Uint8Array(count / 8);
    mask[0] = 1;
    mask[mask.length - 1] = 0x80;
    const payload: Payload = {
      format: 1,
      layout: "dense",
      start: -17,
      count,
      interval: 10,
      alignmentOffset: 3,
      mask,
      fields: [
        { name: "price", dtype: "f64", data: new ArrayBuffer(count * 8) },
        { name: "volume", dtype: "i16", data: new ArrayBuffer(count * 2) },
      ],
    };
    const decoded = segmentFromPayload(payload, options);
    expect(decoded.size).toBe(2);
    expect(decoded.extent).toEqual({ start: -2, end: 32_765 });
    expect(decoded.lookup(-2)).toEqual({ price: 0, volume: 0 });
    expect(decoded.lookup(32_765)).toEqual({ price: 0, volume: 0 });
    expect(decoded.transferPayload()).toEqual(payload);
  });
});

// Invalid wire values deliberately cross the static type boundary. The tests
// retain the §4.2 call signature rather than inventing a broader decoder API.
function expectDecodeRejection(value: unknown, context: RegExp): void {
  let error: unknown;
  try {
    segmentFromPayload(value as Payload, options);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TscacheError);
  if (!(error instanceof TscacheError))
    throw new Error("Expected TscacheError");
  expect(error.constructor).toBe(TscacheError);
  expect(error.message.trim().length).toBeGreaterThan(0);
  expect(error.message).toMatch(context);
}

describe("segmentFromPayload rejection — architecture §4.2, N10", () => {
  it.each([
    0,
    2,
    "1",
    undefined,
  ])("rejects format %s with plain, descriptive TscacheError", (format) => {
    expectDecodeRejection({ ...fixture(), format }, /format|version/i);
  });

  it.each([
    "columnar",
    "",
    1,
    undefined,
  ])("rejects layout %s with plain, descriptive TscacheError", (layout) => {
    expectDecodeRejection({ ...fixture(), layout }, /layout|dense/i);
  });

  it.each([
    0,
    11,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
  ])("rejects interval %s differing from the grid", (interval) => {
    expectDecodeRejection({ ...fixture(), interval }, /interval|grid/i);
  });

  it.each([
    0,
    4,
    Number.NaN,
    undefined,
  ])("rejects alignmentOffset %s differing from the grid", (alignmentOffset) => {
    expectDecodeRejection(
      { ...fixture(), alignmentOffset },
      /offset|alignment|grid/i,
    );
  });

  it.each([
    -18,
    -17.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    2 ** 53,
    -(2 ** 53),
    undefined,
  ])("rejects unaligned or out-of-domain start %s", (start) => {
    expectDecodeRejection(
      { ...fixture(), start },
      /start|align|timestamp|grid|safe/i,
    );
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    2 ** 53,
    undefined,
  ])("rejects non-positive or non-safe count %s", (count) => {
    expectDecodeRejection({ ...fixture(), count }, /count|slot|integer|cap/i);
  });

  it("rejects a fully sized payload one slot past the cap", () => {
    const count = options.slotCap + 1;
    expectDecodeRejection(
      {
        ...fixture(),
        count,
        mask: new Uint8Array(Math.ceil(count / 8)),
        fields: [
          { name: "price", dtype: "f64", data: new ArrayBuffer(count * 8) },
          { name: "volume", dtype: "i16", data: new ArrayBuffer(count * 2) },
        ],
      },
      /count|slot|cap|limit/i,
    );
  });

  it.each([
    { name: "number array", mask: [0x15] },
    { name: "Uint16Array", mask: new Uint16Array([0x15]) },
    { name: "ArrayBuffer", mask: new ArrayBuffer(1) },
    { name: "DataView", mask: new DataView(new ArrayBuffer(1)) },
    { name: "missing", mask: undefined },
    { name: "too short", mask: new Uint8Array() },
    { name: "too long", mask: new Uint8Array([0x15, 0]) },
  ])("rejects a $name mask", ({ mask }) => {
    expectDecodeRejection({ ...fixture(), mask }, /mask|presence/i);
  });

  it.each([
    0x20, 0x40, 0x80,
  ])("rejects each unused trailing bit in a five-slot mask (%i)", (bit) => {
    expectDecodeRejection(
      { ...fixture(), mask: new Uint8Array([0x15 | bit]) },
      /mask|trailing|unused|padding/i,
    );
  });

  it("rejects trailing bits in the last byte of a multi-byte mask", () => {
    expectDecodeRejection(
      {
        ...fixture(),
        count: 9,
        mask: new Uint8Array([0x81, 0x03]),
        fields: [
          { name: "price", dtype: "f64", data: new ArrayBuffer(9 * 8) },
          { name: "volume", dtype: "i16", data: new ArrayBuffer(9 * 2) },
        ],
      },
      /mask|trailing|unused|padding/i,
    );
  });

  it.each([
    "missing",
    "extra",
    "renamed",
    "duplicate",
  ])("rejects %s schema fields", (kind) => {
    const payload = fixture();
    const price = field(payload, "price");
    const volume = field(payload, "volume");
    const invalid =
      kind === "missing"
        ? [price]
        : kind === "extra"
          ? [
              price,
              volume,
              { name: "extra", dtype: "u8", data: new ArrayBuffer(5) },
            ]
          : kind === "renamed"
            ? [price, { ...volume, name: "other" }]
            : [price, { ...volume, name: "price" }];
    expectDecodeRejection(
      { ...payload, fields: invalid },
      /field|schema|name/i,
    );
  });

  it.each([
    { name: "missing", entries: undefined },
    { name: "null", entries: null },
    { name: "object instead of array", entries: {} },
    { name: "empty array", entries: [] },
    {
      name: "entry without a name",
      entries: [
        { dtype: "f64", data: new ArrayBuffer(40) },
        { name: "volume", dtype: "i16", data: new ArrayBuffer(10) },
      ],
    },
  ])("rejects a $name fields collection", ({ entries }) => {
    expectDecodeRejection(
      { ...fixture(), fields: entries },
      /field|schema|name/i,
    );
  });

  it.each([
    "f32",
    "i64",
    undefined,
  ])("rejects field dtype %s that does not match the schema", (dtype) => {
    const payload = fixture();
    expectDecodeRejection(
      {
        ...payload,
        fields: [
          { ...field(payload, "price"), dtype },
          field(payload, "volume"),
        ],
      },
      /dtype|type|field|schema/i,
    );
  });

  it.each([
    "price",
    "volume",
  ])("rejects short and long %s field buffers", (name) => {
    for (const difference of [-1, 1]) {
      const payload = fixture();
      const entry = field(payload, name);
      entry.data = new ArrayBuffer(entry.data.byteLength + difference);
      expectDecodeRejection(payload, /buffer|byte|length|size|field/i);
    }
  });

  it.each([
    { name: "typed-array view", data: new Float64Array(5) },
    { name: "DataView", data: new DataView(new ArrayBuffer(40)) },
    { name: "number array", data: [10, 0, 20, 0, 30] },
    { name: "missing", data: undefined },
  ])("rejects $name instead of an ArrayBuffer field", ({ data }) => {
    const payload = fixture();
    expectDecodeRejection(
      {
        ...payload,
        fields: [
          { ...field(payload, "price"), data },
          field(payload, "volume"),
        ],
      },
      /buffer|data|field|type/i,
    );
  });

  it("rejects correctly sized buffers paired with the wrong schema dtypes", () => {
    const payload = fixture();
    expectDecodeRejection(
      {
        ...payload,
        fields: [
          { name: "price", dtype: "f32", data: new ArrayBuffer(20) },
          field(payload, "volume"),
        ],
      },
      /dtype|type|field|schema/i,
    );
  });
});
