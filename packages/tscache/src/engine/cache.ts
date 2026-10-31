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
import { pageOf, SegmentStore } from "./merge";
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
function below(range: SlotRange, limit: number): SlotRange | undefined {
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

/** The structural config fields a cache record names (§4.10.2). */
const RECORD_CONFIG = [
  "interval",
  "alignmentOffset",
  "gapSplitK",
  "segmentSlotCap",
  "warnOnOverlapDiff",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a stored `fields` names exactly the schema's fields and dtypes. */
function sameSchema(
  value: unknown,
  schema: Readonly<Record<string, string>>,
): boolean {
  if (!isRecord(value)) return false;
  const names = Object.keys(schema);
  return (
    Object.keys(value).length === names.length &&
    names.every(
      (name) => Object.hasOwn(value, name) && value[name] === schema[name],
    )
  );
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
    try {
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
      if (moved !== undefined) this.#reportWatermark(moved);
      if (claim !== undefined) this.#cover(claim);
      if (cleared) this.#hooks.onVersionClear?.();
      return { warnings: this.#toWarnings(slotWarnings), cleared };
    } finally {
      this.#hooks.onMutate?.();
    }
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
  #reportWatermark(moved: Moved): void {
    if (moved.changed) this.#hooks.onChange?.({ kind: "watermark" });
    if (moved.removed !== undefined) {
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
    try {
      if (
        valid.version !== undefined &&
        this.#version !== undefined &&
        valid.version !== this.#version
      ) {
        return { applied: [], skipped: "version-mismatch" };
      }
      if (valid.version !== undefined && this.#version === undefined) {
        this.#version = valid.version;
        this.#hooks.onChange?.({ kind: "version" });
      }
      if (valid.watermark !== undefined) {
        const moved = this.#advance(valid.watermark.t, valid.watermark.slot);
        if (moved !== undefined) this.#reportWatermark(moved);
      }
      const parts = this.#unknownParts(valid.coverage);
      for (const part of parts) {
        this.#apply(valid, part);
        this.#hooks.onChange?.({ kind: "write", slots: part });
      }
      return { applied: parts.map((part) => toMs(part, this.config)) };
    } finally {
      this.#hooks.onMutate?.();
    }
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
   * (§4.10.5): one synchronous call. The cache record must name this
   * cache's structure and a dataset version it accepts (N56); its watermark
   * advances this one forwards only. Each valid page's coverage, minus the
   * volatile region, is written with the page's points as authority and
   * covered, as `hydrate` applies a part; an invalid page is skipped.
   * Reports only a `watermark` change, when the watermark after it differs
   * from the record's; never `onMutate`. Throws TscacheError, before
   * anything changes, when the cache covers a slot or holds a point.
   */
  restore(stored: {
    cache: unknown;
    pages: readonly unknown[];
  }): RestoreResult {
    if (this.#coverage.ranges().length > 0 || this.#store.segments.length > 0) {
      throw new TscacheError(
        `restore: cache "${this.config.id}" already holds data; records apply only into a cache that knows nothing`,
      );
    }
    const { cache, pages } = stored;
    if (cache === undefined) return { applied: [], rewrite: pages.length > 0 };
    const record = this.#acceptRecord(cache);
    if (record === undefined) return { applied: [], rewrite: true };
    if (this.#version !== undefined && record.version !== this.#version) {
      return { applied: [], rewrite: true };
    }
    this.#version ??= record.version;
    const wm = record.watermark;
    // The cache covers nothing, so an advance withdraws nothing.
    if (wm !== undefined) this.#advance(wm.t, wm.slot);
    if (this.#finalizedUntil !== wm?.t) {
      this.#hooks.onChange?.({ kind: "watermark" });
    }
    const parts: SlotRange[] = [];
    let rewrite = false;
    let last: number | undefined;
    for (const page of pages) {
      const valid = this.#acceptPage(page, record.version, last);
      if (valid === undefined) {
        rewrite = true;
        continue;
      }
      last = valid.page;
      if (!this.#restorePage(valid.snapshot, parts)) rewrite = true;
    }
    // A cache record whose pages cover nothing is not what a flush writes.
    if (parts.length === 0) rewrite = true;
    return { applied: this.#merged(parts), rewrite };
  }

  /** The cache record's version and watermark, or undefined when it fails a check (§4.10.5 step 2). */
  #acceptRecord(
    record: unknown,
  ):
    | { version: string | undefined; watermark: Meta["finalizedUntil"] }
    | undefined {
    if (
      !isRecord(record) ||
      record.cacheId !== this.config.id ||
      record.format !== 1
    ) {
      return undefined;
    }
    const config = record.config;
    if (
      !isRecord(config) ||
      Object.keys(config).length !== RECORD_CONFIG.length + 1 ||
      !RECORD_CONFIG.every((field) => config[field] === this.config[field]) ||
      !sameSchema(config.fields, this.config.fields)
    ) {
      return undefined;
    }
    const { version, finalizedUntil } = record;
    if (
      version !== undefined &&
      (typeof version !== "string" || version.length === 0)
    ) {
      return undefined;
    }
    if (finalizedUntil === undefined) return { version, watermark: undefined };
    if (typeof finalizedUntil !== "number") return undefined;
    try {
      const slot = slotAtOrAfter(finalizedUntil, this.config);
      return { version, watermark: { t: finalizedUntil, slot } };
    } catch (error) {
      if (!(error instanceof InvalidRangeError)) throw error;
      return undefined;
    }
  }

  /**
   * A page record that passes every check of §4.10.5 step 5, or undefined.
   * Pages must ascend, each once, after `after`.
   */
  #acceptPage(
    page: unknown,
    version: string | undefined,
    after: number | undefined,
  ): { page: number; snapshot: ValidSnapshot } | undefined {
    if (
      !isRecord(page) ||
      page.cacheId !== this.config.id ||
      typeof page.page !== "number" ||
      !Number.isSafeInteger(page.page) ||
      (after !== undefined && page.page <= after)
    ) {
      return undefined;
    }
    let snapshot: ValidSnapshot;
    try {
      snapshot = validateSnapshot(page.snapshot, this.config);
    } catch {
      // Untrusted bytes: whatever fails to decode is a page to skip.
      return undefined;
    }
    const cap = this.config.segmentSlotCap;
    if (
      snapshot.watermark !== undefined ||
      snapshot.version !== version ||
      pageOf(snapshot.range.start, cap) !== page.page ||
      pageOf(snapshot.range.end, cap) !== page.page
    ) {
      return undefined;
    }
    return { page: page.page, snapshot };
  }

  /**
   * Writes and covers a valid page's coverage below the volatile region
   * (§4.10.5 step 6) and appends the parts. Returns whether the page was
   * applied in full and is what a flush would write: no part clipped, no
   * point left outside every part, its range the hull of its coverage.
   */
  #restorePage(valid: ValidSnapshot, parts: SlotRange[]): boolean {
    const { coverage, range, segments } = valid;
    let canonical =
      coverage[0]?.start === range.start && coverage.at(-1)?.end === range.end;
    let present = 0;
    for (const segment of segments) present += segment.size;
    let written = 0;
    for (const covered of coverage) {
      const part =
        this.#volatileFrom === undefined
          ? covered
          : below(covered, this.#volatileFrom);
      if (part?.end !== covered.end) canonical = false;
      if (part === undefined) continue;
      const points = collect(segments, part, this.config.fields);
      try {
        this.#store.put(points, part);
      } catch (error) {
        this.#coverage.subtract(part);
        throw error;
      }
      this.#coverage.add(part);
      written += points.slots.length;
      parts.push(part);
    }
    return canonical && written === present;
  }

  /** Slot parts in ascending order → ms ranges, adjacent ones merged. */
  #merged(parts: readonly SlotRange[]): Range[] {
    const out: SlotRange[] = [];
    for (const part of parts) {
      const last = out.at(-1);
      if (last !== undefined && last.end + 1 === part.start)
        last.end = part.end;
      else out.push({ ...part });
    }
    return out.map((part) => toMs(part, this.config));
  }

  /** The covered slot ranges, ascending (for the persisted records, §4.10.2). */
  coveredSlots(): SlotRange[] {
    return this.#coverage.ranges();
  }

  /**
   * A snapshot of `request` (slots) without the watermark, whose segments
   * hold only the present points inside `parts`: a persisted page's
   * snapshot (§4.10.2).
   */
  pageSnapshot(request: SlotRange, parts: readonly SlotRange[]): Snapshot {
    return takeSnapshot(
      {
        config: this.config,
        segments: this.#store.segments,
        coverage: this.#coverage,
        version: this.#version,
        finalizedUntil: undefined,
      },
      request,
      parts,
    );
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
    try {
      this.#coverage.subtract(slots);
      this.#hooks.onChange?.({ kind: "remove", slots });
    } finally {
      this.#hooks.onMutate?.();
    }
  }

  /** Drops segments and coverage; config, version and watermark stay. */
  clear(): void {
    try {
      this.#clear();
      this.#hooks.onChange?.({ kind: "clear" });
    } finally {
      this.#hooks.onMutate?.();
    }
  }

  #clear(): void {
    this.#store.clear();
    this.#coverage.clear();
  }

  /** Sets the watermark exactly; moving it back makes points provisional again. */
  setFinalizedUntil(t: number): void {
    const slot = slotAtOrAfter(t, this.config);
    try {
      this.#reportWatermark(this.#setWatermark(t, slot));
    } finally {
      this.#hooks.onMutate?.();
    }
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
