// @ts-expect-error -- the package has no Node type definitions; Vitest runs under Node.
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { validateBatch } from "../src/engine/batch";
import { resolveCacheConfig } from "../src/engine/validate";
import { PutError } from "../src/errors";
import type { PutBatch } from "../src/types";

// Implementer tests (not contract tests): arrays made in another realm, as
// an in-process cache receives them from a same-origin iframe.
const config = resolveCacheConfig({
  id: "realms",
  interval: 10,
  alignmentOffset: 3,
  fields: { x: "f64" },
});
const foreign = (source: string): unknown => runInNewContext(source);

describe("validateBatch with arrays from another realm", () => {
  it("accepts foreign typed arrays and plain arrays", () => {
    const batch = {
      timestamps: foreign("new Float64Array([3, 13])"),
      fields: { x: foreign("new Int16Array([1, 2])") },
    } as PutBatch;
    expect(batch.timestamps).not.toBeInstanceOf(Float64Array);
    const { points } = validateBatch(batch, config);
    expect(points.slots).toEqual(new Float64Array([0, 1]));
    expect(points.fields.x).toEqual(new Float64Array([1, 2]));
    expect(
      validateBatch(
        {
          timestamps: foreign("[3]"),
          fields: { x: foreign("[7]") },
        } as PutBatch,
        config,
      ).points.fields.x,
    ).toEqual(new Float64Array([7]));
  });

  it.each([
    "new DataView(new ArrayBuffer(16))",
    "new BigInt64Array(2)",
    "new BigUint64Array(2)",
  ])("rejects a foreign %s field as field-mismatch", (source) => {
    const batch = { timestamps: [3, 13], fields: { x: foreign(source) } };
    expect(() => validateBatch(batch as PutBatch, config)).toThrow(
      expect.objectContaining({ code: "field-mismatch", offenderIndex: -1 }),
    );
    expect(() => validateBatch(batch as PutBatch, config)).toThrow(PutError);
  });

  it("rejects foreign timestamps that are not a Float64Array", () => {
    const batch = {
      timestamps: foreign("new Float32Array([3, 13])"),
      fields: { x: [1, 2] },
    };
    expect(() => validateBatch(batch as PutBatch, config)).toThrow(
      expect.objectContaining({ code: "field-mismatch" }),
    );
  });
});

describe("validateBatch with values that cannot be interpolated", () => {
  it.each([
    { name: "a symbol batch", batch: Symbol("bad") },
    {
      name: "a symbol field",
      batch: { timestamps: [3], fields: { x: Symbol("bad") } },
    },
    {
      name: "symbol timestamps",
      batch: { timestamps: Symbol("bad"), fields: { x: [1] } },
    },
  ])("rejects $name as field-mismatch", ({ batch }) => {
    expect(() => validateBatch(batch as unknown as PutBatch, config)).toThrow(
      expect.objectContaining({ code: "field-mismatch", offenderIndex: -1 }),
    );
  });

  it("rejects a symbol timestamp as misaligned", () => {
    const batch = { timestamps: [3, Symbol("bad")], fields: { x: [1, 2] } };
    expect(() => validateBatch(batch as unknown as PutBatch, config)).toThrow(
      expect.objectContaining({ code: "misaligned", offenderIndex: 1 }),
    );
  });
});
