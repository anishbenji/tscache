import { afterEach, describe, expect, it, vi } from "vitest";
import { DenseSegment } from "../src/segment/dense";
import { MAX_SLOT_CAP } from "../src/segment/types";

// Implementer tests (not contract tests).
const grid = { interval: 1, alignmentOffset: 0 };

describe("DenseSegment allocation failure", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps existing points when a replacement cannot allocate", () => {
    const segment = new DenseSegment({
      grid,
      fields: { v: "f64" },
      slotCap: 32_768,
    });
    segment.mergeFrom({
      slots: new Float64Array([0]),
      fields: { v: new Float64Array([42]) },
    });
    const replacement = {
      slots: new Float64Array([500, 1000]),
      fields: { v: new Float64Array([1, 2]) },
    };
    // The merge must grow the buffers; make that allocation fail.
    vi.stubGlobal(
      "Uint8Array",
      class {
        constructor() {
          throw new RangeError("Array buffer allocation failed");
        }
      },
    );
    expect(() =>
      segment.mergeFrom(replacement, { start: 0, end: 1000 }),
    ).toThrow(RangeError);
    vi.unstubAllGlobals();
    expect(segment.size).toBe(1);
    expect(segment.extent).toEqual({ start: 0, end: 0 });
    expect(segment.lookup(0)).toEqual({ v: 42 });
    // The same merge succeeds once allocation works again.
    segment.mergeFrom(replacement, { start: 0, end: 1000 });
    expect(segment.extent).toEqual({ start: 500, end: 1000 });
    expect(segment.lookup(0)).toBeUndefined();
  });
});

describe("DenseSegment failure while copying into new buffers", () => {
  const species = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Int16Array),
    Symbol.species,
  );

  afterEach(() => {
    // Remove the override so Int16Array inherits %TypedArray%'s species again.
    Reflect.deleteProperty(Int16Array, Symbol.species);
  });

  it("leaves every field intact when a later field's copy fails", () => {
    expect(species).toBeDefined();
    const segment = new DenseSegment({
      grid,
      fields: { a: "f64", b: "i16" },
      slotCap: 32_768,
    });
    segment.mergeFrom({
      slots: new Float64Array([0]),
      fields: { a: new Float64Array([42]), b: new Int16Array([7]) },
    });
    const prepend = {
      slots: new Float64Array([-100]),
      fields: { a: new Float64Array([1]), b: new Int16Array([2]) },
    };
    // subarray() builds its view through the species constructor; make the
    // second field's view fail after the first field has been copied.
    Object.defineProperty(Int16Array, Symbol.species, {
      configurable: true,
      get: () =>
        class {
          constructor() {
            throw new RangeError("Array buffer allocation failed");
          }
        },
    });
    expect(() => segment.mergeFrom(prepend)).toThrow(RangeError);
    Reflect.deleteProperty(Int16Array, Symbol.species);
    expect(segment.size).toBe(1);
    expect(segment.extent).toEqual({ start: 0, end: 0 });
    expect(segment.lookup(0)).toEqual({ a: 42, b: 7 });
    expect(segment.lookup(-100)).toBeUndefined();
    segment.mergeFrom(prepend);
    expect(segment.lookup(-100)).toEqual({ a: 1, b: 2 });
    expect(segment.lookup(0)).toEqual({ a: 42, b: 7 });
  });
});

describe("DenseSegment slot cap bound (N12)", () => {
  it.each([0, -1, 1.5, Number.NaN, MAX_SLOT_CAP + 1, Number.MAX_SAFE_INTEGER])(
    "rejects slotCap %d at construction",
    (slotCap) => {
      expect(
        () => new DenseSegment({ grid, fields: { v: "u8" }, slotCap }),
      ).toThrow(RangeError);
    },
  );

  it("accepts the largest supported cap without allocating for it", () => {
    expect(MAX_SLOT_CAP).toBe(2 ** 31 - 1);
    const segment = new DenseSegment({
      grid,
      fields: { v: "u8" },
      slotCap: MAX_SLOT_CAP,
    });
    segment.mergeFrom({
      slots: new Float64Array([7]),
      fields: { v: new Uint8Array([1]) },
    });
    expect(segment.lookup(7)).toEqual({ v: 1 });
  });
});
