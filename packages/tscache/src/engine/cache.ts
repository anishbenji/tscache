/**
 * One cache's state (docs/architecture.md §4.5): its resolved config, the
 * segments, the coverage index, the finalized watermark and the dataset
 * version. Speaks milliseconds to its callers and slots to the modules
 * beneath; every conversion goes through grid.ts.
 */

import { CoverageIndex } from "../coverage";
import {
  ConfigError,
  InvalidRangeError,
  PutError,
  show,
  TscacheError,
} from "../errors";
import { type SlotRange, slotAtOrAfter, snapOut, toMs } from "../grid";
import { getOwn, setOwn } from "../segment/own";
import type { Columns } from "../segment/types";
import type {
  FieldArray,
  GetResult,
  HydrateResult,
  MergeWarning,
  PutBatch,
  PutOptions,
  Range,
  ResolvedCacheConfig,
  Snapshot,
} from "../types";
import { validateBatch } from "./batch";
import { SegmentStore } from "./merge";
import type { SlotWarning } from "./overlap";
import { collect, read } from "./read";
import { takeSnapshot, type ValidSnapshot, validateSnapshot } from "./snapshot";

export interface CachePutResult {
  /** In ms, outside the volatile region only. */
  warnings: MergeWarning[];
  /** True when a version mismatch cleared the cache before this put. */
  cleared: boolean;
}

/** What a watermark move did: whether its value changed, and the coverage it withdrew. */
interface Moved {
  changed: boolean;
  removed: SlotRange | undefined;
}

/** Validated `PutBatch.meta`: the watermark comes with its slot. */
interface Meta {
  version?: string;
  finalizedUntil?: { t: number; slot: number };
}

/** Structural rejects of a batch have no offending timestamp. */
function reject(message: string): never {
  throw new PutError(message, { code: "field-mismatch", offenderIndex: -1 });
}

function validVersion(version: unknown): string {
  if (typeof version !== "string" || version.length === 0) {
    reject(`meta.version must be a non-empty string, got ${show(version)}`);
  }
  return version;
}

/** The tight slot range of validated points, or undefined when empty. */
function spanOf(points: Columns): SlotRange | undefined {
  const n = points.slots.length;
  if (n === 0) return undefined;
  return {
    start: points.slots[0] as number,
    end: points.slots[n - 1] as number,
  };
}

/** The part of a range below `limit`, or undefined when there is none. */
export function below(range: SlotRange, limit: number): SlotRange | undefined {
  if (range.start >= limit) return undefined;
  return { start: range.start, end: Math.min(range.end, limit - 1) };
}

/** Points `[from, to)` as views; mergeFrom copies what it keeps. */
function slice(points: Columns, from: number, to: number): Columns {
  const fields: Record<string, FieldArray> = {};
  for (const name of Object.keys(points.fields)) {
    const values = getOwn(points.fields, name) as FieldArray;
    setOwn(fields, name, values.subarray(from, to));
  }
  return { slots: points.slots.subarray(from, to), fields };
}

/**
 * The slots a put claims as authoritative: the slots it touches (its
 * authority, N13, or without one its batch's span, N3), cut below the put's
 * own watermark (N19).
 */
function claimOf(
  touched: SlotRange | undefined,
  limit: number | undefined,
): SlotRange | undefined {
  if (touched === undefined || limit === undefined) return touched;
  return below(touched, limit);
}

/** Splits points into those below `limit` and the rest. */
function splitAt(points: Columns, limit: number): [Columns, Columns] {
  let i = 0;
  while (i < points.slots.length && (points.slots[i] as number) < limit) i++;
  return [slice(points, 0, i), slice(points, i, points.slots.length)];
}

/** What a change touched, in slot terms (§4.10.4): what persistence must learn. */
export type CacheChange =
  /** Points or coverage below the watermark may have changed in these slots. */
  | { kind: "write"; slots: SlotRange }
  /** Coverage was subtracted over these slots. */
  | { kind: "remove"; slots: SlotRange }
  /** Every point and all coverage went. */
  | { kind: "clear" }
  | { kind: "version" }
  | { kind: "watermark" };

