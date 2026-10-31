/**
 * Persisted records (docs/architecture.md §4.10.2, N51, N53, N55): one cache
 * record per persisted cache and one page record per page that holds
 * coverage, built from memory alone. `recordsOf(S)`, the cache record and
 * the page records together, is what a flush writes and, with a single
 * writer, what the disk holds after it.
 */

import type { CacheState } from "../engine/cache";
import { pageOf, pageRange } from "../engine/merge";
import type { SlotRange } from "../grid";
import type { Dtype, Snapshot } from "../types";
import type { PageRange } from "./store";

/** Store 'caches': one per persisted cache. */
export interface CacheRecord {
  cacheId: string;
  /** Schema version of the persisted records. */
  format: 1;
  /** The structural config (N20) the records were written under. */
  config: {
    interval: number;
    alignmentOffset: number;
    fields: Record<string, Dtype>;
    gapSplitK: number;
    segmentSlotCap: number;
    warnOnOverlapDiff: boolean;
  };
  /** The dataset version and the watermark when written; each omitted when unset. */
  version?: string;
  finalizedUntil?: number;
}

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
  if (state.coveredSlots().length === 0) return undefined;
  const c = state.config;
  const record: CacheRecord = {
    cacheId: c.id,
    format: 1,
    config: {
      interval: c.interval,
      alignmentOffset: c.alignmentOffset,
      fields: { ...c.fields },
      gapSplitK: c.gapSplitK,
      segmentSlotCap: c.segmentSlotCap,
      warnOnOverlapDiff: c.warnOnOverlapDiff,
    },
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
  const covered = state.coveredSlots();
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
 * points inside that coverage.
 */
function pageRecordOf(
  state: CacheState,
  page: number,
  parts: SlotRange[],
): PageRecord {
  const first = parts[0] as SlotRange;
  const last = parts.at(-1) as SlotRange;
  const hull = { start: first.start, end: last.end };
  return {
    cacheId: state.config.id,
    page,
    snapshot: state.pageSnapshot(hull, parts),
  };
}
