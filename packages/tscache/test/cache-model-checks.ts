import { type CacheState, cacheInternals } from "../src/engine/cache";
import type { Dtype, GetResult, PutBatch, Range } from "../src/types";
import {
  type CacheModel,
  type ModelMeta,
  type rng,
  storageOf,
} from "./cache-model";

// Checks of a live CacheState against the model in cache-model.ts, shared by
// cache-model-property.test.ts and cache-faults-property.test.ts. Each returns
// a description of the first disagreement, or undefined.

export function sameNumbers(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** JSON that keeps NaN and the infinities readable. */
export const show = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    typeof v === "number" && !Number.isFinite(v) ? String(v) : v,
  );

function compareGet(
  got: GetResult,
  want: ReturnType<CacheModel["get"]>,
  model: CacheModel,
): string | undefined {
  if (!(got.timestamps instanceof Float64Array))
    return "timestamps not a Float64Array";
  if (!sameNumbers(got.timestamps, want.timestamps)) {
    return `timestamps got ${show(Array.from(got.timestamps))} want ${show(want.timestamps)}`;
  }
  for (const [c, name] of model.names.entries()) {
    const array = got.fields[name];
    const dtype = model.config.fields[name] as Dtype;
    if (!(array instanceof storageOf(dtype)))
      return `field ${name} is not ${dtype}`;
    if (!sameNumbers(array, want.fields[c] as number[])) {
      return `field ${name} got ${show(Array.from(array))} want ${show(want.fields[c])}`;
    }
  }
  if (show(got.coverage) !== show(want.coverage)) {
    return `coverage got ${show(got.coverage)} want ${show(want.coverage)}`;
  }
  const misses = want.misses.map((range) => ({ range, reason: "uncached" }));
  if (show(got.misses) !== show(misses)) {
    return `misses got ${show(got.misses)} want ${show(misses)}`;
  }
  return undefined;
}

/** The covered slots of the cache's coverage index, ascending. */
export function coveredSlots(c: CacheState): number[] {
  const slots: number[] = [];
  for (const range of cacheInternals(c).coverage.ranges()) {
    for (let s = range.start; s <= range.end; s++) slots.push(s);
  }
  return slots;
}

/** The cache's present points, by slot, read through `get`. */
export function rowsOf(
  c: CacheState,
  model: CacheModel,
): Map<number, number[]> {
  const { lo, hi } = model.config;
  const got = c.get({ start: model.ms(lo - 4), end: model.ms(hi + 4) });
  const rows = new Map<number, number[]>();
  got.timestamps.forEach((t, i) => {
    const slot = (t - model.config.offset) / model.config.interval;
    rows.set(
      slot,
      model.names.map(
        (name) => (got.fields[name] as ArrayLike<number>)[i] as number,
      ),
    );
  });
  return rows;
}

/** The store's segments as extents and sizes, to compare with the model's layout. */
export function layoutOf(
  c: CacheState,
): { start?: number; end?: number; size: number }[] {
  return cacheInternals(c).store.segments.map((s) => ({
    ...s.extent,
    size: s.size,
  }));
}

/**
 * The store is well formed (§4.3): segments ascending and disjoint, none
 * empty, each extent tight and inside one page of the slot cap, each size
 * the number of its present points.
 */
export function wellFormed(c: CacheState, cap: number): string | undefined {
  let prevEnd: number | undefined;
  for (const segment of cacheInternals(c).store.segments) {
    const e = segment.extent;
    if (e === undefined || segment.size === 0)
      return "the store holds an empty segment";
    if (prevEnd !== undefined && e.start <= prevEnd)
      return "segments not ascending and disjoint";
    if (!segment.lookup(e.start) || !segment.lookup(e.end)) {
      return `extent ${show(e)} is not tight`;
    }
    if (Math.floor(e.start / cap) !== Math.floor(e.end / cap)) {
      return `segment ${show(e)} crosses a page of ${cap} slots`;
    }
    if (segment.countIn(e) !== segment.size)
      return `segment ${show(e)} miscounts its points`;
    prevEnd = e.end;
  }
  return undefined;
}

/**
 * Compares the cache's whole state with the model: watermark, version,
 * volatile slot, `get` over three requests drawn from `r`, the coverage index
 * and its invariants (§4.1, §4.5), well-formedness, and, when `strictLayout`,
 * the layout (N14, N15).
 */