/** Hooks the owner may pass; each is optional. */
export interface CacheStateHooks {
  /**
   * Called once when a put's version mismatch has cleared the cache: after
   * the put was applied, or, if its write then failed, before the error
   * propagates (the cache is empty either way). The engine emits
   * `cacheCleared 'version-mismatch'` from it.
   */
  onVersionClear?: () => void;
  /**
   * Called synchronously after each change to what persistence stores
   * (§4.10.4). It reports; it never alters the operation.
   */
  onChange?: (change: CacheChange) => void;
  /**
   * Called once at the end of every mutating call (put, hydrate, invalidate,
   * clear, setFinalizedUntil) that passed validation, after that call's
   * onChange calls and before it returns or rethrows; never by get,
   * snapshot, coverage or restore. The load's abandon signal (§4.10.5),
   * independent of whether the call changed anything the disk holds.
   */
  onMutate?: () => void;
}

/** What `restore` applied (§4.10.5). */
export interface RestoreResult {
  /** The ranges covered by the load, in ms: ascending, disjoint, adjacent ones merged. */
  applied: Range[];
  /**
   * The stored records are not what the cache now holds (a record invalid,
   * skipped, of another version or clipped, or an orphan page): the next
   * flush rewrites the cache.
   */
  rewrite: boolean;
}

/** The records `restore` takes: untrusted, as read from disk (§4.10.5). */
export interface StoredRecords {
  cache: unknown;
  pages: readonly unknown[];
}

/**
 * What the persistence code reaches inside a cache (§4.10.2, §4.10.5):
 * `engine/restore.ts` and `persist/records.ts`, through `cacheInternals`.
 * No package entry exports it.
 */
export interface CacheInternals {
  readonly store: SegmentStore;
  readonly coverage: CoverageIndex;
  /** First provisional slot; undefined when nothing is provisional. */
  readonly volatileFrom: number | undefined;
  /** Sets the version without clearing (N18); the caller checks there is none. */
  adoptVersion(version: string): void;
  /** Advances the watermark forwards only (N17), as a put's meta does. */
  advance(t: number, slot: number): void;
  /** Reports a change to the owner (§4.10.4). */
  report(change: CacheChange): void;
}

/** Set by CacheState's static block. */
let internalsOf: (state: CacheState) => CacheInternals;

/** A cache's internals, for the persistence code only (§4.10.5). */
export function cacheInternals(state: CacheState): CacheInternals {
  return internalsOf(state);
}

type Restore = (state: CacheState, stored: StoredRecords) => RestoreResult;

/**
 * `restore`'s implementation, `engine/restore.ts`: installed by the
 * persister, which loads lazily (§4.10.8), so an application that persists
 * nothing never loads it.
 */
let restoreImpl: Restore | undefined;

/** Installs `restore`'s implementation; idempotent. */
export function installRestore(impl: Restore): void {
  restoreImpl = impl;
}

export class CacheState {
  readonly config: ResolvedCacheConfig;
  readonly #hooks: CacheStateHooks;
  readonly #store: SegmentStore;
  readonly #coverage = new CoverageIndex();
  #version: string | undefined;
  #finalizedUntil: number | undefined;
  /** First provisional slot; undefined when nothing is provisional. */
  #volatileFrom: number | undefined;

  constructor(config: ResolvedCacheConfig, hooks: CacheStateHooks = {}) {
    this.config = config;
    this.#hooks = hooks;
    this.#store = new SegmentStore(config);
    this.#version = config.version;
    if (config.finalizedUntil !== undefined) {
      try {
        this.#volatileFrom = slotAtOrAfter(config.finalizedUntil, config);
      } catch (error) {
        if (!(error instanceof InvalidRangeError)) throw error;
        throw new ConfigError(`finalizedUntil: ${error.message}`);
      }
      this.#finalizedUntil = config.finalizedUntil;
    }
  }

  static {
    internalsOf = (state) => ({
      store: state.#store,
      coverage: state.#coverage,
      get volatileFrom() {
        return state.#volatileFrom;
      },
      adoptVersion: (version) => {
        state.#version = version;
      },
      advance: (t, slot) => {
        state.#advance(t, slot);
      },
      report: (change) => state.#hooks.onChange?.(change),
    });
  }

  /** The dataset version in force: config.version, then whatever puts report. */
  get version(): string | undefined {
    return this.#version;
  }

