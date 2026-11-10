import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CacheState } from "../src/engine/cache";
import { resolveCacheConfig } from "../src/engine/validate";
import { FIELD_ARRAYS } from "../src/segment/dtype";
import type { Dtype, Range } from "../src/types";
import { CacheModel, type ModelMeta, rng, stored } from "./cache-model";
import {
  batchOf,
  compareState,
  coveredSlots,
  layoutOf,
  randomValue,
  rowsOf,
  sameNumbers,
  show,
  wellFormed,
} from "./cache-model-checks";

// Implementer tests (not contract tests): allocation failure injected during
// CacheState.put, checked against the guarantees of architecture §4.3
// ("Allocation failure") and §4.5 ("Order inside put", hooks). After a put
// that fails part-way:
// - the error that propagates is the allocation failure;
// - the store is well formed, and in the layout of its present points unless
//   the put was a replace (the one documented exception);
// - no point outside the put's range changed, and each point inside it is
//   its old value, its new value, or removed by the put's own replace (only
//   below the put's own watermark, N19);
// - no coverage was added, coverage outside the put's range is unchanged,
//   and when any point inside the range changed none of the range is covered;
// - the watermark did not move;
// - a version step that ran before the write stays (the cache was cleared
//   and the version adopted, and onVersionClear was called once); if it did
//   not run, nothing changed at all.
// The run then either retries the same put, which must land exactly on the
// model, or carries on from the half-written state.
//
// Faults are injected by making the n-th typed-array allocation of a put
// throw: the field-array constructors the segments, the store and batch
// validation take from FIELD_ARRAYS, and the global Float64Array and
// Uint8Array the slot and mask arrays use. Each is wrapped in a Proxy, so
// instanceof, statics and species behave as before; the wrapper counts only
// while a put is armed.

const FAULT = new RangeError("injected: Array buffer allocation failed");
let countdown = -1; // -1: disarmed
let fired = false;
let firedIn = "";

function failing<T extends object>(ctor: T, label: string): T {
  return new Proxy(ctor, {
    construct(target, args, newTarget) {
      if (countdown >= 0 && typeof args[0] === "number") {
        if (countdown === 0) {
          countdown = -1;
          fired = true;
          firedIn = label;
          throw FAULT;
        }
        countdown--;
      }
      return Reflect.construct(
        target as new (
          ...a: unknown[]
        ) => object,
        args,
        newTarget,
      );
    },
  });
}

const fieldArrays = FIELD_ARRAYS as Record<Dtype, (typeof FIELD_ARRAYS)[Dtype]>;
const originals = { ...fieldArrays };

beforeAll(() => {
  for (const dtype of Object.keys(originals) as Dtype[]) {
    fieldArrays[dtype] = failing(originals[dtype], "a field array");
  }
  vi.stubGlobal("Float64Array", failing(Float64Array, "a slot array"));
  vi.stubGlobal("Uint8Array", failing(Uint8Array, "a mask"));
});

afterAll(() => {
  Object.assign(fieldArrays, originals);
  vi.unstubAllGlobals();
});

const STEPS = 60;
const FIELD_SETS: Record<string, Dtype>[] = [
  { price: "f64", volume: "i16" },
  { a: "f32", b: "u8", c: "i32", d: "u32", e: "i8", f: "u16" },
];

/** Every outcome the generator must reach in each batch of seeds. */
const OUTCOMES = [
  "put succeeded",
  "failed with nothing changed",
  "failed part-way, points changed",
  "failed part-way, coverage withdrawn only",
  "failed after a version clear",
  "failed replace removed a point",
  "fault in a field array",
  "fault in a slot array",
  "fault in a mask",
] as const;

