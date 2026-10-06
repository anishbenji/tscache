import { expect } from "vitest";
import { SegmentStore } from "../src/engine/merge";
import { resolveCacheConfig } from "../src/engine/validate";
import type { Columns } from "../src/segment/types";
import type { CacheConfig, Dtype } from "../src/types";

/** The schema every store() uses. */
export const schema: Readonly<Record<string, Dtype>> = {
  price: "f64",
  volume: "i16",
};

export function store(overrides: Partial<CacheConfig> = {}): SegmentStore {
  return new SegmentStore(
    resolveCacheConfig({
      id: "merge",
      interval: 10,
      alignmentOffset: 3,
      fields: schema,
      gapSplitK: 2,
      segmentSlotCap: 8,
      ...overrides,
    }),
  );
}
export function points(
  slots: number[],
  prices: number[] = slots,
  volumes: number[] = slots,
): Columns {
  return {
    slots: new Float64Array(slots),
    fields: {
      price: new Float64Array(prices),
      volume: new Float64Array(volumes),
    },
  };
}
export function extents(
  s: SegmentStore,
): ({ start: number; end: number } | undefined)[] {
  return s.segments.map((segment) => segment.extent);
}
export function snapshot(s: SegmentStore): unknown {
  return s.segments.map((segment) => {
    const extent = segment.extent;
    expect(extent).toBeDefined();
    if (extent === undefined) throw new Error("Empty segment in store");
    return {
      extent: { ...extent },
      size: segment.size,
      columns: segment.slice(extent),
    };
  });
}
export function expectRows(
  s: SegmentStore,
  slots: number[],
  prices: number[] = slots,
  volumes: number[] = slots,
): void {
  expect(s.segments.reduce((sum, segment) => sum + segment.size, 0)).toBe(
    slots.length,
  );
  const actualSlots: number[] = [];
  const actualPrices: number[] = [];
  const actualVolumes: number[] = [];
  for (const segment of s.segments) {
    const extent = segment.extent;
    if (extent === undefined) throw new Error("Empty segment in store");
    const slice = segment.slice(extent);
    expect(slice.fields.price).toBeInstanceOf(Float64Array);
    expect(slice.fields.volume).toBeInstanceOf(Int16Array);
    expect(slice.slots.length).toBe(segment.size);
    actualSlots.push(...slice.slots);
    actualPrices.push(...(slice.fields.price ?? []));
    actualVolumes.push(...(slice.fields.volume ?? []));
    for (const slot of slice.slots) {
      const index = slots.indexOf(slot);
      expect(segment.lookup(slot)).toEqual({
        price: prices[index],
        volume: new Int16Array([volumes[index] ?? 0])[0],
      });
    }
  }
  expect(actualSlots).toEqual(slots);
  expect(actualPrices).toEqual(prices);
  expect(actualVolumes).toEqual(Array.from(new Int16Array(volumes)));
}
