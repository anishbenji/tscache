import { describe, expect, it, vi } from "vitest";
import { validateBatch } from "../src/engine/batch";
import { CacheState } from "../src/engine/cache";
import { Engine } from "../src/engine/engine";
import { resolveCacheConfig } from "../src/engine/validate";
import { InvalidRangeError, PutError } from "../src/errors";
import type { Dtype, FieldArray, PutBatch, Range } from "../src/types";

const integerRanges = [
  { dtype: "i32", min: -2_147_483_648, max: 2_147_483_647 },
  { dtype: "u32", min: 0, max: 4_294_967_295 },
  { dtype: "i16", min: -32_768, max: 32_767 },
  { dtype: "u16", min: 0, max: 65_535 },
  { dtype: "i8", min: -128, max: 127 },
  { dtype: "u8", min: 0, max: 255 },
] as const;

function config(dtype: Dtype = "f64") {
  return resolveCacheConfig({
    id: "field-values",
    interval: 10,
    alignmentOffset: 3,
    fields: { x: dtype },
  });
}

/** Invalid consumer input deliberately crosses the static number[] boundary. */
function input(values: unknown[], timestamps = [3, 13, 23]): PutBatch {
  return { timestamps, fields: { x: values } } as unknown as PutBatch;
}

function putError(action: () => unknown): PutError {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PutError);
  if (!(error instanceof PutError)) throw new Error("Expected PutError");
  return error;
}

const nonNumbers = [
  { name: "null", value: null, printed: "null" },
  { name: "undefined", value: undefined, printed: "undefined" },
  { name: "string", value: "1", printed: "1" },
  { name: "boolean", value: true, printed: "true" },
  { name: "bigint", value: 1n, printed: "1" },
  { name: "object", value: {}, printed: "an object" },
  { name: "array", value: [], printed: "an array" },
  { name: "symbol", value: Symbol("bad"), printed: "Symbol(bad)" },
  {
    name: "null-prototype object",
    value: Object.create(null),
    printed: "an object",
  },
  { name: "function", value: () => 0, printed: "a function" },
];

