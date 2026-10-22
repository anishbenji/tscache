// What the charts draw for a range: every slot inside it, with null where
// the sensor sent no reading. An empty slot inside coverage is a confirmed
// gap; one outside coverage is not loaded, and nothing is known about it.

import type { GetResult, Miss, Range } from "tscache";

export interface Frame {
  /** The range the charts show. */
  range: Range;
  /** Slot width in ms. */
  interval: number;
  /** Every aligned slot inside the range, ascending. */
  slots: number[];
  /** Field name → the value at each slot, or null where it holds no point. */
  values: Record<string, (number | null)[]>;
  /** Slots holding a point. */
  points: number;
  /** Runs of empty slots inside coverage: the sensor sent nothing there. */
  gaps: Range[];
  /** Runs of slots outside coverage: not loaded. */
  unloaded: Range[];
  misses: Miss[];
}

type Slot = "point" | "gap" | "unloaded";

function alignedSlots(range: Range, interval: number): number[] {
  const first = Math.ceil(range.start / interval);
  const last = Math.floor(range.end / interval);
  return Array.from(
    { length: Math.max(0, last - first + 1) },
    (_, i) => (first + i) * interval,
  );
}

/** Maximal runs of consecutive slots of one kind, as inclusive ranges. */
function runs(slots: number[], kinds: Slot[], kind: Slot): Range[] {
  const found: Range[] = [];
  for (const [i, t] of slots.entries()) {
    if (kinds[i] !== kind) continue;
    const last = found.at(-1);
    if (last !== undefined && kinds[i - 1] === kind) last.end = t;
    else found.push({ start: t, end: t });
  }
  return found;
}

export function toFrame(
  result: GetResult,
  range: Range,
  interval: number,
): Frame {
  const slots = alignedSlots(range, interval);
  const first = slots[0] ?? 0;
  const covered = (t: number) =>
    result.coverage.some(({ start, end }) => start <= t && t <= end);
  const kinds = slots.map((t): Slot => (covered(t) ? "gap" : "unloaded"));
  const columns = Object.entries(result.fields).map(([name, column]) => ({
    column,
    values: new Array<number | null>(slots.length).fill(null),
    name,
  }));
  let points = 0;
  for (const [i, t] of result.timestamps.entries()) {
    const slot = (t - first) / interval;
    if (slot < 0 || slot >= slots.length) continue;
    kinds[slot] = "point";
    points++;
    for (const { column, values } of columns) values[slot] = column[i] ?? null;
  }
  return {
    range,
    interval,
    slots,
    values: Object.fromEntries(columns.map((c) => [c.name, c.values])),
    points,
    gaps: runs(slots, kinds, "gap"),
    unloaded: runs(slots, kinds, "unloaded"),
    misses: result.misses,
  };
}
