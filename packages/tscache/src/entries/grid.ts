// './grid' entry — grid arithmetic for the page (docs/architecture.md §2.10,
// N116). Its graph is grid.ts and errors.ts only: no client, no engine.

/**
 * Grid arithmetic for the page, for fixed and calendar intervals alike:
 * where a range lands when a cache reads it, and where a slot starts and
 * ends. Built from the module the engine itself converts with, so a view
 * and its cache agree at every edge.
 *
 * @module @anishbenji/tscache/grid
 */

import {
  floorSlot,
  type Grid,
  gridOf,
  resolveGridFields,
  snapOut,
  startOf,
  toMs,
} from "../grid";
import type { CalendarInterval, Range } from "../types";

export type { CalendarInterval, Range } from "../types";

/** The grid of a config's `interval` and `alignmentOffset`; ConfigError when invalid. */
function gridFor(
  interval: number | CalendarInterval,
  alignmentOffset: number | undefined,
): Grid {
  return gridOf(resolveGridFields(interval, alignmentOffset));
}

/**
 * The range a cache reads for `range`: snapped outward to the grid, as
 * `get`, `invalidate` and `coverage` snap it (N1). Use it to decide whether
 * a `cacheChanged` range touches a view. Throws `InvalidRangeError` for a
 * range the cache itself would reject, and `ConfigError` for an invalid
 * interval.
 *
 * @example
 * // A New York session view: the range the cache answers for it.
 * const shown = snapRange(
 *   { start: Date.UTC(2026, 2, 6), end: Date.UTC(2026, 2, 10) },
 *   { unit: "day", zone: "America/New_York", at: "09:30" },
 * );
 */
export function snapRange(
  range: Range,
  interval: number | CalendarInterval,
  alignmentOffset?: number,
): Range {
  const grid = gridFor(interval, alignmentOffset);
  return toMs(snapOut(range, grid), grid);
}

/**
 * The start of the slot that contains `t`: the grid point at or before it.
 * With `Date.now()` it is the start of the forming bar. Throws
 * `InvalidRangeError` for a `t` outside a calendar's domain.
 */
export function slotStart(
  t: number,
  interval: number | CalendarInterval,
  alignmentOffset?: number,
): number {
  const grid = gridFor(interval, alignmentOffset);
  return startOf(floorSlot(t, grid), grid);
}

/**
 * The start of the slot after the one that contains `t`: the first grid
 * point after `t`. `nextSlotStart(t) - slotStart(t)` is the length of the
 * slot, which on a calendar grid differs from slot to slot.
 */
export function nextSlotStart(
  t: number,
  interval: number | CalendarInterval,
  alignmentOffset?: number,
): number {
  const grid = gridFor(interval, alignmentOffset);
  return startOf(floorSlot(t, grid) + 1, grid);
}