describe.each(["validateBatch", "CacheState.put"] as const)(
  "%s field values — architecture §2.4, §4.3, N68",
  (seam) => {
    function write(batch: PutBatch, dtype: Dtype): FieldArray | undefined {
      const c = config(dtype);
      if (seam === "validateBatch")
        return validateBatch(batch, c).points.fields.x;
      const cache = new CacheState(c);
      cache.put(batch);
      return cache.get({ start: 3, end: 23 }).fields.x;
    }

    describe.each(["f64", "i32"] as const)("non-numbers in %s", (dtype) => {
      it.each(nonNumbers)(
        "rejects $name without coercion and locates the value",
        ({ value, printed }) => {
          const error = putError(() => write(input([1, value, 2]), dtype));
          expect(error).toMatchObject({
            code: "field-mismatch",
            offenderIndex: 1,
            offenderTimestamp: 13,
            expected: "a number",
          });
          expect(error.message).toContain('"x"');
          expect(error.message).toContain(printed);
          expect(error.message).toMatch(/index 1\b/);
          expect(error.message).toMatch(/t\s*=\s*13\b/);
          if (value !== null)
            expect(error.message).toContain(`(${typeof value})`);
        },
      );

      it("rejects a sparse-array hole at its actual index", () => {
        const values = [1, 2, 3];
        delete values[1];
        expect(putError(() => write(input(values), dtype))).toMatchObject({
          code: "field-mismatch",
          offenderIndex: 1,
          offenderTimestamp: 13,
          expected: "a number",
        });
      });
    });

    it.each(["f64", "f32"] as const)(
      "preserves NaN, infinities and negative zero in %s",
      (dtype) => {
        for (const value of [Number.NaN, Infinity, -Infinity, -0]) {
          const stored = write(input([value], [3]), dtype);
          expect(stored?.[0]).toBe(value);
        }
      },
    );

    it("rounds f32 values, including finite overflow, on readback", () => {
      const stored = write(input([0.1, 1e300, -1e300]), "f32");
      expect(stored).toEqual(
        new Float32Array([Math.fround(0.1), Infinity, -Infinity]),
      );
    });

    describe.each(integerRanges)(
      "$dtype integer range",
      ({ dtype, min, max }) => {
        it("accepts both inclusive endpoints", () => {
          expect(
            Array.from(write(input([min, max], [3, 13]), dtype) ?? []),
          ).toEqual([min, max]);
        });
        it.each([
          { name: "minimum minus one", value: min - 1 },
          { name: "maximum plus one", value: max + 1 },
          { name: "NaN", value: Number.NaN },
          { name: "positive infinity", value: Infinity },
          { name: "negative infinity", value: -Infinity },
        ])("rejects $name with the documented range", ({ value }) => {
          const error = putError(() => write(input([0, value, 0]), dtype));
          expect(error).toMatchObject({
            code: "field-mismatch",
            offenderIndex: 1,
            offenderTimestamp: 13,
            expected: `an integer in [${min}, ${max}]`,
          });
          expect(error.message).toContain('"x"');
          expect(error.message).toContain(String(value));
          expect(error.message).toContain(dtype);
          expect(error.message).toContain(`[${min}, ${max}]`);
        });
      },
    );

    it.each([
      {
        dtype: "i32",
        values: [1, -1, -(2 ** 31)],
        expected: [1, -1, -2_147_483_648],
      },
      { dtype: "u8", values: [-0, 255, 1], expected: [0, 255, 1] },
    ] as const)(
      "stores integral $dtype values as given (decision 38)",
      ({ dtype, values, expected }) => {
        expect(Array.from(write(input([...values]), dtype) ?? [])).toEqual(
          expected,
        );
      },
    );

    it.each([1.5, -1.5, 0.5, 255.9])(
      "rejects the non-integer %s in u8 (decision 38)",
      (value) => {
        const error = putError(() => write(input([0, value, 0]), "u8"));
        expect(error).toMatchObject({
          code: "field-mismatch",
          offenderIndex: 1,
          offenderTimestamp: 13,
          offenderField: "x",
          expected: "an integer in [0, 255]",
        });
        expect(error.message).toContain(String(value));
      },
    );

    it("accepts -0 and integral floats such as 2.0 in integer fields (decision 38)", () => {
      expect(Array.from(write(input([-0, 2.0, 255.0]), "u8") ?? [])).toEqual([
        0, 2, 255,
      ]);
      expect(Array.from(write(input([-0, 2.0, -3.0]), "i32") ?? [])).toEqual([
        0, 2, -3,
      ]);
    });

    it.each([
      {
        name: "an integral Float64Array into u8 is accepted",
        values: new Float64Array([2, 255]),
        dtype: "u8",
        result: [2, 255],
      },
      {
        name: "a Float64Array with 300 into u8 rejects",
        values: new Float64Array([2, 300]),
        dtype: "u8",
        result: 1,
      },
      {
        name: "a Float32Array with 1.5 into i32 rejects",
        values: new Float32Array([2, 1.5]),
        dtype: "i32",
        result: 1,
      },
      {
        name: "an Int32Array with -1 into u16 rejects",
        values: new Int32Array([2, -1]),
        dtype: "u16",
        result: 1,
      },
    ] satisfies {
      name: string;
      values: FieldArray;
      dtype: Dtype;
      result: number[] | number;
    }[])(
      "checks a typed array of another dtype: $name (decision 38)",
      ({ values, dtype, result }) => {
        const batch = { timestamps: [3, 13], fields: { x: values } };
        if (Array.isArray(result)) {
          expect(Array.from(write(batch, dtype) ?? [])).toEqual(result);
        } else {
          expect(putError(() => write(batch, dtype))).toMatchObject({
            code: "field-mismatch",
            offenderIndex: result,
          });
        }
      },
    );

    it.each([
      {
        dtype: "f64",
        values: new Float64Array([Number.NaN, -0]),
        expected: [Number.NaN, -0],
      },
      {
        dtype: "f32",
        values: new Float32Array([Infinity, -Infinity]),
        expected: [Infinity, -Infinity],
      },
      {
        dtype: "i32",
        values: new Int32Array([-2_147_483_648, 2_147_483_647]),
        expected: [-2_147_483_648, 2_147_483_647],
      },
      {
        dtype: "u32",
        values: new Uint32Array([0, 4_294_967_295]),
        expected: [0, 4_294_967_295],
      },
      {
        dtype: "i16",
        values: new Int16Array([-32_768, 32_767]),
        expected: [-32_768, 32_767],
      },
      {
        dtype: "u16",
        values: new Uint16Array([0, 65_535]),
        expected: [0, 65_535],
      },
      {
        dtype: "i8",
        values: new Int8Array([-128, 127]),
        expected: [-128, 127],
      },
      { dtype: "u8", values: new Uint8Array([0, 255]), expected: [0, 255] },
      {
        dtype: "u8",
        values: new Uint8ClampedArray([0, 255]),
        expected: [0, 255],
      },
      {
        dtype: "f32",
        values: new Float64Array([0.1, 1e300]),
        expected: [Math.fround(0.1), Infinity],
      },
      {
        dtype: "f32",
        values: new Int32Array([16_777_217, -16_777_217]),
        expected: [16_777_216, -16_777_216],
      },
      {
        dtype: "f64",
        values: new Float32Array([0.5, -0]),
        expected: [0.5, -0],
      },
      {
        dtype: "f64",
        values: new Uint32Array([0, 4_294_967_295]),
        expected: [0, 4_294_967_295],
      },
    ] satisfies {
      dtype: Dtype;
      values: FieldArray | Uint8ClampedArray;
      expected: number[];
    }[])(
      "accepts and converts typed-array case %# into $dtype",
      ({ dtype, values, expected }) => {
        expect(
          Array.from(
            write({ timestamps: [3, 13], fields: { x: values } }, dtype) ?? [],
          ),
        ).toEqual(expected);
      },
    );

    it.each([
      {
        dtype: "i32",
        values: new Float64Array([Number.NaN]),
        min: -2_147_483_648,
        max: 2_147_483_647,
      },
      { dtype: "u8", values: new Int32Array([300]), min: 0, max: 255 },
      {
        dtype: "i32",
        values: new Uint32Array([2 ** 31]),
        min: -2_147_483_648,
        max: 2_147_483_647,
      },
    ] satisfies {
      dtype: Dtype;
      values: FieldArray;
      min: number;
      max: number;
    }[])(
      "checks a different source dtype before storing in $dtype (%#)",
      ({ dtype, values, min, max }) => {
        expect(
          putError(() =>
            write({ timestamps: [3], fields: { x: values } }, dtype),
          ),
        ).toMatchObject({
          code: "field-mismatch",
          offenderIndex: 0,
          offenderTimestamp: 3,
          expected: `an integer in [${min}, ${max}]`,
        });
      },
    );
  },
);

