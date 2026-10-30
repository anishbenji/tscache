import { describe, expect, it } from "vitest";
import { SegmentStore } from "../src/engine/merge";
import { resolveCacheConfig } from "../src/engine/validate";
import type { SlotRange } from "../src/grid";
import { DenseSegment } from "../src/segment/dense";
import type { Columns } from "../src/segment/types";
import type { Dtype } from "../src/types";
import { points, snapshot, store } from "./merge-test-helpers";

// Implementer tests (not contract tests), step 34: the put path's checks
// and copies, pinned on both the store and the segment so that a leaner
// put cannot let through what architecture §4.2 and §4.3 reject, or keep
// what they say is copied.

const authorities: (SlotRange | undefined)[] = [
  undefined,
  { start: -20, end: 20 },
];

/** Fields built from entries, so any name is an own enumerable property. */
function fieldsOf(
  entries: [string, Float64Array | Int16Array][],
): Columns["fields"] {
  return Object.fromEntries(entries);
}

/**
 * The store and a segment both reject `input` with RangeError, with and
 * without an authority, and change nothing.
 */
function expectRejected(input: Columns): void {
  for (const authority of authorities) {
    const s = store();
    s.put(points([-9, -8, 0, 7, 8]));
    const before = snapshot(s);
    expect(() => s.put(input, authority)).toThrow(RangeError);
    expect(snapshot(s)).toEqual(before);

    const segment = new DenseSegment({
      grid: { interval: 10, alignmentOffset: 3 },
      fields: { price: "f64", volume: "i16" },
      slotCap: 64,
    });
    segment.mergeFrom(points([0, 1]));
    const extent = segment.extent;
    expect(() => segment.mergeFrom(input, authority)).toThrow(RangeError);
    expect(segment.extent).toEqual(extent);
    expect(segment.slice({ start: -20, end: 20 })).toEqual(
      segment.slice({ start: 0, end: 1 }),
    );
    expect(segment.lookup(0)).toEqual({ price: 0, volume: 0 });
  }
}

describe("put field names are the batch's enumerable own names — architecture §4.2", () => {
  it("rejects a schema field hidden behind a non-enumerable property", () => {
    const fields = Object.defineProperty(
      fieldsOf([
        ["price", new Float64Array([99])],
        ["extra", new Float64Array([99])],
      ]),
      "volume",
      { value: new Int16Array([99]) },
    );
    expectRejected({ slots: new Float64Array([0]), fields });
  });

  it("rejects a schema field that is only inherited", () => {
    const fields = Object.create({ volume: new Int16Array([99]) });
    Object.assign(fields, {
      price: new Float64Array([99]),
      extra: new Float64Array([99]),
    });
    expectRejected({ slots: new Float64Array([0]), fields });
  });

  it("rejects a schema field given only under a symbol key", () => {
    const fields: Columns["fields"] = fieldsOf([
      ["price", new Float64Array([99])],
    ]);
    Object.defineProperty(fields, Symbol("volume"), {
      value: new Int16Array([99]),
      enumerable: true,
    });
    expectRejected({ slots: new Float64Array([0]), fields });
  });

  it("rejects the right count of names when one is not the schema's", () => {
    expectRejected({
      slots: new Float64Array([0]),
      fields: fieldsOf([
        ["price", new Float64Array([99])],
        ["toString", new Float64Array([99])],
      ]),
    });
  });

  it("accepts a batch whose own fields are the schema's, in any order", () => {
    const s = store();
    s.put({
      slots: new Float64Array([0]),
      fields: fieldsOf([
        ["volume", new Int16Array([5])],
        ["price", new Float64Array([1.5])],
      ]),
    });
    expect(s.segments[0]?.lookup(0)).toEqual({ price: 1.5, volume: 5 });
  });
});

describe("Object.prototype field names on the put path — architecture §4.2", () => {
  const fields: Readonly<Record<string, Dtype>> = Object.fromEntries([
    ["__proto__", "f64"],
    ["constructor", "i16"],
  ]);
  const config = resolveCacheConfig({
    id: "prototype-names",
    interval: 10,
    fields,
    segmentSlotCap: 64,
  });

  it("stores them, and rejects a batch that only inherits one", () => {
    const s = new SegmentStore(config);
    s.put({
      slots: new Float64Array([0, 1]),
      fields: fieldsOf([
        ["__proto__", new Float64Array([1, 2])],
        ["constructor", new Int16Array([3, 4])],
      ]),
    });
    const row = s.segments[0]?.lookup(1);
    expect(Object.getOwnPropertyDescriptor(row, "__proto__")?.value).toBe(2);
    expect(row?.constructor).toBe(4);

    // `constructor` is inherited from Object.prototype, not given.
    const missing: Columns = {
      slots: new Float64Array([2]),
      fields: fieldsOf([
        ["__proto__", new Float64Array([9])],
        ["extra", new Float64Array([9])],
      ]),
    };
    expect(() => s.put(missing)).toThrow(RangeError);
    expect(s.segments[0]?.size).toBe(2);
  });
});

describe("put copies its input — architecture §4.2, §4.3", () => {
  it.each([
    { name: "one chunk", slots: [0, 1, 2, 3] },
    { name: "several chunks", slots: [0, 1, 7, 8, 30, 31] },
  ])(
    "keeps no array of the batch, nor of views into it: $name",
    ({ slots }) => {
      // Views at a nonzero offset into larger buffers, of the store's dtypes
      // and of another, so neither the arrays nor their buffers may be kept.
      const n = slots.length;
      const slotBuffer = new Float64Array(n + 2);
      slotBuffer.set(slots, 1);
      const priceBuffer = new Float64Array(n + 2);
      priceBuffer.set(
        slots.map((slot) => slot * 10),
        1,
      );
      const volumeBuffer = new Float64Array(n + 2);
      volumeBuffer.set(slots, 1);
      const batch: Columns = {
        slots: slotBuffer.subarray(1, n + 1),
        fields: {
          price: priceBuffer.subarray(1, n + 1),
          volume: volumeBuffer.subarray(1, n + 1),
        },
      };
      for (const authority of [undefined, { start: -5, end: 40 }]) {
        const s = store({ segmentSlotCap: 64 });
        s.put(batch, authority);
        const before = snapshot(s);
        priceBuffer.fill(-1);
        volumeBuffer.fill(-1);
        expect(snapshot(s)).toEqual(before);
        for (const slot of slots) {
          const segment = s.segments.find(
            (candidate) =>
              candidate.extent !== undefined &&
              candidate.extent.start <= slot &&
              slot <= candidate.extent.end,
          );
          expect(segment?.lookup(slot)).toEqual({
            price: slot * 10,
            volume: slot,
          });
        }
        priceBuffer.set(
          slots.map((slot) => slot * 10),
          1,
        );
        volumeBuffer.set(slots, 1);
      }
    },
  );

  it("keeps no array of a batch already in the store's dtypes", () => {
    const batch: Columns = {
      slots: new Float64Array([0, 1, 2]),
      fields: {
        price: new Float64Array([1, 2, 3]),
        volume: new Int16Array([4, 5, 6]),
      },
    };
    const s = store({ segmentSlotCap: 64 });
    s.put(batch);
    batch.slots.fill(40);
    batch.fields.price?.fill(-1);
    batch.fields.volume?.fill(-1);
    expect(s.segments[0]?.extent).toEqual({ start: 0, end: 2 });
    expect(s.segments[0]?.lookup(1)).toEqual({ price: 2, volume: 5 });
  });
});
