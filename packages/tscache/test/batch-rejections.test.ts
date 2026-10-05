import { describe, expect, it } from "vitest";
import { validateBatch } from "../src/engine/batch";
import { resolveCacheConfig } from "../src/engine/validate";
import { InvalidRangeError, PutError, type PutErrorCode } from "../src/errors";
import type { PutBatch, Range } from "../src/types";

const config = resolveCacheConfig({
  id: "reject",
  interval: 10,
  alignmentOffset: 3,
  fields: { x: "f64", y: "i32" },
});
function batch(timestamps: number[] = [3, 13]): PutBatch {
  return {
    timestamps,
    fields: { x: timestamps.map(() => 1), y: timestamps.map(() => 2) },
  };
}
function rejection(
  input: unknown,
  code: PutErrorCode,
  index: number,
  range?: Range,
): PutError {
  const before = structuredClone(input);
  let caught: unknown;
  try {
    validateBatch(input as PutBatch, config, range);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PutError);
  if (!(caught instanceof PutError)) throw new Error("Expected PutError");
  expect(caught.code).toBe(code);
  expect(caught.offenderIndex).toBe(index);
  expect(caught.message.length).toBeGreaterThan(0);
  expect(input).toEqual(before);
  if (index === -1) expect(caught.offenderTimestamp).toBeUndefined();
  // Only misaligned has a specified expected value; others' wording is open.
  if (code === "misaligned") {
    expect(caught.expected).toEqual(expect.any(String));
    expect(caught.expected).toContain("3");
    expect(caught.expected).toContain("10");
  }
  return caught;
}