describe("N68 validation precedence and atomicity — architecture §4.3, §4.5", () => {
  it("chooses schema order before cross-field index order, then the lowest index", () => {
    const c = resolveCacheConfig({
      id: "order",
      interval: 10,
      fields: { first: "f64", second: "i32" },
    });
    const batch = {
      timestamps: [0, 10, 20, 30, 40],
      fields: { second: [null, 0, 0, 0, 0], first: [0, 0, 0, null, undefined] },
    } as unknown as PutBatch;
    const error = putError(() => validateBatch(batch, c));
    expect(error).toMatchObject({
      code: "field-mismatch",
      offenderIndex: 3,
      offenderTimestamp: 30,
      expected: "a number",
    });
    expect(error.message).toContain('"first"');
    expect(error.message).toContain("null");
  });

  it.each([
    {
      name: "missing field",
      batch: { timestamps: [3], fields: { other: [null] } },
      code: "field-mismatch",
      index: -1,
      timestamp: undefined,
    },
    {
      name: "length mismatch",
      batch: { timestamps: [3, 13], fields: { x: [null] } },
      code: "length-mismatch",
      index: -1,
      timestamp: undefined,
    },
    {
      name: "misaligned",
      batch: input([null, 0], [3, 14]),
      code: "misaligned",
      index: 1,
      timestamp: 14,
    },
    {
      name: "unsorted",
      batch: input([null, 0], [13, 3]),
      code: "unsorted",
      index: 1,
      timestamp: 3,
    },
    {
      name: "duplicate",
      batch: input([null, 0], [3, 3]),
      code: "duplicate",
      index: 1,
      timestamp: 3,
    },
    {
      name: "outside range",
      batch: input([null, 0], [3, 13]),
      code: "range-mismatch",
      index: 1,
      timestamp: 13,
      range: { start: 3, end: 3 },
    },
  ])(
    "reports $name before an invalid field value",
    ({ batch, code, index, timestamp, ...options }) => {
      const error = putError(() =>
        validateBatch(
          batch as PutBatch,
          config(),
          "range" in options ? options.range : undefined,
        ),
      );
      expect(error).toMatchObject({ code, offenderIndex: index });
      expect(error.offenderTimestamp).toBe(timestamp);
    },
  );

  it("reports a malformed range before an invalid field value", () => {
    expect(() =>
      validateBatch(input([null], [3]), config(), { start: 13, end: 3 }),
    ).toThrow(InvalidRangeError);
  });

  it.each([new BigInt64Array([1n]), new DataView(new ArrayBuffer(8)), null])(
    "keeps a non-numeric whole field structural (%#)",
    (x) => {
      const error = putError(() =>
        validateBatch(
          { timestamps: [3], fields: { x } } as unknown as PutBatch,
          config(),
        ),
      );
      expect(error).toMatchObject({
        code: "field-mismatch",
        offenderIndex: -1,
      });
      expect(error.offenderTimestamp).toBeUndefined();
    },
  );

  it.each([null, { version: "" }, { finalizedUntil: Number.NaN }])(
    "reports an invalid value before malformed meta %#",
    (meta) => {
      const c = new CacheState(config());
      expect(
        putError(() =>
          c.put({ ...input([null], [3]), meta } as unknown as PutBatch),
        ),
      ).toMatchObject({
        code: "field-mismatch",
        offenderIndex: 0,
        offenderTimestamp: 3,
        expected: "a number",
      });
    },
  );

  it.each(["CacheState.put", "Engine.put"] as const)(
    "%s rejects atomically before a version clear or watermark advance",
    (seam) => {
      const c = config();
      const onVersionClear = vi.fn();
      const cache = new CacheState(
        { ...c, version: "live", finalizedUntil: 23 },
        { onVersionClear },
      );
      const engine = new Engine();
      engine.cache({ ...c, version: "live", finalizedUntil: 23 });
      engine.on("cacheCleared", onVersionClear);
      const put = (b: PutBatch, range?: Range) =>
        seam === "CacheState.put"
          ? cache.put(b, range === undefined ? undefined : { range })
          : engine.put(c.id, b, range === undefined ? undefined : { range });
      const snapshot = () =>
        seam === "CacheState.put"
          ? cache.snapshot({ start: -7, end: 53 })
          : engine.snapshot(c.id, { start: -7, end: 53 });
      put(input([10, 20, 30]));
      const before = snapshot();
      const error = putError(() =>
        put(
          {
            ...input([99, null, 99]),
            meta: { version: "replacement", finalizedUntil: 53 },
          },
          { start: -7, end: 53 },
        ),
      );
      expect(snapshot()).toEqual(before);
      expect(onVersionClear).not.toHaveBeenCalled();
      expect(error).toMatchObject({
        code: "field-mismatch",
        offenderIndex: 1,
        offenderTimestamp: 13,
        expected: "a number",
      });
    },
  );

  it("keeps empty batches legal and leaves null timestamps misaligned", () => {
    const cache = new CacheState(config());
    const empty = input([], []);
    expect(validateBatch(empty, config()).authority).toBeUndefined();
    expect(cache.put(empty)).toEqual({ warnings: [], cleared: false });
    expect(cache.get({ start: 3, end: 23 }).coverage).toEqual([]);
    cache.put(empty, { range: { start: 3, end: 23 } });
    expect(cache.get({ start: 3, end: 23 })).toMatchObject({
      timestamps: new Float64Array(),
      coverage: [{ start: 3, end: 23 }],
      misses: [],
    });
    const error = putError(() =>
      cache.put(input([null], [null as unknown as number])),
    );
    expect(error).toMatchObject({ code: "misaligned", offenderIndex: 0 });
    expect(error.offenderTimestamp).toBeUndefined();
  });
});

describe("proposed PutError.offenderField — architecture §2.6, §4.3, N68", () => {
  it("identifies the null value's column separately from its point", () => {
    const error = putError(() => validateBatch(input([1, null, 2]), config()));
    expect(error).toMatchObject({
      code: "field-mismatch",
      offenderIndex: 1,
      offenderTimestamp: 13,
      offenderField: "x",
      expected: "a number",
    });
  });
});