function runCase(
  seed: number,
  retry: boolean,
  seen: Map<string, number>,
): string | undefined {
  const r = rng(seed);
  const note = (event: string) => seen.set(event, (seen.get(event) ?? 0) + 1);
  const interval = r.pick([1, 10]);
  const offset = interval === 1 ? 0 : r.int(0, interval - 1);
  const lo = -24;
  const hi = 24;
  const o = {
    interval,
    offset,
    k: r.int(1, 4),
    cap: r.pick([2, 4, 8, 16, 32_768]),
    lo,
    hi,
    warn: r.int(0, 1) === 1,
    fields: r.pick(FIELD_SETS),
    ...(r.int(0, 2) === 0
      ? { finalizedUntil: offset + interval * r.int(lo, hi) }
      : {}),
    ...(r.int(0, 2) === 0 ? { version: "v1" } : {}),
  };
  const model = new CacheModel(o);
  let versionClears = 0;
  const c = new CacheState(
    resolveCacheConfig({
      id: "faults",
      interval,
      alignmentOffset: offset,
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
  // A failed replace may leave the documented non-canonical layout; from then
  // on only well-formedness is checked.
  let strictLayout = true;
  for (let step = 0; step < STEPS; step++) {
    const where = () =>
      `seed=${seed} retry=${retry} step=${step} config=${show(o)}\n  ${log.slice(-6).join("\n  ")}`;
    const op = r.int(0, 11);
    const a = r.int(lo, hi);
    const b = r.int(lo, hi);
    const s0 = Math.min(a, b);
    const s1 = Math.max(a, b);
    if (op >= 10) {
      const t = model.ms(r.int(lo, hi)) + r.pick([0, 0.5]);
      log.push(`setFinalizedUntil ${t}`);
      c.setFinalizedUntil(t);
      model.setFinalizedUntil(t);
      continue;
    }
    if (op === 9) {
      const range = { start: model.ms(s0), end: model.ms(s1) };
      log.push(`invalidate ${show(range)}`);
      c.invalidate(range);
      model.invalidate(range);
      continue;
    }
    const range: Range | undefined =
      op >= 4
        ? {
            start: model.ms(s0) - r.pick([0, 0.5 * interval]),
            end: model.ms(s1) + r.pick([0, 0.5 * interval]),
          }
        : undefined;
    const candidates = range
      ? model.inward(range)
      : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    const chosen = new Set<number>();
    const n = r.int(0, 10);
    for (let i = 0; i < n && candidates.length > 0; i++)
      chosen.add(r.pick(candidates));
    const slots = [...chosen].sort((x, y) => x - y);
    const columns = model.names.map((name) =>
      slots.map(() => randomValue(r, model.config.fields[name] as Dtype)),
    );
    const kind = r.int(0, 5);
    let meta: ModelMeta | undefined;
    if (kind === 0)
      meta = { finalizedUntil: model.ms(r.int(lo, hi + 2)) + r.pick([0, 0.5]) };
    else if (kind === 1) meta = { version: r.pick(["v1", "v2"]) };
    const batch = batchOf(model, slots, columns, meta, r.int(0, 1) === 1);
    const options = range === undefined ? undefined : { range };
    log.push(
      `put slots=${show(slots)} range=${show(range)} meta=${show(meta)}`,
    );

    const before = {
      rows: rowsOf(c, model),
      covered: coveredSlots(c),
      watermark: c.finalizedUntil,
      version: c.version,
      clears: versionClears,
    };
    const authority = model.authority(range);
    const touched = model.touched(slots, range);
    let threw: unknown;
    fired = false;
    countdown = r.int(0, 2) > 0 ? r.int(0, 24) : -1;
    try {
      c.put(batch, options);
    } catch (error) {
      threw = error;
    } finally {
      countdown = -1;
    }
    if (threw !== undefined && threw !== FAULT) {
      return `put threw something other than the injected fault: ${String(threw)}\n${where()}`;
    }
    if (threw === undefined && fired) {
      return `the injected allocation failure was swallowed\n${where()}`;
    }
    if (threw === undefined) {
      note("put succeeded");
      const want = model.put(slots, columns, range, meta);
      if (versionClears - before.clears !== (want.cleared ? 1 : 0)) {
        return `onVersionClear called ${versionClears - before.clears} times\n${where()}`;
      }
      const diff = compareState(c, model, r, strictLayout);
      if (diff !== undefined) return `after a put: ${diff}\n${where()}`;
      continue;
    }
    log.push(`  ^ failed by injection in ${firedIn}`);
    note(`fault in ${firedIn}`);

    // The version step (§4.5): it ran before the write and stays, or the
    // fault came during validation and nothing at all changed.
    const versionStepRan =
      meta?.version !== undefined &&
      c.version === meta.version &&
      before.version !== meta.version;
    const after = { rows: rowsOf(c, model), covered: coveredSlots(c) };
    if (!versionStepRan && c.version !== before.version) {
      return `a failed put changed the version ${before.version} -> ${c.version}\n${where()}`;
    }
    const cleared = versionStepRan && model.applyVersion(meta?.version);
    if (versionClears - before.clears !== (cleared ? 1 : 0)) {
      return `onVersionClear called ${versionClears - before.clears} times after a failed put, cleared=${cleared}\n${where()}`;
    }
    if (cleared) note("failed after a version clear");
    // What the write started from: the state before, or empty after a clear.
    const base = {
      rows: cleared ? new Map<number, number[]>() : before.rows,
      covered: cleared ? [] : before.covered,
    };

    if (!Object.is(c.finalizedUntil, before.watermark)) {
      return `a failed put moved the watermark ${before.watermark} -> ${c.finalizedUntil}\n${where()}`;
    }
    const formed = wellFormed(c, o.cap);
    if (formed !== undefined)
      return `after a failed put: ${formed}\n${where()}`;

    const own =
      meta?.finalizedUntil === undefined
        ? Number.POSITIVE_INFINITY
        : model.slotAtOrAfter(meta.finalizedUntil);
    let changed = false;
    for (let s = lo - 4; s <= hi + 4; s++) {
      const was = base.rows.get(s);
      const now = after.rows.get(s);
      if (was === now || (was && now && sameNumbers(was, now))) continue;
      changed = true;
      if (touched === undefined || s < touched.start || s > touched.end) {
        return `a failed put changed slot ${s} outside its range ${show(touched)}: ${show(was)} -> ${show(now)}\n${where()}`;
      }
      const i = slots.indexOf(s);
      const fresh =
        i === -1
          ? undefined
          : model.names.map((name, f) =>
              stored(
                o.fields[name] as Dtype,
                (columns[f] as number[])[i] as number,
              ),
            );
      const removable =
        authority !== undefined &&
        authority.start <= s &&
        s <= authority.end &&
        s < own;
      if (now === undefined && removable) {
        note("failed replace removed a point");
        continue;
      }
      if (
        now === undefined ||
        fresh === undefined ||
        !sameNumbers(now, fresh)
      ) {
        return `a failed put left slot ${s} = ${show(now)}: neither old ${show(was)}, new ${show(fresh)} nor removed by its replace\n${where()}`;
      }
    }

    const baseCovered = new Set(base.covered);
    for (const s of after.covered) {
      if (!baseCovered.has(s))
        return `a failed put covered slot ${s}\n${where()}`;
    }
    const outside = (list: number[]) =>
      list.filter(
        (s) => touched === undefined || s < touched.start || s > touched.end,
      );
    if (!sameNumbers(outside(base.covered), outside(after.covered))) {
      return `a failed put changed coverage outside its range ${show(touched)}\n${where()}`;
    }
    const inside = after.covered.filter(
      (s) => touched !== undefined && touched.start <= s && s <= touched.end,
    );
    if (changed && inside.length > 0) {
      return `a failed put changed points in ${show(touched)} yet slots ${show(inside)} there are still covered\n${where()}`;
    }
    const covChanged = !sameNumbers(base.covered, after.covered);
    if (changed) note("failed part-way, points changed");
    else if (covChanged) note("failed part-way, coverage withdrawn only");
    else if (!versionStepRan) note("failed with nothing changed");

    // The model takes over what the cache now holds inside the put's range.
    if (touched !== undefined) {
      for (let s = touched.start; s <= touched.end; s++) {
        const now = after.rows.get(s);
        if (now === undefined) model.rows.delete(s);
        else model.rows.set(s, now);
      }
    }
    model.covered.clear();
    for (const s of after.covered) model.covered.add(s);
    if (authority !== undefined && show(layoutOf(c)) !== show(model.layout())) {
      note("failed replace left the documented layout exception");
      strictLayout = false;
    }
    const diff = compareState(c, model, r, strictLayout);
    if (diff !== undefined)
      return `after a failed put, the model taking over: ${diff}\n${where()}`;

    if (!retry) continue;
    let result: ReturnType<CacheState["put"]>;
    try {
      result = c.put(batchOf(model, slots, columns, meta, false), options);
    } catch (error) {
      return `the retried put threw ${String(error)}\n${where()}`;
    }
    const want = model.put(slots, columns, range, meta);
    if (
      result.cleared !== want.cleared ||
      show(result.warnings) !== show(want.warnings)
    ) {
      return `the retried put returned ${show(result)} want ${show(want)}\n${where()}`;
    }
    const retried = compareState(c, model, r, strictLayout);
    if (retried !== undefined)
      return `after retrying a failed put: ${retried}\n${where()}`;
  }
  return undefined;
}

describe("CacheState.put failing part-way — architecture §4.3 allocation failure, §4.5 order inside put", () => {
  it.each([
    { first: 1, count: 160, retry: true },
    { first: 0xc0ffee, count: 160, retry: true },
    { first: 10_001, count: 160, retry: false },
    { first: 0xdeadbeef, count: 160, retry: false },
  ])(
    "every injected allocation failure leaves the documented state (seeds $first + $count, retry $retry)",
    ({ first, count, retry }) => {
      const seen = new Map<string, number>();
      const failures: string[] = [];
      for (let seed = first; seed < first + count; seed++) {
        let failure: string | undefined;
        try {
          failure = runCase(seed, retry, seen);
        } catch (error) {
          failure = `seed=${seed}: the harness threw ${String(error)}`;
        } finally {
          countdown = -1;
        }
        if (failure !== undefined) failures.push(failure);
      }
      expect(
        failures.slice(0, 3),
        `${failures.length} of ${count} seeds failed`,
      ).toEqual([]);
      expect(
        OUTCOMES.filter((outcome) => (seen.get(outcome) ?? 0) === 0),
      ).toEqual([]);
    },
  );
});