  /** Points at t >= finalizedUntil are provisional; undefined: nothing is. */
  get finalizedUntil(): number | undefined {
    return this.#finalizedUntil;
  }

  /**
   * Validate → version check and clear → write → advance the watermark →
   * record coverage (§4.5). A rejected batch changes nothing; a write that
   * fails part-way withdraws the coverage it would have recorded.
   */
  put(batch: PutBatch, options?: PutOptions): CachePutResult {
    const { points, authority } = validateBatch(
      batch,
      this.config,
      options?.range,
    );
    const meta = this.#validateMeta(batch.meta);
    return this.#mutating(() => this.#putValid(points, authority, meta));
  }

  /**
   * Runs a mutating call that passed validation, then signals `onMutate`
   * once, after its `onChange` calls, also when it throws (§4.10.4).
   */
  #mutating<T>(call: () => T): T {
    try {
      return call();
    } finally {
      this.#hooks.onMutate?.();
    }
  }

  #putValid(
    points: Columns,
    authority: SlotRange | undefined,
    meta: Meta,
  ): CachePutResult {
    const cleared = this.#applyVersion(meta.version);
    const wm = meta.finalizedUntil;
    const touched = authority ?? spanOf(points);
    const claim = claimOf(touched, wm?.slot);
    const slotWarnings = this.#writeOrWithdraw(
      points,
      authority,
      wm?.slot,
      touched,
      cleared,
    );
    const moved = wm === undefined ? undefined : this.#advance(wm.t, wm.slot);
    this.#reportWrite(touched);
    this.#reportWatermark(moved);
    if (claim !== undefined) this.#cover(claim);
    if (cleared) this.#hooks.onVersionClear?.();
    return { warnings: this.#toWarnings(slotWarnings), cleared };
  }

  /**
   * meta.finalizedUntil only ever moves the watermark forward (N17).
   * Returns what moved, as #setWatermark does; undefined when nothing did.
   */
  #advance(t: number, slot: number): Moved | undefined {
    if (this.#finalizedUntil === undefined || t > this.#finalizedUntil) {
      return this.#setWatermark(t, slot);
    }
    return undefined;
  }

  /** A `write` over `touched`, clipped below the volatile region (§4.10.4). */
  #reportWrite(touched: SlotRange | undefined): void {
    if (touched === undefined) return;
    const slots =
      this.#volatileFrom === undefined
        ? touched
        : below(touched, this.#volatileFrom);
    if (slots !== undefined) this.#hooks.onChange?.({ kind: "write", slots });
  }

  /** `watermark`, then the removal of the region it made provisional. */
  #reportWatermark(moved: Moved | undefined): void {
    if (moved?.changed) this.#hooks.onChange?.({ kind: "watermark" });
    if (moved?.removed !== undefined) {
      this.#hooks.onChange?.({ kind: "remove", slots: moved.removed });
    }
  }

  /**
   * Every present point in the range, with coverage and 'uncached' misses.
   * With `snapshot: true` the result also carries a Snapshot of the same
   * request, taken from the same state (§2.8, N36).
   */
  get(range: Range, options?: { snapshot?: boolean }): GetResult {
    const request = snapOut(range, this.config);
    const result = read(
      request,
      this.#store.segments,
      this.#coverage,
      this.config,
      this.config.fields,
    );
    if (options?.snapshot === true) result.snapshot = this.#snapshot(request);
    return result;
  }

  /** What this cache knows about the range, snapped outward (§2.8, N34). */
  snapshot(range: Range): Snapshot {
    return this.#snapshot(snapOut(range, this.config));
  }

  /**
   * Applies a snapshot where nothing is known (§2.8, §4.5, N35): validates
   * it in full first; refuses a differing version; advances the watermark
   * forwards only; then replaces each part of the snapshot's coverage that
   * this cache neither covers nor holds as provisional, and covers it.
   */
  hydrate(snapshot: Snapshot): HydrateResult {
    const valid = validateSnapshot(snapshot, this.config);
    return this.#mutating(() => this.#hydrateValid(valid));
  }

  #hydrateValid(valid: ValidSnapshot): HydrateResult {
    const version = valid.version;
    if (version !== undefined && this.#version !== undefined) {
      if (version !== this.#version) {
        return { applied: [], skipped: "version-mismatch" };
      }
    } else if (version !== undefined) {
      this.#version = version;
      this.#hooks.onChange?.({ kind: "version" });
    }
    const wm = valid.watermark;
    if (wm !== undefined) this.#reportWatermark(this.#advance(wm.t, wm.slot));
    const parts = this.#unknownParts(valid.coverage);
    for (const part of parts) {
      this.#apply(valid, part);
      this.#hooks.onChange?.({ kind: "write", slots: part });
    }
    return { applied: parts.map((part) => toMs(part, this.config)) };
  }

  /**
   * Writes a validated snapshot's points inside `part` as its authority and
   * covers it (§4.5, application steps 3–4). A write that fails withdraws
   * the part's coverage, reports it, and rethrows.
   */
  #apply(valid: ValidSnapshot, part: SlotRange): void {
    const points = collect(valid.segments, part, this.config.fields);
    try {
      this.#store.put(points, part);
    } catch (error) {
      this.#coverage.subtract(part);
      this.#hooks.onChange?.({ kind: "remove", slots: part });
      throw error;
    }
    this.#coverage.add(part);
  }

  #snapshot(request: SlotRange): Snapshot {
    return takeSnapshot(
      {
        config: this.config,
        segments: this.#store.segments,
        coverage: this.#coverage,
        version: this.#version,
        finalizedUntil: this.#finalizedUntil,
      },
      request,
    );
  }

  /**
   * Applies stored (untrusted) records into a cache that knows nothing
   * (§4.10.5): one synchronous call. The implementation is
   * `engine/restore.ts`, installed by the persister (`installRestore`);
   * without it this throws TscacheError.
   */
  restore(stored: StoredRecords): RestoreResult {
    if (restoreImpl === undefined) {
      throw new TscacheError("restore: not installed (engine/restore.ts)");
    }
    return restoreImpl(this, stored);
  }

  /** The parts of `ranges` this cache neither covers nor holds as provisional. */
  #unknownParts(ranges: SlotRange[]): SlotRange[] {
    const parts: SlotRange[] = [];
    for (const range of ranges) {
      for (const gap of this.#coverage.gaps(range)) {
        const part =
          this.#volatileFrom === undefined
            ? gap
            : below(gap, this.#volatileFrom);
        if (part !== undefined) parts.push(part);
      }
    }
    return parts;
  }

  /** The authoritative sub-ranges of `range` in ms, without reading points. */
  coverage(range: Range): Range[] {
    const request = snapOut(range, this.config);
    return this.#coverage.covered(request).map((r) => toMs(r, this.config));
  }

  /** Forgets coverage; the points stay (N16). Snaps outward (N1). */
  invalidate(range: Range): void {
    const slots = snapOut(range, this.config);
    this.#mutating(() => {
      this.#coverage.subtract(slots);
      this.#hooks.onChange?.({ kind: "remove", slots });
    });
  }

  /** Drops segments and coverage; config, version and watermark stay. */
  clear(): void {
    this.#mutating(() => {
      this.#clear();
      this.#hooks.onChange?.({ kind: "clear" });
    });
  }

  #clear(): void {
    this.#store.clear();
    this.#coverage.clear();
  }

  /** Sets the watermark exactly; moving it back makes points provisional again. */
  setFinalizedUntil(t: number): void {
    const slot = slotAtOrAfter(t, this.config);
    this.#mutating(() => this.#reportWatermark(this.#setWatermark(t, slot)));
  }

  /**
   * Writes the batch; if the write fails, withdraws coverage for everything
   * it may have changed (not only what it would have claimed: a half-written
   * provisional stretch must be refetched too), tells the owner about a
   * clear that already happened, and rethrows.
   */
  #writeOrWithdraw(
    points: Columns,
    authority: SlotRange | undefined,
    limit: number | undefined,
    touched: SlotRange | undefined,
    cleared: boolean,
  ): SlotWarning[] {
    try {
      return this.#write(points, authority, limit);
    } catch (error) {
      if (touched !== undefined) {
        this.#coverage.subtract(touched);
        this.#hooks.onChange?.({ kind: "remove", slots: touched });
      }
      // The write failure is the error the caller must see; a listener that
      // throws while being told about the clear cannot replace it.
      if (cleared) {
        try {
          this.#hooks.onVersionClear?.();
        } catch {
          // Reported through the write error; the listener's own error is
          // dropped, as a second failure inside a failure path.
        }
      }
      throw error;
    }
  }

  /**
   * Writes the batch. With an own watermark (`limit`), the replace authority
   * stops below it and the points at or beyond it are merely upserted.
   */
  #write(
    points: Columns,
    authority: SlotRange | undefined,
    limit: number | undefined,
  ): SlotWarning[] {
    if (limit === undefined) return this.#store.put(points, authority);
    const [final, provisional] = splitAt(points, limit);
    const warnings = this.#store.put(
      final,
      authority === undefined ? undefined : below(authority, limit),
    );
    if (provisional.slots.length === 0) return warnings;
    const more = this.#store.put(provisional);
    // The two writes split one batch: a run that reaches the split from both
    // sides is one run of consecutive differing points (§4.3), so rejoin it.
    const last = warnings.at(-1);
    const first = more[0];
    if (
      last !== undefined &&
      first !== undefined &&
      last.range.end === final.slots.at(-1) &&
      first.range.start === provisional.slots[0]
    ) {
      last.range.end = first.range.end;
      const names = new Set([...last.fields, ...first.fields]);
      last.fields = Object.keys(this.config.fields).filter((n) => names.has(n));
      more.shift();
    }
    // Not a spread into push: a warning per point can exceed the argument limit.
    return warnings.concat(more);
  }

  /** Sets the watermark; returns whether it changed and what coverage it withdrew. */
  #setWatermark(t: number, slot: number): Moved {
    let removed: SlotRange | undefined;
    // Nothing was provisional before, or the region grew: forget its coverage.
    if (this.#volatileFrom === undefined || slot < this.#volatileFrom) {
      removed = { start: slot, end: Number.MAX_SAFE_INTEGER };
      this.#coverage.subtract(removed);
    }
    const changed = t !== this.#finalizedUntil;
    this.#finalizedUntil = t;
    this.#volatileFrom = slot;
    return { changed, removed };
  }

  /** Records a claim as authoritative, minus the volatile region. */
  #cover(claim: SlotRange): void {
    const end =
      this.#volatileFrom === undefined
        ? claim.end
        : Math.min(claim.end, this.#volatileFrom - 1);
    if (claim.start <= end) this.#coverage.add({ start: claim.start, end });
  }

  /** A differing version clears the cache; the first one seen is adopted (N18). */
  #applyVersion(version: string | undefined): boolean {
    if (version === undefined || version === this.#version) return false;
    const cleared = this.#version !== undefined;
    if (cleared) {
      this.#clear();
      this.#hooks.onChange?.({ kind: "clear" });
    }
    this.#version = version;
    this.#hooks.onChange?.({ kind: "version" });
    return cleared;
  }

  #validateMeta(meta: PutBatch["meta"]): Meta {
    if (meta === undefined) return {};
    if (typeof meta !== "object" || meta === null) {
      reject(`meta must be an object, got ${show(meta)}`);
    }
    const out: Meta = {};
    if (meta.version !== undefined) out.version = validVersion(meta.version);
    if (meta.finalizedUntil !== undefined) {
      out.finalizedUntil = this.#validWatermark(meta.finalizedUntil);
    }
    return out;
  }

  #validWatermark(t: number): { t: number; slot: number } {
    try {
      return { t, slot: slotAtOrAfter(t, this.config) };
    } catch (error) {
      if (!(error instanceof InvalidRangeError)) throw error;
      return reject(`meta.finalizedUntil: ${error.message}`);
    }
  }

  /** Slot warnings → ms, dropping the volatile region (§2.4). */
  #toWarnings(warnings: SlotWarning[]): MergeWarning[] {
    const out: MergeWarning[] = [];
    const from = this.#volatileFrom;
    for (const { range, fields } of warnings) {
      if (from !== undefined && range.start >= from) continue;
      const end =
        from === undefined ? range.end : Math.min(range.end, from - 1);
      out.push({
        range: toMs({ start: range.start, end }, this.config),
        fields,
      });
    }
    return out;
  }
}
