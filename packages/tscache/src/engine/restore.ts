/**
 * `CacheState.restore` (docs/architecture.md §4.10.5; N55, N56, N57):
 * applies stored, untrusted records into a cache that knows nothing, in one
 * synchronous call. It lives apart from `cache.ts` so that only the
 * persister, which loads lazily (§4.10.8), carries it: the persister
 * installs it with `installRestore`, and it reaches the cache through
 * `cacheInternals`.
 */

import { InvalidRangeError, TscacheError } from "../errors";
import { type SlotRange, slotAtOrAfter, toMs } from "../grid";
import type { Range } from "../types";
import {
  below,
  type CacheInternals,
  type CacheState,
  cacheInternals,
  type RestoreResult,
  type StoredRecords,
} from "./cache";
import { pageOf } from "./merge";
import { collect } from "./read";
import { type ValidSnapshot, validateSnapshot } from "./snapshot";

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

/** A watermark with its slot. */
type Watermark = { t: number; slot: number };

/** A stored cache record's version and watermark, once checked. */
interface StoredMeta {
  version: string | undefined;
  watermark: Watermark | undefined;
}

/** Absent, or a non-empty string. */
function isStoredVersion(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

/** A safe-integer page number after `after`: pages ascend, each once. */
function isPageAfter(
  value: unknown,
  after: number | undefined,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    (after === undefined || value > after)
  );
}

/** Whether a page snapshot's range is the hull of its coverage (§4.10.2). */
function isHull({ coverage, range }: ValidSnapshot): boolean {
  return (
    coverage[0]?.start === range.start && coverage.at(-1)?.end === range.end
  );
}

