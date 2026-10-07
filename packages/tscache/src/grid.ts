/**
 * ms↔slot conversion — the single fencepost site (docs/architecture.md §4.1,
 * N1, N9). Every other module does range math on integer slot indices, so an
 * off-by-one can only be introduced, and only needs to be reviewed, here.
 */

import { InvalidRangeError, show } from "./errors";
import type { Range } from "./types";

/** A cache's alignment grid; structurally a subset of ResolvedCacheConfig. */
export interface Grid {
  /** Positive safe integer (ms). */
  interval: number;
  /** In [0, interval). */
  alignmentOffset: number;
}

/** Inclusive on both ends; safe-integer slot indices; slots may be negative. */
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

/**
 * True when `t` is a safe integer lying exactly on the grid. Anything
 * outside the supported domain (fractions, NaN, |t| >= 2^53) is not.
 */
export function isAligned(t: number, g: Grid): boolean {
  if (!Number.isSafeInteger(t)) return false;
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

/**
 * Timestamp of a slot: alignmentOffset + slot * interval.
 *
 * For a negative slot the product alone can pass -2^53 before the positive
 * offset brings the sum back, so it is regrouped as
 * (slot + 1) * interval + (alignmentOffset - interval): both terms then
 * share the result's sign and neither exceeds it in magnitude.
 */
export function msOf(slot: number, g: Grid): number {
  if (slot >= 0) return g.alignmentOffset + slot * g.interval;
  return (slot + 1) * g.interval + (g.alignmentOffset - g.interval);
}

/** Rejects a range that is not two ordered finite numbers within ±(2^53 − 1). */
function assertRange(r: Range): void {
  // Untyped callers (plain JS, RPC params) can pass anything. isFinite does
  // not coerce, so "10", null and booleans are rejected, not read as numbers.
  const supported = (t: unknown) =>
    Number.isFinite(t) && Math.abs(t as number) <= Number.MAX_SAFE_INTEGER;
  if (typeof r !== "object" || r === null) {
    throw new InvalidRangeError(`range must be an object, got ${show(r)}`);
  }
  if (!supported(r.start) || !supported(r.end)) {
    throw new InvalidRangeError(
      `range endpoints must be finite numbers within ±(2^53 - 1), got [${show(r.start)}, ${show(r.end)}]`,
    );
  }
  if (r.start > r.end) {
    throw new InvalidRangeError(
      `range start ${r.start} is after its end ${r.end}`,
    );
  }
}

/**
 * Snaps a get/invalidate range outward to the grid: start floors, end ceils,
 * so the result is never narrower than the input (N1). `start === end` is
 * legal: one slot when aligned, the two surrounding slots otherwise.
 */
export function snapOut(r: Range, g: Grid): SlotRange {
  assertRange(r);
  const floorEnd = floorSlot(r.end, g);
  const slots = {
    start: floorSlot(r.start, g),
    end: isAligned(r.end, g) ? floorEnd : floorEnd + 1,
  };
  // Snapping outward can step past the last grid point that is a safe
  // integer; such a slot has no exact timestamp to report back.
  if (
    !Number.isSafeInteger(msOf(slots.start, g)) ||
    !Number.isSafeInteger(msOf(slots.end, g))
  ) {
    throw new InvalidRangeError(
      `range [${r.start}, ${r.end}] snaps to grid points beyond ±(2^53 - 1)`,
    );
  }
  return slots;
}

/**
 * Snaps a put's authority range inward: the grid points lying inside it, or
 * undefined when there is none (N13). Never wider than the input, so a put
 * cannot claim a slot its caller did not name, and every slot returned has a
 * safe-integer timestamp.
 */
export function snapIn(r: Range, g: Grid): SlotRange | undefined {
  assertRange(r);
  const floorStart = floorSlot(r.start, g);
  const start = isAligned(r.start, g) ? floorStart : floorStart + 1;
  const end = floorSlot(r.end, g);
  return start > end ? undefined : { start, end };
}

/** Rejects a timestamp that is not a finite number within ±(2^53 − 1). */
function assertTimestamp(t: number, what: string): void {
  if (!Number.isFinite(t) || Math.abs(t) > Number.MAX_SAFE_INTEGER) {
    throw new InvalidRangeError(
      `${what} must be a finite number within ±(2^53 - 1), got ${show(t)}`,
    );
  }
}

/**
 * First slot whose timestamp is at or after `t`: the watermark's slot, since
 * points at t >= finalizedUntil are provisional (§2.4). Throws
 * InvalidRangeError for an unsupported `t`, or when that slot's timestamp
 * would not be a safe integer.
 */
export function slotAtOrAfter(t: number, g: Grid): number {
  assertTimestamp(t, "timestamp");
  const floor = floorSlot(t, g);
  const slot = isAligned(t, g) ? floor : floor + 1;
  if (!Number.isSafeInteger(msOf(slot, g))) {
    throw new InvalidRangeError(
      `the grid point at or after ${t} lies beyond ±(2^53 - 1)`,
    );
  }
  return slot;
}

/** Slot range → inclusive ms Range (GetResult.coverage and misses). */
export function toMs(r: SlotRange, g: Grid): Range {
  return { start: msOf(r.start, g), end: msOf(r.end, g) };
}
