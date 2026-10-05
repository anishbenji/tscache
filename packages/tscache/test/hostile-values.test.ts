import { describe, expect, it } from "vitest";
import { validateBatch } from "../src/engine/batch";
import { resolveCacheConfig } from "../src/engine/validate";
import { ConfigError, InvalidRangeError, PutError, show } from "../src/errors";
import { snapIn, snapOut } from "../src/grid";
import type { CacheConfig, PutBatch, Range } from "../src/types";

// Implementer tests (not contract tests): a value whose own string conversion
// throws must still produce the documented error, not a TypeError from the
// message being built.
const hostile: unknown[] = [
  Object.create(null),
  Symbol("bad"),
  [Object.create(null)],
  {
    toString() {
      throw new Error("no");
    },
  },
  () => 0,
];
const base = { id: "hostile", interval: 1, fields: { x: "f64" } } as const;
const config = resolveCacheConfig(base);
const grid = { interval: 1, alignmentOffset: 0 };

describe("show", () => {
  it("prints primitives and only names anything else", () => {
    expect([1.5, "a", null, undefined, true, Number.NaN].map(show)).toEqual([
      "1.5",
      "a",
      "null",
      "undefined",
      "true",
      "NaN",
    ]);
    for (const value of hostile) expect(typeof show(value)).toBe("string");
  });
});

describe.each(hostile.map((value) => ({ value })))("hostile value %#", ({
  value,
}) => {
  it("as a batch, a field, timestamps or one timestamp → PutError", () => {
    const batches = [
      value,
      { timestamps: [0], fields: { x: value } },
      { timestamps: value, fields: { x: [1] } },
      { timestamps: [value], fields: { x: [1] } },
      { timestamps: [0, value], fields: { x: [1, 2] } },
    ];
    for (const batch of batches) {
      expect(() => validateBatch(batch as PutBatch, config)).toThrow(PutError);
    }
  });

  it("as a field value → stored as a number, or PutError", () => {
    // A value that converts (a function becomes NaN) is legal; one that
    // cannot be converted rejects the batch.
    const batch = { timestamps: [0], fields: { x: [value] } };
    try {
      const { points } = validateBatch(batch as PutBatch, config);
      expect(points.fields.x).toEqual(new Float64Array([Number.NaN]));
    } catch (error) {
      expect(error).toBeInstanceOf(PutError);
      expect(error).toMatchObject({
        code: "field-mismatch",
        offenderIndex: -1,
      });
    }
  });

  it("as a range or a range endpoint → InvalidRangeError", () => {
    const ranges = [value, { start: value, end: 1 }, { start: 0, end: value }];
    const empty = { timestamps: [], fields: { x: [] } };
    for (const range of ranges) {
      expect(() => snapOut(range as Range, grid)).toThrow(InvalidRangeError);
      expect(() => snapIn(range as Range, grid)).toThrow(InvalidRangeError);
      expect(() => validateBatch(empty, config, range as Range)).toThrow(
        InvalidRangeError,
      );
    }
  });

  it("as a config or a config value → ConfigError", () => {
    const configs = [
      value,
      { ...base, id: value },
      { ...base, interval: value },
      { ...base, alignmentOffset: value },
      { ...base, fields: { x: value } },
      { ...base, gapSplitK: value },
      { ...base, segmentSlotCap: value },
      { ...base, version: value },
      { ...base, finalizedUntil: value },
      { ...base, warnOnOverlapDiff: value },
    ];
    for (const candidate of configs) {
      expect(() => resolveCacheConfig(candidate as CacheConfig)).toThrow(
        ConfigError,
      );
    }
  });
});
