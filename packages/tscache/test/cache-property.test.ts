import { describe, expect, it } from "vitest";
import { CacheState } from "../src/engine/cache";
import { resolveCacheConfig } from "../src/engine/validate";
import type { GetResult, PutBatch, PutOptions, Range } from "../src/types";

const low = -12;
const high = 12;
const interval = 10;
type Row = { price: number; volume: number };

/** Small deterministic generator: no dependency or global random state. */
function randomInt(seed: number): (min: number, max: number) => number {
  let state = seed >>> 0;
  return (min, max) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return min + (state % (max - min + 1));
  };
}

/** Deliberately slot-by-slot; no production grid, coverage or merge helpers. */
class Reference {
  readonly rows = new Map<number, Row>();
  readonly covered = new Set<number>();
  watermark: number | undefined;

  constructor(
    readonly offset: number,
    watermark: number | undefined,
  ) {
    this.watermark = watermark;
  }

  ms(slot: number): number {
    return this.offset + interval * slot;
  }

  put(input: PutBatch, options: PutOptions): void {
    const range = options.range;
    // Inputs are generated valid; model does no validation or layout work.
    const times = Array.from(input.timestamps);
    const claim =
      range ??
      (times.length === 0
        ? undefined
        : {
            start: Math.min(...times),
            end: Math.max(...times),
          });
    if (range !== undefined) {
      for (const slot of this.rows.keys()) {
        if (range.start <= this.ms(slot) && this.ms(slot) <= range.end)
          this.rows.delete(slot);
      }
    }
    const price = input.fields.price as number[];
    const volume = input.fields.volume as number[];
    times.forEach((t, i) => {
      const p = price[i];
      const v = volume[i];
      if (p === undefined || v === undefined)
        throw new Error("Missing generated row");
      this.rows.set((t - this.offset) / interval, { price: p, volume: v });
    });
    if (claim !== undefined) {
      for (let slot = low; slot <= high; slot += 1) {
        const t = this.ms(slot);
        if (
          claim.start <= t &&
          t <= claim.end &&
          (this.watermark === undefined || t < this.watermark)
        ) {
          this.covered.add(slot);
        }
      }
    }
  }

  invalidate(range: Range): void {
    const first = Math.floor((range.start - this.offset) / interval);
    const last = Math.ceil((range.end - this.offset) / interval);
    for (const slot of this.covered)
      if (first <= slot && slot <= last) this.covered.delete(slot);
  }

  setFinalizedUntil(t: number): void {
    // Forward movement cannot recreate coverage already missing. Removing
    // t >= watermark is harmless on forward movement: those slots were absent.
    this.watermark = t;
    for (const slot of this.covered)
      if (this.ms(slot) >= t) this.covered.delete(slot);
  }

  clear(): void {
    this.rows.clear();
    this.covered.clear();
  }

  get(range: Range): GetResult {
    const first = Math.floor((range.start - this.offset) / interval);
    const last = Math.ceil((range.end - this.offset) / interval);
    const timestamps: number[] = [];
    const prices: number[] = [];
    const volumes: number[] = [];
    const runs = (covered: boolean): Range[] => {
      const ranges: Range[] = [];
      let run: Range | undefined;
      for (let slot = first; slot <= last; slot += 1) {
        if (this.covered.has(slot) === covered) {
          if (run === undefined) {
            run = { start: this.ms(slot), end: this.ms(slot) };
            ranges.push(run);
          } else run.end = this.ms(slot);
        } else run = undefined;
      }
      return ranges;
    };
    for (let slot = first; slot <= last; slot += 1) {
      const row = this.rows.get(slot);
      if (row !== undefined) {
        timestamps.push(this.ms(slot));
        prices.push(row.price);
        volumes.push(row.volume);
      }
    }
    return {
      timestamps: new Float64Array(timestamps),
      fields: {
        price: new Float64Array(prices),
        volume: new Int16Array(volumes),
      },
      coverage: runs(true),
      misses: runs(false).map((range) => ({ range, reason: "uncached" })),
    };
  }
}

