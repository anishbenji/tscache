import { describe, expect, it } from "vitest";
import { validateBatch } from "../src/engine/batch";
import { CacheState } from "../src/engine/cache";
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

describe.each(hostile.map((value) => ({ value })))(
  "hostile value %#",
  ({ value }) => {
    it("as a batch, a field, timestamps or one timestamp → PutError", () => {
      const batches = [
        value,
        { timestamps: [0], fields: { x: value } },
        { timestamps: value, fields: { x: [1] } },
        { timestamps: [value], fields: { x: [1] } },
        { timestamps: [0, value], fields: { x: [1, 2] } },
      ];
      for (const batch of batches) {
        expect(() => validateBatch(batch as PutBatch, config)).toThrow(
          PutError,
        );
      }
    });

    it("as a field value → PutError naming the value (N68)", () => {
      // None of these is a number, so none is coerced: each rejects the
      // batch at its own index (decision 29).
      const batch = { timestamps: [0], fields: { x: [value] } };
      expect(() => validateBatch(batch as PutBatch, config)).toThrow(PutError);
      expect(() => validateBatch(batch as PutBatch, config)).toThrow(
        expect.objectContaining({
          code: "field-mismatch",
          offenderIndex: 0,
          offenderTimestamp: 0,
          offenderField: "x",
          expected: "a number",
        }),
      );
    });

    it("as a range or a range endpoint → InvalidRangeError", () => {
      const ranges = [
        value,
        { start: value, end: 1 },
        { start: 0, end: value },
      ];
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
  },
);

// Typed arrays that lie about themselves (step 75 pre-review): the element
// type and the length are read through the %TypedArray% getters, never
// through `constructor` or an overridden `length` (§4.3 (1), (2), N68).
describe("typed arrays that lie about their type or length", () => {
  const ints = resolveCacheConfig({
    id: "liars",
    interval: 1,
    fields: { x: "i32" },
  });
  const rejectsValues = (x: unknown) =>
    expect(() =>
      validateBatch(
        { timestamps: [0, 1, 2], fields: { x } } as unknown as PutBatch,
        ints,
      ),
    ).toThrow(
      expect.objectContaining({
        name: "PutError",
        code: "field-mismatch",
        offenderIndex: 0,
        offenderField: "x",
      }),
    );

  it("a Float64Array whose own constructor says Int32Array is still scanned", () => {
    const values = new Float64Array([Number.NaN, 1e20, 300]);
    Object.defineProperty(values, "constructor", { value: Int32Array });
    rejectsValues(values);
  });

  it("a Float64Array subclass whose prototype constructor says Int32Array is still scanned", () => {
    class Spoof extends Float64Array {}
    Object.defineProperty(Spoof.prototype, "constructor", {
      value: Int32Array,
    });
    rejectsValues(new Spoof([Number.NaN, 1e20, 300]));
  });

  it("a throwing constructor getter does not escape as a TypeError", () => {
    const bad = new Float64Array([Number.NaN, 1e20, 300]);
    const good = new Int32Array([1, 2, 3]);
    for (const values of [bad, good]) {
      Object.defineProperty(values, "constructor", {
        get() {
          throw new TypeError("no");
        },
      });
    }
    rejectsValues(bad);
    expect(
      validateBatch({ timestamps: [0, 1, 2], fields: { x: good } }, ints).points
        .fields.x,
    ).toEqual(new Int32Array([1, 2, 3]));
  });

  it.each([
    { name: "shorter", actual: [1, 2, 3], claimed: 1 },
    { name: "longer", actual: [1], claimed: 3 },
  ])(
    "a length getter that claims a $name array is a length-mismatch",
    ({ actual, claimed }) => {
      class Liar extends Int32Array {
        override get length(): number {
          return claimed;
        }
      }
      const timestamps = Array.from({ length: claimed }, (_, i) => i);
      expect(() =>
        validateBatch({ timestamps, fields: { x: new Liar(actual) } }, ints),
      ).toThrow(
        expect.objectContaining({
          name: "PutError",
          code: "length-mismatch",
          offenderIndex: -1,
        }),
      );
    },
  );
});

describe("timestamps that lie about their length", () => {
  it("a Float64Array subclass claiming fewer timestamps still has every one checked", () => {
    const cfg = resolveCacheConfig({
      id: "liars",
      interval: 10,
      fields: { x: "f64" },
    });
    class Liar extends Float64Array {
      override get length(): number {
        return 1;
      }
    }
    expect(() =>
      validateBatch(
        { timestamps: new Liar([0, 15]), fields: { x: new Float64Array(2) } },
        cfg,
      ),
    ).toThrow(
      expect.objectContaining({
        name: "PutError",
        code: "misaligned",
        offenderIndex: 1,
      }),
    );
  });
});

// A field value's getter runs after the timestamp checks; it must not be able
// to change the timestamps the batch is converted with (step 75 pre-review
// round 2): slots are computed before any field array is read.
describe("a field getter that rewrites the checked timestamps", () => {
  const cfg = resolveCacheConfig({
    id: "rewrite",
    interval: 10,
    fields: { x: "f64", y: "f64" },
  });
  function rewriting(rewrite: (timestamps: number[]) => void, y: unknown[]) {
    const timestamps = [0, 10, 20];
    const x = [1, 2, 3];
    Object.defineProperty(x, 0, {
      get() {
        rewrite(timestamps);
        return 1;
      },
    });
    return { timestamps, fields: { x, y } } as unknown as PutBatch;
  }

  it.each([
    { name: "reordered", rewrite: (t: number[]) => t.splice(1, 2, 20, 10) },
    { name: "misaligned", rewrite: (t: number[]) => t.splice(1, 1, 15) },
  ])(
    "converts the checked timestamps when they are $name later",
    ({ rewrite }) => {
      const batch = rewriting(rewrite, [4, 5, 6]);
      expect(Array.from(validateBatch(batch, cfg).points.slots)).toEqual([
        0, 1, 2,
      ]);
      const c = new CacheState(cfg);
      c.put(rewriting(rewrite, [4, 5, 6]));
      expect(c.get({ start: 0, end: 20 }).timestamps).toEqual(
        new Float64Array([0, 10, 20]),
      );
    },
  );

  it("reports the checked timestamp of a rejected value", () => {
    const batch = rewriting((t) => t.splice(1, 1, 99), [4, null, 6]);
    expect(() => validateBatch(batch, cfg)).toThrow(
      expect.objectContaining({
        name: "PutError",
        code: "field-mismatch",
        offenderIndex: 1,
        offenderTimestamp: 10,
        offenderField: "y",
      }),
    );
  });
});
