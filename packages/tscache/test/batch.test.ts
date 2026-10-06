import { describe, expect, it } from "vitest";
import { validateBatch } from "../src/engine/batch";
import { resolveCacheConfig } from "../src/engine/validate";
import type { PutBatch } from "../src/types";

const config = resolveCacheConfig({
  id: "batch",
  interval: 10,
  alignmentOffset: 3,
  fields: { price: "f64", volume: "i32" },
});
const batch: PutBatch = {
  timestamps: [-17, 3, 23],
  fields: { volume: [1.9, -2.9, 3.9], price: [10, Number.NaN, 30] },
};

describe("validateBatch accepted inputs — architecture §2.2, §2.4, §4.3", () => {
  it("converts sorted offset-aligned timestamps to slots and schema dtypes", () => {
    expect(validateBatch(batch, config)).toEqual({
      points: {
        slots: new Float64Array([-2, 0, 2]),
        fields: {
          price: new Float64Array([10, Number.NaN, 30]),
          volume: new Int32Array([1, -2, 3]),
        },
      },
      authority: undefined,
    });
  });

  it("copies typed-array views and neither mutates nor retains its input", () => {
    const timestamps = new Float64Array([999, -17, 3, 23, 999]);
    const price = new Float32Array([999, 10, 20, 30, 999]);
    const volume = [1.9, -2.9, 3.9];
    const input = {
      timestamps: timestamps.subarray(1, 4),
      fields: { price: price.subarray(1, 4), volume },
    };
    const before = structuredClone(input);
    const range = { start: -18, end: 24 };
    const result = validateBatch(input, config, range);
    expect(input).toEqual(before);
    expect(range).toEqual({ start: -18, end: 24 });
    timestamps.fill(0);
    price.fill(0);
    volume.fill(0);
    range.start = 100;
    expect(result.points.slots).toEqual(new Float64Array([-2, 0, 2]));
    expect(result.points.fields.price).toEqual(new Float64Array([10, 20, 30]));
    expect(result.points.fields.volume).toEqual(new Int32Array([1, -2, 3]));
    expect(result.authority).toEqual({ start: -2, end: 2 });
    result.points.fields.price?.fill(7);
    expect(price).toEqual(new Float32Array(5));
  });

  it.each([
    new Float64Array([1.5]),
    new Float32Array([1.5]),
    new Int32Array([1]),
    new Uint32Array([1]),
    new Int16Array([1]),
    new Uint16Array([1]),
    new Int8Array([1]),
    new Uint8Array([1]),
    new Uint8ClampedArray([1]),
    [1.5],
  ])("accepts numeric field array %j independently of the schema dtype", (values) => {
    const result = validateBatch(
      { timestamps: [3], fields: { price: values, volume: values } },
      config,
    );
    expect(result.points.fields.price).toEqual(new Float64Array(values));
    expect(result.points.fields.volume).toEqual(new Int32Array(values));
  });

  it("converts all eight schema dtypes by typed-array assignment", () => {
    const all = resolveCacheConfig({
      id: "dtypes",
      interval: 1,
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
    const values = [1.1, -1.9, 65_537.9, 4_294_967_297.9, Number.NaN];
    const fields = Object.fromEntries(
      Object.keys(all.fields).map((name) => [name, values]),
    );
    expect(
      validateBatch({ timestamps: [0, 1, 2, 3, 4], fields }, all).points.fields,
    ).toEqual({
      f64: new Float64Array(values),
      f32: new Float32Array(values),
      i32: new Int32Array(values),
      u32: new Uint32Array(values),
      i16: new Int16Array(values),
      u16: new Uint16Array(values),
      i8: new Int8Array(values),
      u8: new Uint8Array(values),
    });
  });

  it.each([
    { start: -17, end: 23 },
    { start: -18.5, end: 24.5 },
  ])("snaps explicit authority inward and keeps inclusive endpoints: %j", (range) => {
    expect(validateBatch(batch, config, range).authority).toEqual({
      start: -2,
      end: 2,
    });
  });

  it("accepts a one-point batch with one-slot authority", () => {
    expect(
      validateBatch(
        { timestamps: [3], fields: { price: [7], volume: [8] } },
        config,
        { start: 3, end: 3 },
      ).authority,
    ).toEqual({ start: 0, end: 0 });
  });

  it("empty batches have no default authority, retain explicit authority, and claim no gridless range", () => {
    const empty = { timestamps: [], fields: { price: [], volume: [] } };
    expect(validateBatch(empty, config)).toEqual({
      points: {
        slots: new Float64Array(),
        fields: { price: new Float64Array(), volume: new Int32Array() },
      },
      authority: undefined,
    });
    expect(
      validateBatch(empty, config, { start: -16, end: 22 }).authority,
    ).toEqual({ start: -1, end: 1 });
    expect(
      validateBatch(empty, config, { start: 4, end: 12 }).authority,
    ).toBeUndefined();
  });

  it.each([
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  ])("accepts safe timestamp %i", (t) => {
    const unit = resolveCacheConfig({
      id: "unit",
      interval: 1,
      fields: { x: "f64" },
    });
    expect(
      validateBatch({ timestamps: [t], fields: { x: [1] } }, unit).points.slots,
    ).toEqual(new Float64Array([t]));
  });

  it("leaves metadata handling to step 07", () => {
    const input = { ...batch, meta: { version: "v2", finalizedUntil: 13 } };
    expect(validateBatch(input, config)).toEqual(validateBatch(batch, config));
  });
});