describe("validateBatch rejects atomically — architecture §2.4, §2.6, §4.3", () => {
  it.each([
    { name: "null batch", input: null },
    { name: "nonobject batch", input: 7 },
    { name: "missing timestamps", input: { fields: { x: [], y: [] } } },
    {
      name: "wrong timestamp dtype",
      input: { ...batch(), timestamps: new Float32Array([3, 13]) },
    },
    {
      name: "DataView timestamps",
      input: { ...batch(), timestamps: new DataView(new ArrayBuffer(16)) },
    },
    { name: "missing fields", input: { timestamps: [] } },
    { name: "null fields", input: { ...batch(), fields: null } },
    { name: "missing field", input: { ...batch(), fields: { x: [1, 2] } } },
    {
      name: "extra field",
      input: { ...batch(), fields: { x: [1, 2], y: [1, 2], z: [1, 2] } },
    },
    {
      name: "wrong field name",
      input: { ...batch(), fields: { x: [1, 2], z: [1, 2] } },
    },
    ...[
      null,
      7,
      "12",
      { length: 2 },
      new DataView(new ArrayBuffer(16)),
      new BigInt64Array(2),
      new BigUint64Array(2),
    ].map((value, i) => ({
      name: `invalid field array ${i}`,
      input: { ...batch(), fields: { x: value, y: [1, 2] } },
    })),
  ])("field-mismatch: $name", ({ input }) => {
    rejection(input, "field-mismatch", -1);
  });

  it.each([
    { name: "short first field", fields: { x: [1], y: [1, 2] } },
    { name: "long second field", fields: { x: [1, 2], y: [1, 2, 3] } },
    { name: "empty first field", fields: { x: [], y: [1, 2] } },
  ])("length-mismatch: $name", ({ fields }) => {
    rejection({ ...batch(), fields }, "length-mismatch", -1);
  });

  it("checks schema and lengths even for zero timestamps", () => {
    rejection({ timestamps: [], fields: {} }, "field-mismatch", -1);
    rejection(
      { timestamps: [], fields: { x: [], y: [1] } },
      "length-mismatch",
      -1,
    );
  });

  it.each([
    4,
    3.5,
    Number.NaN,
    Infinity,
    -Infinity,
    2 ** 53,
    -(2 ** 53),
  ])("misaligned: reports first invalid numeric timestamp %j", (t) => {
    const error = rejection(batch([3, t, 23]), "misaligned", 1);
    expect(error.offenderTimestamp).toBe(t);
  });

  it.each([
    "13",
    null,
    undefined,
    true,
  ])("misaligned: rejects non-number timestamp %j", (t) => {
    // The runtime rejection is specified; the number-typed diagnostic's
    // representation of a non-number offender is not specified.
    rejection({ ...batch(), timestamps: [3, t] }, "misaligned", 1);
  });

  it.each([
    { timestamps: [3, 13, 13, 23], code: "duplicate", index: 2, t: 13 },
    { timestamps: [3, 23, 13], code: "unsorted", index: 2, t: 13 },
    { timestamps: [-7, -7, 3], code: "duplicate", index: 1, t: -7 },
    { timestamps: [-7, -17, 3], code: "unsorted", index: 1, t: -17 },
  ] as const)("$code: reports index $index and value $t", ({
    timestamps,
    code,
    index,
    t,
  }) => {
    expect(
      rejection(batch([...timestamps]), code, index).offenderTimestamp,
    ).toBe(t);
  });

  it.each([
    { timestamps: [-7, 3, 13], range: { start: 3, end: 13 }, index: 0, t: -7 },
    { timestamps: [3, 13, 23], range: { start: 3, end: 13 }, index: 2, t: 23 },
    { timestamps: [3, 13], range: { start: 4, end: 23 }, index: 0, t: 3 },
    { timestamps: [3, 13], range: { start: 3, end: 12.9 }, index: 1, t: 13 },
    { timestamps: [3], range: { start: 4, end: 12 }, index: 0, t: 3 },
  ])("range-mismatch: first excluded timestamp $t", ({
    timestamps,
    range,
    index,
    t,
  }) => {
    expect(
      rejection(batch(timestamps), "range-mismatch", index, range)
        .offenderTimestamp,
    ).toBe(t);
  });

  it.each([
    null,
    {},
    { start: 13, end: 3 },
    ...[
      Number.NaN,
      Infinity,
      -Infinity,
      2 ** 53,
      -(2 ** 53),
      "3",
      null,
    ].flatMap((t) => [
      { start: t, end: 13 },
      { start: 3, end: t },
    ]),
  ])("InvalidRangeError: malformed explicit range %j, including empty batches", (range) => {
    for (const input of [batch(), batch([])]) {
      expect(() => validateBatch(input, config, range as Range)).toThrow(
        InvalidRangeError,
      );
    }
  });

  it("check order: structure before lengths, timestamps, and range", () => {
    rejection({ timestamps: [4, 3], fields: { x: [] } }, "field-mismatch", -1, {
      start: 20,
      end: 10,
    });
  });
  it("check order: lengths before timestamps and range", () => {
    rejection(
      { timestamps: [4, 3], fields: { x: [], y: [] } },
      "length-mismatch",
      -1,
      { start: 20, end: 10 },
    );
  });
  it("check order: scans timestamps before validating range", () => {
    expect(
      rejection(batch([3, 13, 13]), "duplicate", 2, { start: 20, end: 10 })
        .offenderTimestamp,
    ).toBe(13);
    expect(
      rejection(batch([3, 23, 13]), "unsorted", 2, { start: 30, end: 40 })
        .offenderTimestamp,
    ).toBe(13);
  });
  it("check order: misalignment beats descending order at the same index", () => {
    expect(rejection(batch([13, 4]), "misaligned", 1).offenderTimestamp).toBe(
      4,
    );
  });
  it("check order: the earliest offender beats any later error kind", () => {
    expect(
      rejection(batch([3, 13, 13, 4]), "duplicate", 2).offenderTimestamp,
    ).toBe(13);
    expect(
      rejection(batch([3, 23, 13, 4]), "unsorted", 2).offenderTimestamp,
    ).toBe(13);
    expect(rejection(batch([3, 4, 3]), "misaligned", 1).offenderTimestamp).toBe(
      4,
    );
  });
  it("check order: malformed range beats containment mismatch", () => {
    expect(() =>
      validateBatch(batch([-7, 3]), config, { start: 13, end: 3 }),
    ).toThrow(InvalidRangeError);
  });
});
