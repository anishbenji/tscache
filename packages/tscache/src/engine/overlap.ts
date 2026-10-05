/**
 * Overlap-difference detection for the put path (docs/architecture.md §4.3,
 * starter §3.1). Runs only when `warnOnOverlapDiff` is on, and costs one
 * slice of the stored points under the batch.
 */

import type { SlotRange } from "../grid";
import type { Segment } from "../segment/types";
import type { FieldArray } from "../types";

/** A merge warning in slot terms; the engine converts it to a MergeWarning. */
export interface SlotWarning {
  range: SlotRange;
  fields: string[];
}

/** Incoming points with one array per schema field, in schema order and dtype. */
export interface Incoming {
  slots: Float64Array;
  names: readonly string[];
  columns: readonly FieldArray[];
}

/** NaN equals NaN: an unreported value that stays unreported did not change. */
function same(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

/** A run of consecutive batch points that all differ from what is stored. */
interface Run {
  start: number;
  end: number;
  /** Per schema field: whether it differed anywhere in the run. */
  differed: boolean[];
}

/** Walks the stored points under the batch, in step with the batch. */
class StoredCursor {
  readonly #segments: readonly Segment[];
  readonly #names: readonly string[];
  readonly #last: number;
  #index = 0;
  #slots: Float64Array = new Float64Array(0);
  #columns: FieldArray[] = [];
  #at = 0;
  #loaded = -1;

  constructor(segments: readonly Segment[], incoming: Incoming) {
    this.#segments = segments;
    this.#names = incoming.names;
    this.#last = incoming.slots[incoming.slots.length - 1] as number;
  }

  /** The segment that could hold `slot`: the first one ending at or after it. */
  #segmentFor(slot: number): Segment | undefined {
    while (this.#index < this.#segments.length) {
      const extent = (this.#segments[this.#index] as Segment).extent;
      if (extent !== undefined && extent.end >= slot) break;
      this.#index++;
    }
    return this.#segments[this.#index];
  }

  /** Loads the current segment's points from `slot` to the end of the batch. */
  #load(segment: Segment, slot: number, end: number): void {
    const old = segment.slice({ start: slot, end: Math.min(end, this.#last) });
    this.#slots = old.slots;
    this.#columns = this.#names.map((name) => old.fields[name] as FieldArray);
    this.#at = 0;
    this.#loaded = this.#index;
  }

  /** Index into the loaded slice of the stored point at `slot`, or -1. */
  seek(slot: number): number {
    const segment = this.#segmentFor(slot);
    const extent = segment?.extent;
    if (segment === undefined || extent === undefined || extent.start > slot) {
      return -1;
    }
    if (this.#loaded !== this.#index) this.#load(segment, slot, extent.end);
    const slots = this.#slots;
    while (this.#at < slots.length && (slots[this.#at] as number) < slot) {
      this.#at++;
    }
    return slots[this.#at] === slot ? this.#at : -1;
  }

  value(column: number, at: number): number {
    return (this.#columns[column] as FieldArray)[at] as number;
  }
}

/**
 * The warnings a put of `incoming` would raise against `segments` as they
 * are now: one per maximal run of consecutive batch points that each change a
 * stored value. Call before merging.
 */
export function overlapWarnings(
  segments: readonly Segment[],
  incoming: Incoming,
): SlotWarning[] {
  const { slots, names, columns } = incoming;
  const warnings: SlotWarning[] = [];
  if (slots.length === 0) return warnings;
  const stored = new StoredCursor(segments, incoming);
  let run: Run | undefined;
  const close = () => {
    if (run === undefined) return;
    const { start, end, differed } = run;
    warnings.push({
      range: { start, end },
      fields: names.filter((_, c) => differed[c]),
    });
    run = undefined;
  };
  for (let k = 0; k < slots.length; k++) {
    const slot = slots[k] as number;
    const at = stored.seek(slot);
    let any = false;
    const differed = columns.map((column, c) => {
      if (at === -1 || same(column[k] as number, stored.value(c, at))) {
        return false;
      }
      any = true;
      return true;
    });
    if (!any) {
      close();
    } else if (run === undefined) {
      run = { start: slot, end: slot, differed };
    } else {
      run.end = slot;
      run.differed = run.differed.map((was, c) => was || differed[c] === true);
    }
  }
  close();
  return warnings;
}
