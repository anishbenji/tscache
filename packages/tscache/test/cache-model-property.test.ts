import { describe, expect, it } from "vitest";
import { CacheState, cacheInternals } from "../src/engine/cache";
import { resolveCacheConfig } from "../src/engine/validate";
import type { Dtype, Range } from "../src/types";
import {
  CacheModel,
  type ModelConfig,
  type ModelMeta,
  rng,
} from "./cache-model";
import { batchOf, compareState, randomValue, show } from "./cache-model-checks";

// Implementer tests (not contract tests): CacheState driven by seeded random
// operations and compared after every step with the independent slot-by-slot
// model in cache-model.ts. Unlike cache-property.test.ts, every case draws
// its own interval, alignmentOffset, gapSplitK, segmentSlotCap, schema,
// initial watermark and version, and puts carry meta (version,
// finalizedUntil) with the overlap warning on or off. Checked after every
// step: the put's warnings and `cleared`, the onVersionClear hook, `get` over
// three requests, the coverage index (sorted, disjoint, not adjacent, nothing
// at or after the watermark's slot, equal to the model), the watermark, the
// version, a well-formed store and the segment layout (N14, N15).
//
// A failure prints the seed, the step and the operations before it. To
// replay one, replace the it.each table with [{ first: <seed>, count: 1 }]
// (the rule-reach assertion may then fail too, since one seed reaches fewer
// rules).

const STEPS = 120;
const VERSIONS = ["v1", "v2", "v3"] as const;
const FIELD_SETS: Record<string, Dtype>[] = [
  { price: "f64" },
  { price: "f64", volume: "i16" },
  { a: "f32", b: "u8", c: "i32", d: "u32", e: "i8", f: "u16" },
];

/** Every rule the generator must reach in each batch of seeds. */
const RULES = [
  "unranged put",
  "ranged put",
  "ranged put holding no point",
  "invalidate dropped coverage",
  "setFinalizedUntil moved back and dropped coverage",
  "clear",
  "N17 watermark advanced",
  "N17 lower watermark ignored",
  "N18 first version adopted",
  "N18 version mismatch cleared",
  "N19 claim clipped",
  "N19 provisional point kept",
  "volatile slot left uncovered",
  "warning reported",
  "warning clipped at the volatile region",
  "warning in the volatile region dropped",
  "store split into several segments",
] as const;

function caseConfig(seed: number): ModelConfig {
  const r = rng(seed ^ 0x5bd1e995);
  const interval = r.pick([1, 2, 10, 60_000]);
  const offset = interval === 1 ? 0 : r.int(0, interval - 1);
  const span = r.pick([6, 12, 24, 40]);
  const lo = r.pick([-span, -3, 0, -2 * span]);
  const hi = lo + 2 * span;
  const watermark = r.int(0, 3);
  return {
    interval,
    offset,
    k: r.int(1, 5),
    cap: r.pick([1, 2, 3, 5, 8, 16, 64, 32_768]),
    lo,
    hi,
    warn: r.int(0, 3) > 0,
    fields: r.pick(FIELD_SETS),
    ...(watermark === 0
      ? {}
      : {
          finalizedUntil:
            offset +
            interval * r.int(lo - 2, hi + 2) +
            (interval > 1 && watermark === 2 ? 0.5 : 0),
        }),
    ...(r.int(0, 2) === 0 ? { version: "v1" } : {}),
  };
}

/** A put range of one of six shapes around slots s0..s1. */
function putRange(
  model: CacheModel,
  r: ReturnType<typeof rng>,
  s0: number,
  s1: number,
): Range {
  const ms = (s: number) => model.ms(s);
  const frac = () => r.pick([0, 0, 0.25, -0.25, 0.5]);
  let range: Range;
  const shape = r.int(0, 5);
  if (shape === 0) range = { start: ms(s0), end: ms(s1) };
  else if (shape === 1) range = { start: ms(s0) + 0.25, end: ms(s1) - 0.25 };
  else if (shape === 2) range = { start: ms(s0) - 0.25, end: ms(s1) + 0.25 };
  else if (shape === 3) range = { start: ms(s0), end: ms(s0) };
  else if (shape === 4) range = { start: ms(s0) + 0.25, end: ms(s0) + 0.5 };
  else range = { start: ms(s0) + frac(), end: ms(s1) + frac() };
  return range.start > range.end
    ? { start: range.end, end: range.start }
    : range;
}

/** Slots for a batch: none, one, a random handful, or a contiguous run. */
function pickSlots(
  r: ReturnType<typeof rng>,
  candidates: readonly number[],
): number[] {
  const chosen = new Set<number>();
  const density = r.int(0, 3);
  const count =
    density === 0
      ? 0
      : density === 1
        ? 1
        : r.int(0, Math.min(candidates.length, 12));
  if (density === 3 && candidates.length > 0) {
    const first = r.int(0, candidates.length - 1);
    for (let i = first; i < Math.min(candidates.length, first + count); i++) {
      chosen.add(candidates[i] as number);
    }
  } else {
    for (let i = 0; i < count && candidates.length > 0; i++)
      chosen.add(r.pick(candidates));
  }
  return [...chosen].sort((x, y) => x - y);
}