/** The present points a validated snapshot carries. */
function pointsIn({ segments }: ValidSnapshot): number {
  let n = 0;
  for (const segment of segments) n += segment.size;
  return n;
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

/**
 * Applies stored (untrusted) records into a cache that knows nothing
 * (§4.10.5): one synchronous call. The cache record must name this cache's
 * structure and a dataset version it accepts (N56); its watermark advances
 * this one forwards only. Each valid page's coverage, minus the volatile
 * region, is written with the page's points as authority and covered, as
 * `hydrate` applies a part; an invalid page is skipped. Reports only a
 * `watermark` change, when the watermark after it differs from the
 * record's; never `onMutate`. Throws TscacheError, before anything changes,
 * when the cache covers a slot or holds a point.
 */
export function restore(
  state: CacheState,
  stored: StoredRecords,
): RestoreResult {
  const inner = cacheInternals(state);
  if (inner.coverage.ranges().length > 0 || inner.store.segments.length > 0) {
    throw new TscacheError(
      `restore: cache "${state.config.id}" already holds data; records apply only into a cache that knows nothing`,
    );
  }
  const { cache, pages } = stored;
  const record = cache === undefined ? undefined : acceptRecord(state, cache);
  // Absent with pages (orphans), invalid, or of another version (N56).
  if (
    record === undefined ||
    (state.version !== undefined && record.version !== state.version)
  ) {
    return { applied: [], rewrite: cache !== undefined || pages.length > 0 };
  }
  if (state.version === undefined && record.version !== undefined) {
    inner.adoptVersion(record.version);
  }
  restoreWatermark(state, inner, record.watermark);
  return restorePages(state, inner, pages, record.version);
}

/**
 * The record's watermark advances the cache's forwards only (N17); the
 * cache covers nothing, so nothing is withdrawn. A `watermark` change is
 * reported when the watermark now differs from the record's.
 */
function restoreWatermark(
  state: CacheState,
  inner: CacheInternals,
  wm: Watermark | undefined,
): void {
  if (wm !== undefined) inner.advance(wm.t, wm.slot);
  if (state.finalizedUntil !== wm?.t) inner.report({ kind: "watermark" });
}

/** Applies every valid page, ascending (§4.10.5 steps 5–7). */
function restorePages(
  state: CacheState,
  inner: CacheInternals,
  pages: readonly unknown[],
  version: string | undefined,
): RestoreResult {
  const parts: SlotRange[] = [];
  let rewrite = false;
  let last: number | undefined;
  for (const page of pages) {
    const valid = acceptPage(state, page, version, last);
    if (valid === undefined) {
      rewrite = true;
      continue;
    }
    last = valid.page;
    if (!restorePage(state, inner, valid.snapshot, parts)) rewrite = true;
  }
  // A cache record whose pages cover nothing is not what a flush writes.
  return {
    applied: merged(state, parts),
    rewrite: rewrite || parts.length === 0,
  };
}

/** The cache record's version and watermark, or undefined when it fails a check (§4.10.5 step 2). */
function acceptRecord(
  state: CacheState,
  record: unknown,
): StoredMeta | undefined {
  if (
    !isRecord(record) ||
    record.cacheId !== state.config.id ||
    record.format !== 1 ||
    !sameStructure(state, record.config)
  ) {
    return undefined;
  }
  const { version, finalizedUntil } = record;
  if (!isStoredVersion(version)) return undefined;
  if (finalizedUntil === undefined) return { version, watermark: undefined };
  const watermark = storedWatermark(state, finalizedUntil);
  return watermark === undefined ? undefined : { version, watermark };
}

/** Whether a stored config names exactly this cache's structural fields (N20). */
function sameStructure(state: CacheState, config: unknown): boolean {
  return (
    isRecord(config) &&
    Object.keys(config).length === RECORD_CONFIG.length + 1 &&
    RECORD_CONFIG.every((field) => config[field] === state.config[field]) &&
    sameSchema(config.fields, state.config.fields)
  );
}

/** A stored watermark `slotAtOrAfter` accepts, with its slot; undefined otherwise. */
function storedWatermark(state: CacheState, t: unknown): Watermark | undefined {
  if (typeof t !== "number") return undefined;
  try {
    return { t, slot: slotAtOrAfter(t, state.config) };
  } catch (error) {
    if (!(error instanceof InvalidRangeError)) throw error;
    return undefined;
  }
}

/**
 * A page record that passes every check of §4.10.5 step 5, or undefined.
 * Pages must ascend, each once, after `after`.
 */
function acceptPage(
  state: CacheState,
  page: unknown,
  version: string | undefined,
  after: number | undefined,
): { page: number; snapshot: ValidSnapshot } | undefined {
  if (
    !isRecord(page) ||
    page.cacheId !== state.config.id ||
    !isPageAfter(page.page, after)
  ) {
    return undefined;
  }
  const snapshot = pageSnapshotOf(state, page.snapshot, page.page, version);
  return snapshot === undefined ? undefined : { page: page.page, snapshot };
}

/**
 * A page's snapshot when it passes `hydrate`'s validation, lies in page
 * `page`, names `version` and carries no watermark; undefined otherwise.
 */
function pageSnapshotOf(
  state: CacheState,
  input: unknown,
  page: number,
  version: string | undefined,
): ValidSnapshot | undefined {
  let snapshot: ValidSnapshot;
  try {
    snapshot = validateSnapshot(input, state.config);
  } catch {
    // Untrusted bytes: whatever fails to decode is a page to skip.
    return undefined;
  }
  const cap = state.config.segmentSlotCap;
  const fits =
    snapshot.watermark === undefined &&
    snapshot.version === version &&
    pageOf(snapshot.range.start, cap) === page &&
    pageOf(snapshot.range.end, cap) === page;
  return fits ? snapshot : undefined;
}

/**
 * Writes and covers a valid page's coverage below the volatile region
 * (§4.10.5 step 6) and appends the parts. Returns whether the page was
 * applied in full and is what a flush would write: no part clipped, no
 * point left outside every part, its range the hull of its coverage.
 */
function restorePage(
  state: CacheState,
  inner: CacheInternals,
  valid: ValidSnapshot,
  parts: SlotRange[],
): boolean {
  let whole = isHull(valid);
  let written = 0;
  for (const covered of valid.coverage) {
    const from = inner.volatileFrom;
    const part = from === undefined ? covered : below(covered, from);
    if (part?.end !== covered.end) whole = false;
    if (part === undefined) continue;
    written += restorePart(state, inner, valid, part);
    parts.push(part);
  }
  return whole && written === pointsIn(valid);
}

/** Writes a part with the page's points inside it as authority, and covers it; returns how many. */
function restorePart(
  state: CacheState,
  inner: CacheInternals,
  valid: ValidSnapshot,
  part: SlotRange,
): number {
  const points = collect(valid.segments, part, state.config.fields);
  try {
    inner.store.put(points, part);
  } catch (error) {
    inner.coverage.subtract(part);
    throw error;
  }
  inner.coverage.add(part);
  return points.slots.length;
}

/** Slot parts in ascending order → ms ranges, adjacent ones merged. */
function merged(state: CacheState, parts: readonly SlotRange[]): Range[] {
  const out: SlotRange[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (last !== undefined && last.end + 1 === part.start) last.end = part.end;
    else out.push({ ...part });
  }
  return out.map((part) => toMs(part, state.config));
}
