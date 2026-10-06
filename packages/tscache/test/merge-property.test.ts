import { describe, expect, it } from "vitest";
import { validateBatch } from "../src/engine/batch";
import { SegmentStore } from "../src/engine/merge";
import { resolveCacheConfig } from "../src/engine/validate";
import { msOf, type SlotRange } from "../src/grid";
import type { ResolvedCacheConfig } from "../src/types";
import { extents, points, snapshot } from "./merge-test-helpers";

// Reproducible inputs without a property-testing dependency.
function randomInt(seed: number): (min: number, max: number) => number {
  let state = seed >>> 0;
  return (min, max) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return min + Math.floor((state / 2 ** 32) * (max - min + 1));
  };
}
function shuffle<T>(
  values: T[],
  next: (min: number, max: number) => number,
): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = next(0, i);
    const a = result[i];
    const b = result[j];
    if (a === undefined || b === undefined)
      throw new Error("Missing shuffle value");
    result[i] = b;
    result[j] = a;
  }
  return result;
}
type Row = { price: number; volume: number };
const universe = { start: -24, end: 24 };
function row(model: Map<number, Row>, slot: number): Row {
  const value = model.get(slot);
  if (value === undefined) throw new Error(`Missing model slot ${slot}`);
  return value;
}
function assertModel(
  s: SegmentStore,
  model: Map<number, Row>,
  config: ResolvedCacheConfig,
): void {
  const slots = [...model.keys()].sort((a, b) => a - b);
  expect(s.segments.reduce((n, segment) => n + segment.size, 0)).toBe(
    model.size,
  );
  const observed: number[] = [];
  let previousLast: number | undefined;
  for (const segment of s.segments) {
    const extent = segment.extent;
    expect(extent).toBeDefined();
    if (extent === undefined) throw new Error("Store exposes empty segment");
    const selected = slots.filter(
      (slot) => extent.start <= slot && slot <= extent.end,
    );
    expect(selected.length).toBeGreaterThan(0);
    expect(extent).toEqual({ start: selected[0], end: selected.at(-1) });
    expect(segment.size).toBe(selected.length);
    expect(extent.end - extent.start + 1).toBeLessThanOrEqual(
      config.segmentSlotCap,
    );
    expect(Math.floor(extent.start / config.segmentSlotCap)).toBe(
      Math.floor(extent.end / config.segmentSlotCap),
    );
    // Each component is connected by the specified K-gap relation; adjacent
    // components must be separated by a larger gap or a page boundary.
    let last: number | undefined;
    for (const slot of selected) {
      if (last !== undefined)
        expect(slot - last - 1).toBeLessThanOrEqual(config.gapSplitK);
      last = slot;
    }
    if (previousLast !== undefined) {
      expect(extent.start).toBeGreaterThan(previousLast);
      expect(
        Math.floor(previousLast / config.segmentSlotCap) !==
          Math.floor(extent.start / config.segmentSlotCap) ||
          extent.start - previousLast - 1 > config.gapSplitK,
      ).toBe(true);
    }
    previousLast = extent.end;
    observed.push(...selected);
    for (let slot = universe.start - 1; slot <= universe.end + 1; slot += 1) {
      expect(segment.lookup(slot)).toEqual(
        extent.start <= slot && slot <= extent.end
          ? model.get(slot)
          : undefined,
      );
    }
    for (const range of [
      universe,
      { start: -9, end: 9 },
      { start: 0, end: 0 },
      { start: -30, end: 30 },
    ]) {
      const included = selected.filter(
        (slot) => range.start <= slot && slot <= range.end,
      );
      expect(segment.slice(range)).toEqual({
        slots: new Float64Array(included),
        fields: {
          price: new Float64Array(
            included.map((slot) => row(model, slot).price),
          ),
          volume: new Int16Array(
            included.map((slot) => row(model, slot).volume),
          ),
        },
      });
    }
  }
  expect(observed).toEqual(slots);
}

const cases = [
  { seed: 1, k: 1, cap: 7 },
  { seed: 0xc0ffee, k: 2, cap: 8 },
  { seed: 0xdeadbeef, k: 4, cap: 16 },
];
function configFor(k: number, cap: number): ResolvedCacheConfig {
  return resolveCacheConfig({
    id: "property",
    interval: 10,
    alignmentOffset: 3,
    fields: { price: "f64", volume: "i16" },
    gapSplitK: k,
    segmentSlotCap: cap,
  });
}

