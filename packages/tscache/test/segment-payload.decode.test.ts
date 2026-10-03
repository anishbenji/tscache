import { describe, expect, it } from "vitest";
import { TscacheError } from "../src/errors";
import { segmentFromPayload } from "../src/segment/payload";
import type { DenseSegmentPayload } from "../src/segment/types";
import type { Dtype } from "../src/types";

// Implementer tests (not contract tests): decoder behaviour for the three
// cases Codex reported as unspecified while writing the contract tests.
const grid = { interval: 10, alignmentOffset: 3 };
const fields: Readonly<Record<string, Dtype>> = { price: "f64", volume: "i16" };
const options = { grid, fields, slotCap: 32_768 };

function payload(): DenseSegmentPayload {
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

describe("segmentFromPayload — cases the contract left open", () => {
  it("accepts fields in any order and re-encodes them in schema order", () => {
    const reordered = payload();
    reordered.fields.reverse();
    const decoded = segmentFromPayload(reordered, options);
    expect(decoded.lookup(0)).toEqual({ price: 20, volume: 2 });
    expect(decoded.transferPayload()).toEqual(payload());
  });

  it("ignores values stored under absent slots and re-encodes them as zero", () => {
    const dirty = payload();
    new Float64Array(dirty.fields[0]?.data as ArrayBuffer)[1] = 999;
    new Int16Array(dirty.fields[1]?.data as ArrayBuffer)[3] = 99;
    const decoded = segmentFromPayload(dirty, options);
    expect(decoded.size).toBe(3);
    expect(decoded.lookup(-1)).toBeUndefined();
    expect(decoded.transferPayload()).toEqual(payload());
  });

  it("rejects a payload whose last slot has no safe-integer timestamp", () => {
    const unit = { interval: 1, alignmentOffset: 0 };
    const tail: DenseSegmentPayload = {
      format: 1,
      layout: "dense",
      start: Number.MAX_SAFE_INTEGER,
      count: 2,
      interval: 1,
      alignmentOffset: 0,
      mask: new Uint8Array([0x01]),
      fields: [
        { name: "price", dtype: "f64", data: new ArrayBuffer(16) },
        { name: "volume", dtype: "i16", data: new ArrayBuffer(4) },
      ],
    };
    const decode = () => segmentFromPayload(tail, { ...options, grid: unit });
    expect(decode).toThrow(TscacheError);
    expect(decode).toThrow(/safe-integer/);
    // The same payload with count 1 ends on the last safe timestamp.
    const edge = {
      ...tail,
      count: 1,
      fields: tail.fields.map((f) => ({
        ...f,
        data: new ArrayBuffer(f.dtype === "f64" ? 8 : 2),
      })),
    };
    expect(segmentFromPayload(edge, { ...options, grid: unit }).extent).toEqual(
      { start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER },
    );
  });
});