/** Runs one seeded case; returns the first disagreement, or undefined. */
function runCase(seed: number, seen: Map<string, number>): string | undefined {
  const o = caseConfig(seed);
  const r = rng(seed);
  const note = (event: string) => seen.set(event, (seen.get(event) ?? 0) + 1);
  const model = new CacheModel(o, note);
  let versionClears = 0;
  const c = new CacheState(
    resolveCacheConfig({
      id: "model",
      interval: o.interval,
      alignmentOffset: o.offset,
      fields: o.fields,
      gapSplitK: o.k,
      segmentSlotCap: o.cap,
      warnOnOverlapDiff: o.warn,
      ...(o.finalizedUntil === undefined
        ? {}
        : { finalizedUntil: o.finalizedUntil }),
      ...(o.version === undefined ? {} : { version: o.version }),
    }),
    { onVersionClear: () => versionClears++ },
  );
  const log: string[] = [];
  const frac = () => r.pick([0, 0, 0.25, -0.25, 0.5]);
  for (let step = 0; step < STEPS; step++) {
    const where = () =>
      `seed=${seed} step=${step} config=${show(o)}\n  ${log.slice(-8).join("\n  ")}`;
    const op = r.int(0, 13);
    const a = r.int(o.lo, o.hi);
    const b = r.int(o.lo, o.hi);
    const s0 = Math.min(a, b);
    const s1 = Math.max(a, b);
    if (op <= 8) {
      const range = op >= 4 ? putRange(model, r, s0, s1) : undefined;
      const slots = pickSlots(
        r,
        range === undefined
          ? Array.from({ length: o.hi - o.lo + 1 }, (_, i) => o.lo + i)
          : model.inward(range).filter((s) => o.lo <= s && s <= o.hi),
      );
      const columns = model.names.map((name) =>
        slots.map(() => randomValue(r, model.config.fields[name] as Dtype)),
      );
      const kind = r.int(0, 9);
      const ownWatermark = () => model.ms(r.int(o.lo - 2, o.hi + 2)) + frac();
      let meta: ModelMeta | undefined;
      if (kind <= 2) meta = { finalizedUntil: ownWatermark() };
      else if (kind === 3) meta = { version: r.pick(VERSIONS) };
      else if (kind === 4)
        meta = { version: r.pick(VERSIONS), finalizedUntil: ownWatermark() };
      const batch = batchOf(model, slots, columns, meta, r.int(0, 1) === 1);
      log.push(
        `put slots=${show(slots)} range=${show(range)} meta=${show(meta)} values=${show(columns)}`,
      );
      note(range === undefined ? "unranged put" : "ranged put");
      if (range !== undefined && slots.length === 0)
        note("ranged put holding no point");
      const clearsBefore = versionClears;
      let got: ReturnType<CacheState["put"]>;
      try {
        got = c.put(batch, range === undefined ? undefined : { range });
      } catch (error) {
        return `put threw ${String(error)}\n${where()}`;
      }
      const want = model.put(slots, columns, range, meta);
      if (got.cleared !== want.cleared) {
        return `cleared got ${got.cleared} want ${want.cleared}\n${where()}`;
      }
      if (versionClears - clearsBefore !== (want.cleared ? 1 : 0)) {
        return `onVersionClear called ${versionClears - clearsBefore} times, cleared=${want.cleared}\n${where()}`;
      }
      if (show(got.warnings) !== show(want.warnings)) {
        return `warnings got ${show(got.warnings)} want ${show(want.warnings)}\n${where()}`;
      }
    } else if (op <= 10) {
      const range = {
        start: model.ms(s0) + frac(),
        end: model.ms(s1) + frac(),
      };
      if (range.start > range.end) range.end = range.start;
      log.push(`invalidate ${show(range)}`);
      const before = model.covered.size;
      c.invalidate(range);
      model.invalidate(range);
      if (model.covered.size < before) note("invalidate dropped coverage");
    } else if (op <= 12) {
      const t = model.ms(r.int(o.lo - 2, o.hi + 2)) + frac();
      log.push(`setFinalizedUntil ${t}`);
      const before = model.covered.size;
      c.setFinalizedUntil(t);
      model.setFinalizedUntil(t);
      if (model.covered.size < before)
        note("setFinalizedUntil moved back and dropped coverage");
    } else {
      if (r.int(0, 3) !== 0) continue; // rare, so that state builds up
      log.push("clear");
      note("clear");
      c.clear();
      model.clear();
    }
    if (cacheInternals(c).store.segments.length > 1)
      note("store split into several segments");
    const diff = compareState(c, model, r);
    if (diff !== undefined) return `${diff}\n${where()}`;
  }
  return undefined;
}

describe("CacheState against a slot-by-slot model — architecture §4.3–§4.5, N1, N3, N11, N13–N19", () => {
  it.each(
    // 200 seeds from each start, in batches of 25: many short tests rather
    // than a few long ones, so that each stays far below the default timeout
    // on a loaded machine (step 88). Each batch still reaches every rule.
    [1, 10_001, 0xc0ffee, 0xdeadbeef].flatMap((start) =>
      Array.from({ length: 8 }, (_, i) => ({
        first: start + 25 * i,
        count: 25,
      })),
    ),
  )(
    "random K, cap, grid, meta and warnings agree after every step (seeds $first + $count)",
    ({ first, count }) => {
      const seen = new Map<string, number>();
      const failures: string[] = [];
      for (let seed = first; seed < first + count; seed++) {
        const failure = runCase(seed, seen);
        if (failure !== undefined) failures.push(failure);
      }
      expect(
        failures.slice(0, 3),
        `${failures.length} of ${count} seeds failed`,
      ).toEqual([]);
      // The generator reached every rule this test claims to check.
      expect(RULES.filter((rule) => (seen.get(rule) ?? 0) === 0)).toEqual([]);
    },
  );
});
