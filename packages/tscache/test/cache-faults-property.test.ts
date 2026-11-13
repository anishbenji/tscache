import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CacheState } from "../src/engine/cache";
import { resolveCacheConfig } from "../src/engine/validate";
import { FIELD_ARRAYS } from "../src/segment/dtype";
import type { Dtype, Range } from "../src/types";
import {
  CacheModel,
  type ModelMeta,
  rng,
  stored,
  type WriteStep,
} from "./cache-model";
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
// - the store is well formed, and in the layout of its present points, with
//   one exception (§4.3): after a replace's whole first pass, the one segment
//   whose middle the removal cleared may stay unsplit, and the layout must
//   then be exactly that;
// - no point outside the put's range changed, and each point inside it is
//   its old value, its new value, or removed by the put's own replace (only
//   below the put's own watermark, N19);
// - the points as a whole equal one of the legal states (N70): the state
//   after a prefix of the write's steps (per pass, the replace's removal,
//   then each write run in ascending slot order), computed from the model's
//   state after the version step; carrying on, the model adopts that state;
// - no coverage was added, coverage outside the put's range is unchanged,
//   and none of the range is covered, whether or not any point changed;
// - the watermark did not move;
// - the version step, which runs before the write, stays: the version the
//   model derives is adopted, a mismatch has cleared the cache, and
//   onVersionClear was called once for it.
// A put that fails during validation (the fault fired with validateBatch,
// §4.3, on the stack) changes nothing at all: points, coverage, watermark and
// version are as before, and onMutate is not called (§4.10.4); after
// validation, onMutate is called once.
// The run then either retries the same put, which must land exactly on the
// model, or carries on from the half-written state.
//
// Faults are injected by making the n-th typed-array allocation of a put
// throw: the field-array constructors the segments, the store and batch
// validation take from FIELD_ARRAYS, and the global Float64Array and
// Uint8Array the slot and mask arrays use. Each is wrapped in a Proxy, so
// instanceof, statics and species behave as before; the wrapper counts only
// while a put is armed.
//
// A failure prints the seed, the step, the case's configuration and the
// operations before it. To replay one, replace the it.each table with
// [{ start: <seed>, first: <seed>, count: 1, retry: <as printed> }]. The
// outcome-reach assertion runs after the last batch of a seed start, so it
// does not run for such a row; one seed reaches fewer outcomes than a
// start's 160.

const FAULT = new RangeError("injected: Array buffer allocation failed");
let countdown = -1; // -1: disarmed
let fired = false;
let firedIn = "";
/** Whether the fault fired inside validateBatch, the put's validation (§4.3). */
let firedInValidation = false;

