import { describe, expect, it } from "vitest";
import { validateBatch } from "../src/engine/batch";
import { resolveCacheConfig } from "../src/engine/validate";
import { PutError } from "../src/errors";
import {
  fromWireError,
  PROTOCOL_VERSION,
  toWireError,
} from "../src/rpc/protocol";
import type { PutBatch } from "../src/types";

describe("proposed offenderField over RPC — architecture §2.6, §4.7, N68", () => {
  it("serializes the proposed property independently of batch validation", () => {
    const opts = {
      code: "field-mismatch" as const,
      offenderField: "close",
      offenderIndex: 1,
      offenderTimestamp: 10,
      expected: "a number",
    };
    const error = new PutError(
      'field "close" value null at index 1, t = 10, is not a number',
      opts,
    );
    expect(toWireError(error)).toMatchObject({
      code: "field-mismatch",
      data: {
        offenderField: "close",
        offenderIndex: 1,
        offenderTimestamp: 10,
        expected: "a number",
      },
    });
  });

  it("rebuilds offenderField supplied by another peer independently of serialization", () => {
    const error = fromWireError({
      name: "PutError",
      message: "bad close",
      code: "field-mismatch",
      data: {
        offenderField: "close",
        offenderIndex: 1,
        offenderTimestamp: 10,
        expected: "a number",
      },
    });
    expect(error).toBeInstanceOf(PutError);
    expect(error).toMatchObject({
      offenderField: "close",
      offenderIndex: 1,
      offenderTimestamp: 10,
      expected: "a number",
    });
  });

  it("carries a rejected value's column, point and expectation through both wire directions", () => {
    const config = resolveCacheConfig({
      id: "wire-value",
      interval: 10,
      fields: { close: "f64" },
    });
    let error: unknown;
    try {
      validateBatch(
        {
          timestamps: [0, 10],
          fields: { close: [1, null] },
        } as unknown as PutBatch,
        config,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PutError);
    const wire = toWireError(error);
    expect(wire).toMatchObject({
      name: "PutError",
      code: "field-mismatch",
      data: {
        offenderField: "close",
        offenderIndex: 1,
        offenderTimestamp: 10,
        expected: "a number",
      },
    });
    const rebuilt = fromWireError(structuredClone(wire));
    expect(rebuilt).toBeInstanceOf(PutError);
    expect(rebuilt).toMatchObject({
      message: wire.message,
      code: "field-mismatch",
      offenderField: "close",
      offenderIndex: 1,
      offenderTimestamp: 10,
      expected: "a number",
    });
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("accepts an older peer's PutError without offenderField", () => {
    const error = fromWireError({
      name: "PutError",
      message: "old rejection",
      code: "field-mismatch",
      data: { offenderIndex: 0, offenderTimestamp: 0, expected: "a number" },
    });
    expect(error).toBeInstanceOf(PutError);
    expect(error).toMatchObject({
      offenderIndex: 0,
      offenderTimestamp: 0,
      expected: "a number",
    });
    expect(Reflect.get(error, "offenderField")).toBeUndefined();
  });
});