describe("CacheState seeded reference model — architecture §4.5, §5, N1, N3, N11, N13, N16", () => {
  it.each([
    { seed: 1, offset: 0, watermark: undefined },
    { seed: 0xc0ffee, offset: 3, watermark: 3 },
    { seed: 0xdeadbeef, offset: 7, watermark: -2.75 },
  ])(
    "random put/invalidate/watermark/clear sequences match after every step (seed $seed)",
    ({ seed, offset, watermark }) => {
      const next = randomInt(seed);
      const config = resolveCacheConfig({
        id: "reference",
        interval,
        alignmentOffset: offset,
        fields: { price: "f64", volume: "i16" },
        gapSplitK: 2,
        segmentSlotCap: 8,
        version: "v1",
        ...(watermark === undefined ? {} : { finalizedUntil: watermark }),
      });
      const c = new CacheState(config);
      const model = new Reference(offset, watermark);
      const counts = {
        upsert: 0,
        replace: 0,
        invalidate: 0,
        watermark: 0,
        clear: 0,
      };
      for (let step = 0; step < 240; step += 1) {
        // The first ten steps guarantee every operation; later choices are random.
        const op = step < 10 ? step : next(0, 9);
        const a = next(low, high);
        const b = next(low, high);
        const start = Math.min(a, b);
        const end = Math.max(a, b);
        if (op <= 6) {
          let range: Range | undefined;
          if (op >= 4) {
            const shape = next(0, 3);
            range =
              shape === 3 || start === end
                ? { start: model.ms(start) + 0.25, end: model.ms(start) + 1.25 }
                : {
                    start:
                      model.ms(start) +
                      (shape === 1 ? 0.25 : shape === 2 ? -0.25 : 0),
                    end:
                      model.ms(end) +
                      (shape === 1 ? -0.25 : shape === 2 ? 0.25 : 0),
                  };
          }
          const candidates = Array.from(
            { length: high - low + 1 },
            (_, i) => low + i,
          ).filter(
            (slot) =>
              range === undefined ||
              (range.start <= model.ms(slot) && model.ms(slot) <= range.end),
          );
          const chosen = new Set<number>();
          const count = next(0, 7);
          for (let i = 0; i < count && candidates.length > 0; i += 1) {
            const slot = candidates[next(0, candidates.length - 1)];
            if (slot === undefined) throw new Error("Missing candidate");
            chosen.add(slot);
          }
          const slots = [...chosen].sort((x, y) => x - y);
          const input: PutBatch = {
            timestamps: slots.map((slot) => model.ms(slot)),
            fields: {
              price: slots.map(() =>
                next(0, 12) === 0 ? Number.NaN : next(-1000, 1000) / 10,
              ),
              volume: slots.map(() => next(-1000, 1000)),
            },
          };
          const options: PutOptions = range === undefined ? {} : { range };
          expect(c.put(input, options)).toEqual({
            warnings: [],
            cleared: false,
          });
          model.put(input, options);
          if (range === undefined) counts.upsert += 1;
          else counts.replace += 1;
        } else if (op === 7) {
          const range = {
            start: model.ms(start) + 0.25,
            end: model.ms(end) + 0.75,
          };
          c.invalidate(range);
          model.invalidate(range);
          counts.invalidate += 1;
        } else if (op === 8) {
          const t = model.ms(next(low - 2, high + 2)) + next(-2, 2) / 4;
          c.setFinalizedUntil(t);
          model.setFinalizedUntil(t);
          counts.watermark += 1;
        } else {
          c.clear();
          model.clear();
          counts.clear += 1;
        }
        const queryA = next(low, high);
        const queryB = next(low, high);
        const queries: Range[] = [
          { start: model.ms(low) - 0.25, end: model.ms(high) + 0.25 },
          {
            start: model.ms(Math.min(queryA, queryB)) + 0.25,
            end: model.ms(Math.max(queryA, queryB)) + 0.75,
          },
        ];
        for (const request of queries) {
          expect(
            c.get(request),
            `seed=${seed} step=${step} op=${op} request=${JSON.stringify(request)}`,
          ).toEqual(model.get(request));
        }
        expect(c.finalizedUntil).toBe(model.watermark);
        expect(c.version).toBe("v1");
        expect(c.config).toEqual(config);
      }
      for (const count of Object.values(counts))
        expect(count).toBeGreaterThan(0);
    },
  );
});
