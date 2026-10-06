/**
 * Read path (docs/architecture.md §4.4): present points across segments,
 * coverage intersection and 'uncached' misses. Input is in slot terms; the
 * result is the consumer's GetResult, so this is where slots become
 * milliseconds again, through grid.ts.
 */

import type { CoverageIndex } from "../coverage";
import { type Grid, msOf, type SlotRange, toMs } from "../grid";
import { assertSlotRange } from "../segment/assert";
import { FIELD_ARRAYS } from "../segment/dtype";
import { getOwn, setOwn } from "../segment/own";
import type { Columns, Segment } from "../segment/types";
import type { Dtype, FieldArray, GetResult } from "../types";

type Schema = Readonly<Record<string, Dtype>>;

/** Index of the first segment ending at or after `slot`. */
function firstEndingFrom(segments: readonly Segment[], slot: number): number {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const extent = (segments[mid] as Segment).extent as SlotRange;
    if (extent.end < slot) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Slices of every segment that overlaps `range`, ascending. */
function slicesIn(segments: readonly Segment[], range: SlotRange): Columns[] {
  const parts: Columns[] = [];
  for (
    let i = firstEndingFrom(segments, range.start);
    i < segments.length;
    i++
  ) {
    const segment = segments[i] as Segment;
    const extent = segment.extent as SlotRange;
    if (extent.start > range.end) break;
    parts.push(
      segment.slice({
        start: Math.max(range.start, extent.start),
        end: Math.min(range.end, extent.end),
      }),
    );
  }
  return parts;
}

/**
 * The present points of `segments` (ascending, disjoint) inside `range`,
 * concatenated ascending, as fresh arrays: one per schema field, of that
 * field's dtype. Throws RangeError for a malformed range.
 */
export function collect(
  segments: readonly Segment[],
  range: SlotRange,
  fields: Schema,
): Columns {
  assertSlotRange(range, "range");
  const parts = slicesIn(segments, range);
  let total = 0;
  for (const part of parts) total += part.slots.length;
  const slots = new Float64Array(total);
  const out: Record<string, FieldArray> = {};
  for (const name of Object.keys(fields)) {
    setOwn(out, name, new FIELD_ARRAYS[fields[name] as Dtype](total));
  }
  let at = 0;
  for (const part of parts) {
    slots.set(part.slots, at);
    for (const name of Object.keys(fields)) {
      (getOwn(out, name) as FieldArray).set(
        getOwn(part.fields, name) as FieldArray,
        at,
      );
    }
    at += part.slots.length;
  }
  return { slots, fields: out };
}

/**
 * Assembles a GetResult for a request already snapped to slots: every
 * present point in the request (N16), the covered sub-ranges, and the
 * uncovered ones as 'uncached' misses; the two tile the request exactly.
 */
export function read(
  request: SlotRange,
  segments: readonly Segment[],
  coverage: CoverageIndex,
  grid: Grid,
  fields: Schema,
): GetResult {
  const columns = collect(segments, request, fields);
  // The slots array is fresh, so it becomes the timestamps array in place.
  const timestamps = columns.slots;
  for (let i = 0; i < timestamps.length; i++) {
    timestamps[i] = msOf(timestamps[i] as number, grid);
  }
  return {
    timestamps,
    fields: columns.fields,
    coverage: coverage.covered(request).map((r) => toMs(r, grid)),
    misses: coverage
      .gaps(request)
      .map((r) => ({ range: toMs(r, grid), reason: "uncached" as const })),
  };
}