function failing<T extends object>(ctor: T, label: string): T {
  return new Proxy(ctor, {
    construct(target, args, newTarget) {
      if (countdown >= 0 && typeof args[0] === "number") {
        if (countdown === 0) {
          countdown = -1;
          fired = true;
          firedIn = label;
          firedInValidation = (new Error().stack ?? "").includes(
            "validateBatch",
          );
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

/** V8's stack depth setting, which the DOM lib types do not declare. */
const V8Error = Error as ErrorConstructor & { stackTraceLimit: number };
const stackTraceLimit = V8Error.stackTraceLimit;

beforeAll(() => {
  // Deep enough that validateBatch shows on the stack of a fault inside it.
  V8Error.stackTraceLimit = 50;
  for (const dtype of Object.keys(originals) as Dtype[]) {
    fieldArrays[dtype] = failing(originals[dtype], "a field array");
  }
  vi.stubGlobal("Float64Array", failing(Float64Array, "a slot array"));
  vi.stubGlobal("Uint8Array", failing(Uint8Array, "a mask"));
});

afterAll(() => {
  Object.assign(fieldArrays, originals);
  vi.unstubAllGlobals();
  V8Error.stackTraceLimit = stackTraceLimit;
});

const STEPS = 60;
const FIELD_SETS: Record<string, Dtype>[] = [
  { price: "f64", volume: "i16" },
  { a: "f32", b: "u8", c: "i32", d: "u32", e: "i8", f: "u16" },
];

/** Every outcome the generator must reach from each seed start. */
const OUTCOMES = [
  "put succeeded",
  "failed in validation, nothing changed",
  "failed in the write with nothing changed",
  "failed part-way, points changed",
  "failed part-way, coverage withdrawn only",
  "failed after a version clear",
  "failed replace removed a point",
  "failed between write runs",
  "fault in a field array",
  "fault in a slot array",
  "fault in a mask",
] as const;

/** The same present points with the same values (NaN and −0 included). */
function sameRows(
  a: ReadonlyMap<number, number[]>,
  b: ReadonlyMap<number, number[]>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [s, row] of a) {
    const other = b.get(s);
    if (other === undefined || !sameNumbers(row, other)) return false;
  }
  return true;
}

/** A write step for a failure message: the removal's span or a run's slots. */
function stepName(step: WriteStep): string {
  return step.kind === "remove"
    ? `remove ${step.start}..${step.end}`
    : `run ${step.points.map((p) => p.slot).join(",")}`;
}

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
  let mutations = 0;
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
    {
      onVersionClear: () => versionClears++,
      // Fires once for every mutating call that passed validation (§4.10.4).
      onMutate: () => mutations++,
    },
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
      mutations,
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

    // onMutate fires once for a put that passed validation and never for
    // one that did not (§4.10.4).
    const mutated = mutations - before.mutations;
    if (mutated !== (firedInValidation ? 0 : 1)) {
      return `onMutate called ${mutated} times by a put that failed ${firedInValidation ? "in validation" : "after it"}\n${where()}`;
    }
    // A fault during validation (§4.5 order inside put, errors): nothing at
    // all may have changed.
    const after = { rows: rowsOf(c, model), covered: coveredSlots(c) };
    if (firedInValidation) {
      const same =
        c.version === before.version &&
        Object.is(c.finalizedUntil, before.watermark) &&
        versionClears === before.clears &&
        sameNumbers(before.covered, after.covered) &&
        before.rows.size === after.rows.size &&
        [...before.rows].every(([s, row]) => {
          const now = after.rows.get(s);
          return now !== undefined && sameNumbers(row, now);
        });
      if (!same) {
        return `a put that failed in validation changed the cache\n${where()}`;
      }
      note("failed in validation, nothing changed");
      const formed = wellFormed(c, o.cap);
      if (formed !== undefined)
        return `after a failed validation: ${formed}\n${where()}`;
      if (retry) {
        const want = model.put(slots, columns, range, meta);
        const result = c.put(
          batchOf(model, slots, columns, meta, false),
          options,
        );
        if (
          result.cleared !== want.cleared ||
          show(result.warnings) !== show(want.warnings)
        ) {
          return `the retried put returned ${show(result)} want ${show(want)}\n${where()}`;
        }
        const retried = compareState(c, model, r, strictLayout);
        if (retried !== undefined)
          return `after retrying a put that failed in validation: ${retried}\n${where()}`;
      }
      continue;
    }

    // The version step (§4.5) runs before the write and stays when the write
    // fails: the model applies it, whatever the cache now reports.
    const cleared = model.applyVersion(meta?.version);
    if (c.version !== model.version) {
      return `a failed put left the version ${c.version}, want ${model.version} (before ${before.version})\n${where()}`;
    }
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

    // The points as a whole are one of the legal states (N70): the state
    // after some prefix of the write's steps, computed from the model's state
    // after the version step. Prefixes that leave the same points are one
    // member of the set.
    const steps = model.writeSteps(slots, columns, range, meta?.finalizedUntil);
    const legal = model.failureStates(steps);
    const matched = legal.findIndex((state) => sameRows(state, after.rows));
    if (matched === -1) {
      return `a failed put left points ${show([...after.rows.keys()].sort((x, y) => x - y))}, which no prefix of its ${steps.length} write steps ${show(steps.map(stepName))} gives (N70)\n${where()}`;
    }
    const isRun = (step: WriteStep) => step.kind === "run";
    if (
      steps.slice(0, matched).some(isRun) &&
      steps.slice(matched).some(isRun)
    ) {
      note("failed between write runs");
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
    // A failed write withdraws the coverage of its whole range, whether or
    // not any point changed (§4.3 allocation failure, §4.5 order inside put).
    if (inside.length > 0) {
      return `a failed write left slots ${show(inside)} of its range ${show(touched)} covered${changed ? " after changing points there" : ""}\n${where()}`;
    }
    const covChanged = !sameNumbers(base.covered, after.covered);
    if (changed) note("failed part-way, points changed");
    else if (covChanged) note("failed part-way, coverage withdrawn only");
    else if (!cleared) note("failed in the write with nothing changed");

    // The model takes over the legal state the cache was found in.
    model.rows.clear();
    for (const [s, row] of legal[matched] as Map<number, number[]>) {
      model.rows.set(s, row);
    }
    model.covered.clear();
    for (const s of after.covered) model.covered.add(s);
    // The one layout exception (§4.3 allocation failure): a replace that
    // cleared the middle of a segment and then could not allocate the split.
    // A fault inside the removal or a write run changes nothing (N70), so it
    // leaves the canonical layout. The exception is taken only from a store
    // in the canonical layout, with the points as the replace's whole first
    // pass leaves them, and the layout must then be exactly the one the model
    // allows: the canonical layout with the segment whose middle the removal
    // cleared kept unsplit. §4.3 and N70 do not say when the split is
    // attempted; the test reads it as following the pass's write runs, which
    // waits on the user's decision 52.
    if (strictLayout && show(layoutOf(c)) !== show(model.layout())) {
      const firstPass = steps.filter((step) => step.pass === 1).length;
      const removal = steps.find(
        (step): step is Extract<WriteStep, { kind: "remove" }> =>
          step.kind === "remove",
      );
      const before = [...(legal[0] as Map<number, number[]>).keys()].sort(
        (x, y) => x - y,
      );
      const allowed =
        removal === undefined
          ? undefined
          : model.unsplitLayout(before, removal);
      if (
        allowed === undefined ||
        !sameRows(legal[firstPass] as Map<number, number[]>, after.rows) ||
        show(layoutOf(c)) !== show(allowed)
      ) {
        return `a failed put left the layout ${show(layoutOf(c))}, want ${show(model.layout())}, or after a replace that cleared a segment's middle ${show(allowed)} with the points after its whole first pass (${firstPass} of ${steps.length} steps; found after ${matched})\n${where()}`;
      }
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

/** The first seed of each group of 160, and whether its failed puts retry. */
const STARTS = [
  [1, true],
  [0xc0ffee, true],
  [10_001, false],
  [0xdeadbeef, false],
] as const;
/** Each group runs as 16 batches of 10. */
const BATCHES = 16;
const BATCH_SIZE = 10;

/** Per seed start: the outcomes its batches have reached and how many ran. */
const reach = new Map<number, { seen: Map<string, number>; batches: number }>();

describe("CacheState.put failing part-way — architecture §4.3 allocation failure, §4.5 order inside put", () => {
  it.each(
    // Many short tests rather than a few long ones, so that each stays far
    // below the default timeout on a loaded machine (step 88). The
    // outcome-reach assertion covers a whole start, as one batch of 10
    // reaches some outcomes only a few times; it runs in the start's last
    // batch, after the others, since the tests of a file run in order.
    STARTS.flatMap(([start, retry]) =>
      Array.from({ length: BATCHES }, (_, i) => ({
        start,
        first: start + BATCH_SIZE * i,
        count: BATCH_SIZE,
        retry,
      })),
    ),
  )(
    "every injected allocation failure leaves the documented state (seeds $first + $count, retry $retry)",
    ({ start, first, count, retry }) => {
      const group = reach.get(start) ?? { seen: new Map(), batches: 0 };
      reach.set(start, group);
      const failures: string[] = [];
      for (let seed = first; seed < first + count; seed++) {
        let failure: string | undefined;
        try {
          failure = runCase(seed, retry, group.seen);
        } catch (error) {
          failure = `seed=${seed}: the harness threw ${String(error)}`;
        } finally {
          countdown = -1;
        }
        if (failure !== undefined) failures.push(failure);
      }
      group.batches++;
      expect(
        failures.slice(0, 3),
        `${failures.length} of ${count} seeds failed`,
      ).toEqual([]);
      if (first + count === start + BATCHES * BATCH_SIZE) {
        expect(group.batches, `batches of seed start ${start} run`).toBe(
          BATCHES,
        );
        // The start's seeds reached every outcome this test claims to check.
        expect(
          OUTCOMES.filter((outcome) => (group.seen.get(outcome) ?? 0) === 0),
        ).toEqual([]);
      }
    },
  );
});
