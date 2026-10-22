import { expect } from "vitest";
import { TscacheError } from "../src/errors";
import type { DenseSegmentPayload, Snapshot } from "../src/types";

/** Independent wire fixture: points at 3, 23 (NaN), and 43; two real gaps. */
export function snapshotPayload(): DenseSegmentPayload {
  return {
    format: 1,
    layout: "dense",
    start: 3,
    count: 5,
    interval: 10,
    alignmentOffset: 3,
    mask: new Uint8Array([0x15]),
    fields: [
      {
        name: "price",
        dtype: "f64",
        data: new Float64Array([10, 0, Number.NaN, 0, 30]).buffer,
      },
      {
        name: "volume",
        dtype: "i16",
        data: new Int16Array([1, 0, 2, 0, 3]).buffer,
      },
    ],
  };
}

export function snapshotFixture(): Snapshot {
  return {
    format: 1,
    interval: 10,
    alignmentOffset: 3,
    fields: { price: "f64", volume: "i16" },
    range: { start: -7, end: 73 },
    version: "seed",
    finalizedUntil: 63,
    coverage: [{ start: 3, end: 43 }],
    segments: [snapshotPayload()],
  };
}

export function payloadField(
  payload: DenseSegmentPayload,
  name: string,
): DenseSegmentPayload["fields"][number] {
  const entry = payload.fields.find((field) => field.name === name);
  if (entry === undefined) throw new Error(`Missing fixture field ${name}`);
  return entry;
}

/** Capture once: validation must be atomic, including metadata and hooks. */
export function thrown(action: () => unknown): TscacheError {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TscacheError);
  if (!(error instanceof TscacheError))
    throw new Error("Expected TscacheError");
  expect(error.constructor).toBe(TscacheError);
  return error;
}