describe("SegmentStore seeded properties — architecture §4.3, §5, N11, N14, N15", () => {
  it.each(cases)(
    "layout depends only on present points, across arrival orders (seed $seed, K=$k, cap=$cap)",
    ({ seed, k, cap }) => {
      const next = randomInt(seed);
      const config = configFor(k, cap);
      const slots = Array.from({ length: 49 }, (_, i) => i - 24).filter(
        () => next(0, 3) !== 0,
      );
      const model = new Map(
        slots.map((slot) => [slot, { price: slot * 10, volume: slot }]),
      );
      const canonical = new SegmentStore(config);
      canonical.put(
        points(
          slots,
          slots.map((slot) => slot * 10),
        ),
      );
      assertModel(canonical, model, config);
      for (const order of [
        slots,
        [...slots].reverse(),
        ...Array.from({ length: 5 }, () => shuffle(slots, next)),
      ]) {
        const s = new SegmentStore(config);
        const arrived = new Map<number, Row>();
        // Both single-point and multi-point batches, each internally sorted.
        for (let at = 0; at < order.length; ) {
          const batchSlots = order
            .slice(at, at + next(1, 5))
            .sort((a, b) => a - b);
          at += batchSlots.length;
          s.put(
            points(
              batchSlots,
              batchSlots.map((slot) => row(model, slot).price),
            ),
          );
          for (const slot of batchSlots) arrived.set(slot, row(model, slot));
          assertModel(s, arrived, config);
        }
        expect(extents(s)).toEqual(extents(canonical));
        expect(snapshot(s)).toEqual(snapshot(canonical));
      }
    },
  );

  it.each(cases)(
    "random upsert/replace puts match a Map after every operation (seed $seed, K=$k, cap=$cap)",
    ({ seed, k, cap }) => {
      const next = randomInt(seed);
      const config = configFor(k, cap);
      const s = new SegmentStore(config);
      const model = new Map<number, Row>();
      for (let step = 0; step < 120; step += 1) {
        const a = next(universe.start, universe.end);
        const b = next(universe.start, universe.end);
        const authority: SlotRange | undefined =
          step % 3 === 0
            ? undefined
            : { start: Math.min(a, b), end: Math.max(a, b) };
        const chosen = new Set<number>();
        const count = next(0, 8);
        for (let i = 0; i < count; i += 1)
          chosen.add(
            next(
              authority?.start ?? universe.start,
              authority?.end ?? universe.end,
            ),
          );
        const slots = [...chosen].sort((x, y) => x - y);
        const prices = slots.map(() =>
          next(0, 9) === 0 ? Number.NaN : next(-1000, 1000) / 10,
        );
        const volumes = slots.map(() => next(-100_000, 100_000) + 0.75);
        const input = {
          timestamps: slots.map((slot) => msOf(slot, config)),
          fields: { price: prices, volume: volumes },
        };
        // Fractional flanks exercise inward snapping without including neighbors.
        const range =
          authority === undefined
            ? undefined
            : {
                start: msOf(authority.start, config) - 0.25,
                end: msOf(authority.end, config) + 0.25,
              };
        const validated = validateBatch(input, config, range);
        expect(validated.authority).toEqual(authority);
        if (authority !== undefined) {
          for (const slot of model.keys())
            if (authority.start <= slot && slot <= authority.end)
              model.delete(slot);
        }
        slots.forEach((slot, i) => {
          const price = prices[i];
          const volume = volumes[i];
          if (price === undefined || volume === undefined)
            throw new Error("Missing generated value");
          // Typed-array assignment is the specified conversion, independent of store logic.
          model.set(slot, { price, volume: new Int16Array([volume])[0] ?? 0 });
        });
        expect(s.put(validated.points, validated.authority)).toEqual([]);
        assertModel(s, model, config);
        const sorted = [...model.keys()].sort((x, y) => x - y);
        const rebuilt = new SegmentStore(config);
        rebuilt.put(
          points(
            sorted,
            sorted.map((slot) => row(model, slot).price),
            sorted.map((slot) => row(model, slot).volume),
          ),
        );
        expect(snapshot(s)).toEqual(snapshot(rebuilt));
      }
    },
  );
});
