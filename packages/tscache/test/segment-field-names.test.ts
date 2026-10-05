import { describe, expect, it } from "vitest";
import { DenseSegment } from "../src/segment/dense";
import { segmentFromPayload } from "../src/segment/payload";
import type { Columns } from "../src/segment/types";
import type { Dtype } from "../src/types";

// Implementer tests (not contract tests): field names that collide with
// Object.prototype members must behave like any other name.
const grid = { interval: 10, alignmentOffset: 0 };
const fields: Readonly<Record<string, Dtype>> = Object.fromEntries([
  ["__proto__", "f64"],
  ["constructor", "i16"],
  ["toString", "u8"],
]);
const options = { grid, fields, slotCap: 64 };

function point(slot: number, a: number, b: number, c: number): Columns {
  return {
    slots: new Float64Array([slot]),
    fields: Object.fromEntries([
      ["__proto__", new Float64Array([a])],
      ["constructor", new Int16Array([b])],
      ["toString", new Uint8Array([c])],
    ]),
  };
}

describe("segments with Object.prototype field names", () => {
  it("stores, looks up and slices them as own properties", () => {
    const segment = new DenseSegment(options);
    segment.mergeFrom(point(0, 42, 7, 9));
    const row = segment.lookup(0);
    if (row === undefined) throw new Error("expected a row");
    expect(Object.keys(row).sort()).toEqual([
      "__proto__",
      "constructor",
      "toString",
    ]);
    expect(Object.getOwnPropertyDescriptor(row, "__proto__")?.value).toBe(42);
    expect(row.constructor).toBe(7);
    expect(row.toString).toBe(9);

    const sliced = segment.slice({ start: 0, end: 0 });
    expect(Object.keys(sliced.fields).sort()).toEqual([
      "__proto__",
      "constructor",
      "toString",
    ]);
    expect(
      Object.getOwnPropertyDescriptor(sliced.fields, "__proto__")?.value,
    ).toEqual(new Float64Array([42]));
    // A slice feeds mergeFrom unchanged.
    const copy = new DenseSegment(options);
    copy.mergeFrom(sliced);
    expect(copy.transferPayload()).toEqual(segment.transferPayload());
  });

  it("round-trips them through a payload", () => {
    const segment = new DenseSegment(options);
    segment.mergeFrom(point(3, 1.5, -2, 200));
    const payload = segment.transferPayload();
    expect(payload.fields.map((f) => f.name)).toEqual([
      "__proto__",
      "constructor",
      "toString",
    ]);
    const decoded = segmentFromPayload(structuredClone(payload), options);
    expect(decoded.transferPayload()).toEqual(payload);
    expect(decoded.lookup(3)?.constructor).toBe(-2);
  });

  it("rejects a batch that only inherits a schema field name, atomically", () => {
    const one = { grid, fields: { constructor: "f64" } as const, slotCap: 64 };
    const segment = new DenseSegment(one);
    segment.mergeFrom({
      slots: new Float64Array([0]),
      fields: { constructor: new Float64Array([42]) },
    });
    const wrong: Columns = {
      slots: new Float64Array([0]),
      fields: { wrong: new Float64Array([9]) },
    };
    for (const authority of [undefined, { start: 0, end: 0 }]) {
      expect(() => segment.mergeFrom(wrong, authority)).toThrow(RangeError);
      expect(segment.lookup(0)?.constructor).toBe(42);
    }
  });
});
