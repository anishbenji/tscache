/**
 * ms↔slot conversion — the single fencepost site (docs/architecture.md §4.1,
 * N1, N9). Every other module does range math on integer slot indices, so an
 * off-by-one can only be introduced, and only needs to be reviewed, here.
 */

import { InvalidRangeError } from "./errors";
import type { Range } from "./types";

/** A cache's alignment grid; structurally a subset of ResolvedCacheConfig. */
export interface Grid {
  /** Positive safe integer (ms). */
  interval: number;
  /** In [0, interval). */
  alignmentOffset: number;
}

/** Inclusive on both ends; integer slot indices; slots may be negative. */
export interface SlotRange {
  start: number;
  end: number;
}

/**
 * Slot of the grid point at or before `t`: floor((t - offset) / interval).
 *
 * Computed from `t % interval` and comparisons instead of the literal
 * formula, because `t - offset` leaves exact-integer range for timestamps
 * near ±2^53 and a float division could round across a slot boundary.
 */
function floorSlot(t: number, g: Grid): number {
  const r = t % g.interval; // sign of t, |r| < interval
  const q = (t - r) / g.interval; // exact: t - r is a multiple of interval
  if (r >= g.alignmentOffset) return q;
  return r >= g.alignmentOffset - g.interval ? q - 1 : q - 2;
}

/** True when `t` lies exactly on the grid. NaN and ±Infinity are not. */
export function isAligned(t: number, g: Grid): boolean {
  const r = t % g.interval;
  return r === g.alignmentOffset || r === g.alignmentOffset - g.interval;
}

/**
 * Slot of an aligned timestamp. Throws RangeError otherwise: callers
 * validate first (put validation reports PutError 'misaligned').
 */
export function slotOf(t: number, g: Grid): number {
  if (!isAligned(t, g)) {
    throw new RangeError(
      `timestamp ${t} is not on the grid t ≡ ${g.alignmentOffset} (mod ${g.interval})`,
    );
  }
  return floorSlot(t, g);
}

/** Timestamp of a slot. */
export function msOf(slot: number, g: Grid): number {
  return g.alignmentOffset + slot * g.interval;
}

/**
 * Snaps a get/invalidate range outward to the grid: start floors, end ceils,
 * so the result is never narrower than the input (N1). `start === end` is
 * legal: one slot when aligned, the two surrounding slots otherwise.
 */
export function snapOut(r: Range, g: Grid): SlotRange {
  if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) {
    throw new InvalidRangeError(
      `range endpoints must be finite numbers, got [${r.start}, ${r.end}]`,
    );
  }
  if (r.start > r.end) {
    throw new InvalidRangeError(
      `range start ${r.start} is after its end ${r.end}`,
    );
  }
  const end = floorSlot(r.end, g);
  return {
    start: floorSlot(r.start, g),
    end: isAligned(r.end, g) ? end : end + 1,
  };
}

/** Slot range → inclusive ms Range (GetResult.coverage and misses). */
export function toMs(r: SlotRange, g: Grid): Range {
  return { start: msOf(r.start, g), end: msOf(r.end, g) };
}
