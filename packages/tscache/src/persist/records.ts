/**
 * Persisted records (docs/architecture.md §4.10.2, N51, N53, N55): one cache
 * record per persisted cache and one page record per page that holds
 * coverage, built from memory alone. `recordsOf(S)`, the cache record and
 * the page records together, is what a flush writes and, with a single
 * writer, what the disk holds after it.
 */

import { type CacheState, cacheInternals } from "../engine/cache";
import { pageOf, pageRange } from "../engine/merge";
import { takeSnapshot } from "../engine/snapshot";
import type { SlotRange } from "../grid";
import type { Dtype, ResolvedCalendarInterval, Snapshot } from "../types";
import type { PageRange } from "./store";

/** The structural config fields (N20) both record formats name. */
interface RecordStructure {
  fields: Record<string, Dtype>;
  gapSplitK: number;
  segmentSlotCap: number;
  warnOnOverlapDiff: boolean;
}

/** What both record formats share. */
interface CacheRecordBase {
  cacheId: string;
  /** The dataset version and the watermark when written; each omitted when unset. */
  version?: string;
  finalizedUntil?: number;
}

/** The cache record of a cache on a fixed grid. */
interface FixedCacheRecord extends CacheRecordBase {
  /** Schema version of the persisted records. */
  format: 1;
  /** The structural config (N20) the records were written under. */
  config: RecordStructure & { interval: number; alignmentOffset: number };
}

/**
 * The cache record of a cache on a calendar grid (N114): `grid`, the
 * resolved calendar interval, in place of `interval` and `alignmentOffset`.
 * Its only instant, the watermark, names no slot, so it stores no slot
 * index.
 */
interface CalendarCacheRecord extends CacheRecordBase {
  /** Schema version of the persisted records. */
  format: 2;
  /** The structural config (N20) the records were written under. */
  config: RecordStructure & { grid: ResolvedCalendarInterval };
}

/** Store 'caches': one per persisted cache, in the format of its grid. */
export type CacheRecord = FixedCacheRecord | CalendarCacheRecord;

/** Store 'pages': one per page that holds coverage. */
export interface PageRecord {
  cacheId: string;
  /** floor(slot / segmentSlotCap) of every slot of `snapshot` (N15); may be negative. */
  page: number;
  /** The page's covered slots and the points inside them (§2.8). */
  snapshot: Snapshot;
}

/**
 * The cache record of `recordsOf(S)` (§4.10.2): undefined when the state
 * covers nothing, so a cleared cache leaves nothing on disk.
 */
export function cacheRecordOf(state: CacheState): CacheRecord | undefined {
  if (cacheInternals(state).coverage.ranges().length === 0) return undefined;
  const c = state.config;
  const structure = {
    fields: { ...c.fields },
    gapSplitK: c.gapSplitK,
    segmentSlotCap: c.segmentSlotCap,
    warnOnOverlapDiff: c.warnOnOverlapDiff,
  };
  const record: CacheRecord =
    typeof c.interval === "number"
      ? {
          cacheId: c.id,
          format: 1,
          config: {
            interval: c.interval,
            alignmentOffset: c.alignmentOffset,
            ...structure,
          },
        }
      : {
          cacheId: c.id,
          format: 2,
          config: { grid: { ...c.interval }, ...structure },
        };
  if (state.version !== undefined) record.version = state.version;
  if (state.finalizedUntil !== undefined) {
    record.finalizedUntil = state.finalizedUntil;
  }
  return record;
}

/** The first page at or after `page` inside `within`, or undefined. */
function nextWithin(
  page: number,
  within: readonly PageRange[] | undefined,
): number | undefined {
  if (within === undefined) return page;
  for (const r of within) {
    if (r.end >= page) return Math.max(r.start, page);
  }
  return undefined;
}

/**
 * The page records of `recordsOf(S)` (§4.10.2), ascending: one for every
 * page holding coverage, or for those pages inside `within` (merged,
 * ascending ranges).
 */
export function pageRecordsOf(
  state: CacheState,
  within?: readonly PageRange[],
): PageRecord[] {
  const covered = cacheInternals(state).coverage.ranges();
  const cap = state.config.segmentSlotCap;
  const out: PageRecord[] = [];
  let page: number | undefined;
  let parts: SlotRange[] = [];
  const emit = (): void => {
    if (page !== undefined && parts.length > 0) {
      out.push(pageRecordOf(state, page, parts));
    }
  };
  for (const range of covered) {
    let start = range.start;
    while (start <= range.end) {
      const at = pageOf(start, cap);
      const wanted = nextWithin(at, within);
      if (wanted === undefined) break;
      if (wanted !== at) {
        // Skip the pages outside `within`; a covered range may span many.
        start = Math.max(start, pageRange(wanted, cap).start);
        continue;
      }
      const end = Math.min(range.end, pageRange(at, cap).end);
      if (at !== page) {
        emit();
        page = at;
        parts = [];
      }
      parts.push({ start, end });
      start = end + 1;
    }
  }
  emit();
  return out;
}

/**
 * The page snapshot (§4.10.2): the envelope of the hull of the page's
 * coverage, without a watermark, whose segments hold exactly the present
 * points inside that coverage (one payload per segment per part).
 */
function pageRecordOf(
  state: CacheState,
  page: number,
  parts: SlotRange[],
): PageRecord {
  const first = parts[0] as SlotRange;
  const last = parts.at(-1) as SlotRange;
  const hull = { start: first.start, end: last.end };
  const { store, coverage } = cacheInternals(state);
  const snapshot = takeSnapshot(
    {
      config: state.config,
      grid: state.grid,
      segments: store.segments,
      coverage,
      version: state.version,
      finalizedUntil: undefined,
    },
    hull,
    parts,
  );
  return { cacheId: state.config.id, page, snapshot };
}