export function compareState(
  c: CacheState,
  model: CacheModel,
  r: ReturnType<typeof rng>,
  strictLayout = true,
): string | undefined {
  const { lo, hi } = model.config;
  if (!Object.is(c.finalizedUntil, model.watermark)) {
    return `finalizedUntil got ${c.finalizedUntil} want ${model.watermark}`;
  }
  if (c.version !== model.version)
    return `version got ${c.version} want ${model.version}`;
  const inner = cacheInternals(c);
  const from = model.volatileFrom();
  const wantFrom = Number.isFinite(from) ? from : undefined;
  if (inner.volatileFrom !== wantFrom) {
    return `volatileFrom got ${inner.volatileFrom} want ${wantFrom}`;
  }
  const frac = () => r.pick([0, 0, 0.25, -0.25, 0.5]);
  const a = r.int(lo - 3, hi + 3);
  const b = r.int(lo - 3, hi + 3);
  const requests: Range[] = [
    { start: model.ms(lo - 3) - 0.25, end: model.ms(hi + 3) + 0.25 },
    {
      start: model.ms(Math.min(a, b)) + frac(),
      end: model.ms(Math.max(a, b)) + frac(),
    },
    { start: model.ms(a), end: model.ms(a) },
  ];
  for (const request of requests) {
    if (request.start > request.end) continue;
    const diff = compareGet(c.get(request), model.get(request), model);
    if (diff !== undefined) return `get(${show(request)}): ${diff}`;
  }
  const ranges = inner.coverage.ranges();
  for (const [i, range] of ranges.entries()) {
    if (range.start > range.end)
      return `coverage range inverted: ${show(ranges)}`;
    const prev = ranges[i - 1];
    if (prev !== undefined && range.start <= prev.end + 1) {
      return `coverage not sorted, disjoint and non-adjacent: ${show(ranges)}`;
    }
    if (inner.volatileFrom !== undefined && range.end >= inner.volatileFrom) {
      return `coverage reaches the volatile region from slot ${inner.volatileFrom}: ${show(ranges)}`;
    }
  }
  if (!sameNumbers(coveredSlots(c), model.coveredSlots())) {
    return `coverage index ${show(ranges)} want slots ${show(model.coveredSlots())}`;
  }
  const formed = wellFormed(c, model.config.cap);
  if (formed !== undefined) return formed;
  if (strictLayout && show(layoutOf(c)) !== show(model.layout())) {
    return `layout got ${show(layoutOf(c))} want ${show(model.layout())}`;
  }
  return undefined;
}

/** The values an integer dtype holds, inclusive (N68); floats hold any number. */
const INTEGER_RANGE: Partial<Record<Dtype, readonly [number, number]>> = {
  i32: [-(2 ** 31), 2 ** 31 - 1],
  u32: [0, 2 ** 32 - 1],
  i16: [-32_768, 32_767],
  u16: [0, 65_535],
  i8: [-128, 127],
  u8: [0, 255],
};

/**
 * A value for a field of `dtype`: mostly a small set, so equal values are
 * common, plus edges. Only values the field can hold, since a put rejects any
 * other (N68): a float field also draws NaN, fractions, values past 2^31 and
 * values below `f32` precision; an integer field draws −0 and the ends of its
 * range.
 */
export function randomValue(r: ReturnType<typeof rng>, dtype: Dtype): number {
  const p = r.int(0, 19);
  const integer = INTEGER_RANGE[dtype];
  if (integer !== undefined) {
    const [min, max] = integer;
    if (p === 0) return min + r.int(0, 2);
    if (p === 1) return -0;
    if (p === 2) return max - r.int(0, 2);
    if (p === 3) return r.int(Math.max(min, -300), Math.min(max, 300));
    return r.int(0, 3);
  }
  if (p === 0) return Number.NaN;
  if (p === 1) return -0;
  if (p === 2) return r.int(-70_000, 70_000) + 0.5;
  if (p === 3) return r.int(-300, 300);
  if (p === 4) return 2 ** 31 + r.int(-2, 2);
  if (p === 5) return 2 ** 32 + r.int(-2, 2);
  if (p === 6) return 1e-40 * r.int(1, 9);
  return r.int(0, 3);
}

/** The batch for `slots`, as plain arrays or as Float64Arrays. */
export function batchOf(
  model: CacheModel,
  slots: readonly number[],
  columns: readonly (readonly number[])[],
  meta: ModelMeta | undefined,
  typed: boolean,
): PutBatch {
  const timestamps = slots.map((s) => model.ms(s));
  return {
    timestamps: typed ? new Float64Array(timestamps) : timestamps,
    fields: Object.fromEntries(
      model.names.map((name, i) => {
        const column = [...(columns[i] as readonly number[])];
        return [name, typed ? new Float64Array(column) : column];
      }),
    ),
    ...(meta === undefined ? {} : { meta: { ...meta } }),
  };
}
