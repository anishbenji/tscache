import { describe, expect, it } from "vitest";
import type { SlotRange } from "../src/grid";
import type { Columns } from "../src/segment/types";
import { points, snapshot, store } from "./merge-test-helpers";

function atomicReject(input: Columns, authority?: SlotRange): void {
  for (const populated of [false, true]) {
    const s = store({ warnOnOverlapDiff: true });
    if (populated) s.put(points([-9, -8, -1, 0, 7, 8, 16]));
    const before = snapshot(s);
    const inputBefore = structuredClone(input);
    expect(() => s.put(input, authority)).toThrow(RangeError);
    expect(snapshot(s)).toEqual(before);
    expect(input).toEqual(inputBefore);
  }
}
const invalid = [0.5, Number.NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53)];

describe("SegmentStore programming errors — architecture §4.2, §4.3", () => {
  it.each(invalid)(
    "rejects invalid slot %j before any upsert or replacement",
    (slot) => {
      for (const authority of [undefined, { start: -20, end: 20 }])
        atomicReject(points([-10, slot], [999, 999]), authority);
    },
  );

  it.each([
    { name: "descending", slots: [0, -1] },
    { name: "duplicate", slots: [0, 0] },
    { name: "late descending across pages", slots: [-9, 0, 8, 7] },
    { name: "late duplicate across pages", slots: [-9, 0, 8, 8] },
    { name: "late invalid across pages", slots: [-9, 0, 8, Number.NaN] },
  ])("rejects $name points atomically", ({ slots }) => {
    for (const authority of [undefined, { start: -20, end: 20 }])
      atomicReject(
        points(
          slots,
          slots.map(() => 999),
        ),
        authority,
      );
  });

  it.each([
    { name: "missing field", fields: { price: new Float64Array([999]) } },
    {
      name: "extra field",
      fields: {
        price: new Float64Array([999]),
        volume: new Int16Array([999]),
        extra: new Float64Array([999]),
      },
    },
    {
      name: "wrong field",
      fields: {
        price: new Float64Array([999]),
        other: new Float64Array([999]),
      },
    },
    {
      name: "short field",
      fields: { price: new Float64Array(), volume: new Int16Array([999]) },
    },
    {
      name: "long field",
      fields: {
        price: new Float64Array([999]),
        volume: new Int16Array([999, 999]),
      },
    },
  ])("rejects $name before deleting or overwriting rows", ({ fields }) => {
    for (const authority of [undefined, { start: -20, end: 20 }])
      atomicReject({ slots: new Float64Array([0]), fields }, authority);
  });

  it("validates field names and lengths even with no incoming slots", () => {
    atomicReject(
      { slots: new Float64Array(), fields: {} },
      { start: -20, end: 20 },
    );
    atomicReject(
      {
        slots: new Float64Array(),
        fields: { price: new Float64Array([999]), volume: new Int16Array() },
      },
      { start: -20, end: 20 },
    );
  });

  it.each([
    { start: 1, end: 0 },
    ...invalid.flatMap((slot) => [
      { start: slot, end: 20 },
      { start: -20, end: slot },
    ]),
  ])("rejects malformed authority %j even with an empty batch", (authority) => {
    atomicReject(points([]), authority);
    atomicReject(points([0], [999]), authority);
  });

  it.each([
    { name: "before authority", slots: [-9, 0] },
    { name: "after authority", slots: [0, 9] },
  ])("rejects a point $name before clearing any segment", ({ slots }) => {
    atomicReject(points(slots, [999, 999]), { start: -8, end: 8 });
  });

  it.each([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])(
    "accepts safe slot boundary %i",
    (slot) => {
      const s = store({ interval: 1, alignmentOffset: 0, segmentSlotCap: 1 });
      expect(s.put(points([slot], [42], [4]))).toEqual([]);
      expect(s.segments.map((segment) => segment.extent)).toEqual([
        { start: slot, end: slot },
      ]);
      expect(s.segments[0]?.lookup(slot)).toEqual({ price: 42, volume: 4 });
    },
  );
});
