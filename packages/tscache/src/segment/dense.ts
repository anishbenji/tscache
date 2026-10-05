/**
 * DenseSegment: a run of consecutive slots with implicit timestamps, one
 * typed array per field and a presence bitmask of one bit per slot
 * (starter §3.2). Contract: docs/architecture.md §4.2.
 *
 * The buffers hold `#capacity` slots starting at slot `#base` and may be
 * larger than the extent, so appends and scroll-back prepends do not
 * reallocate every time. Slots outside the extent, and absent slots inside
 * it, always hold zero with their mask bit clear: the buffers are canonical,
 * which lets a payload be a plain copy of the extent.
 */

import { type Grid, msOf, type SlotRange } from "../grid";
import type { Dtype, FieldArray } from "../types";
import { assertPoints, assertSlot, assertSlotRange } from "./assert";
import { FIELD_ARRAYS, type FieldArrayConstructor } from "./dtype";
import { getOwn, setOwn } from "./own";
import {
  type Columns,
  type DenseSegmentPayload,
  MAX_SLOT_CAP,
  type Segment,
  type SegmentOptions,
} from "./types";

/** Smallest allocation, so a segment built point by point grows in few steps. */
const MIN_CAPACITY = 64;

interface Column {
  name: string;
  dtype: Dtype;
  ctor: FieldArrayConstructor;
  data: FieldArray;
}

/** Smallest range holding both; either may be undefined (no points). */
function union(
  a: SlotRange | undefined,
  b: SlotRange | undefined,
): SlotRange | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

export class DenseSegment implements Segment {
  readonly #grid: Grid;
  readonly #slotCap: number;
  readonly #columns: Column[];
  readonly #names: string[];
  #mask: Uint8Array = new Uint8Array(0);
  /** Slot stored at buffer index 0. */
  #base = 0;
  /** Slots the buffers can hold. */
  #capacity = 0;
  #extent: SlotRange | undefined;
  #size = 0;

  constructor(options: SegmentOptions) {
    const { slotCap } = options;
    if (!Number.isInteger(slotCap) || slotCap < 1 || slotCap > MAX_SLOT_CAP) {
      throw new RangeError(
        `slotCap must be an integer in [1, ${MAX_SLOT_CAP}], got ${slotCap}`,
      );
    }
    this.#grid = options.grid;
    this.#slotCap = options.slotCap;
    this.#columns = Object.entries(options.fields).map(([name, dtype]) => {
      const ctor = FIELD_ARRAYS[dtype];
      return { name, dtype, ctor, data: new ctor(0) };
    });
    this.#names = this.#columns.map((column) => column.name);
  }

  get extent(): SlotRange | undefined {
    return this.#extent && { ...this.#extent };
  }

  get size(): number {
    return this.#size;
  }

  /** Whether a slot inside the buffers has its presence bit set. */
  #has(slot: number): boolean {
    const i = slot - this.#base;
    return (((this.#mask[i >> 3] as number) >> (i & 7)) & 1) === 1;
  }

  lookup(slot: number): Record<string, number> | undefined {
    assertSlot(slot, "slot");
    const extent = this.#extent;
    if (extent === undefined || slot < extent.start || slot > extent.end) {
      return undefined;
    }
    if (!this.#has(slot)) return undefined;
    const row: Record<string, number> = {};
    for (const column of this.#columns) {
      setOwn(row, column.name, column.data[slot - this.#base] as number);
    }
    return row;
  }

  /** Present slots inside `range`, ascending. */
  #presentIn(range: SlotRange): number[] {
    const extent = this.#extent;
    const present: number[] = [];
    if (extent === undefined) return present;
    const end = Math.min(range.end, extent.end);
    for (let slot = Math.max(range.start, extent.start); slot <= end; slot++) {
      if (this.#has(slot)) present.push(slot);
    }
    return present;
  }

  slice(range: SlotRange): Columns {
    assertSlotRange(range, "range");
    const present = this.#presentIn(range);
    const fields: Record<string, FieldArray> = {};
    for (const column of this.#columns) {
      const out = new column.ctor(present.length);
      for (let k = 0; k < present.length; k++) {
        out[k] = column.data[(present[k] as number) - this.#base] as number;
      }
      setOwn(fields, column.name, out);
    }
    return { slots: Float64Array.from(present), fields };
  }

  mergeFrom(points: Columns, authority?: SlotRange): void {
    assertPoints(points, this.#names, authority);
    const kept = this.#keptExtent(authority);
    const n = points.slots.length;
    const added =
      n === 0
        ? undefined
        : {
            start: points.slots[0] as number,
            end: points.slots[n - 1] as number,
          };
    const next = union(kept, added);
    if (next !== undefined && next.end - next.start + 1 > this.#slotCap) {
      throw new RangeError(
        `merge would span slots [${next.start}, ${next.end}], more than the slot cap ${this.#slotCap}`,
      );
    }
    // Allocation is the last step that can fail, so it comes before the
    // first mutation: a rejected merge changes nothing.
    if (next !== undefined) this.#reserve(next, kept);
    if (authority !== undefined) this.#clear(authority);
    this.#extent = kept;
    if (next === undefined) return;
    this.#write(points);
    this.#extent = next;
  }

  /** Tight extent of the points that survive clearing `authority`. */
  #keptExtent(authority: SlotRange | undefined): SlotRange | undefined {
    const extent = this.#extent;
    if (extent === undefined) return undefined;
    // An authority that misses the extent removes nothing. Returning here
    // also keeps the scans below inside the extent, where the mask is valid.
    if (
      authority === undefined ||
      authority.start > extent.end ||
      authority.end < extent.start
    ) {
      return { ...extent };
    }
    const left = extent.start < authority.start;
    const right = extent.end > authority.end;
    if (!left && !right) return undefined;
    return {
      start: left ? extent.start : this.#firstPresentFrom(authority.end + 1),
      end: right ? extent.end : this.#lastPresentUpTo(authority.start - 1),
    };
  }

  /** First present slot at or after `slot`; the caller guarantees one exists. */
  #firstPresentFrom(slot: number): number {
    let s = slot;
    while (!this.#has(s)) s++;
    return s;
  }

  /** Last present slot at or before `slot`; the caller guarantees one exists. */
  #lastPresentUpTo(slot: number): number {
    let s = slot;
    while (!this.#has(s)) s--;
    return s;
  }

  /** Removes the points inside `authority`, zeroing their storage. */
  #clear(authority: SlotRange): void {
    const extent = this.#extent;
    if (extent === undefined) return;
    const start = Math.max(extent.start, authority.start);
    const end = Math.min(extent.end, authority.end);
    if (start > end) return;
    for (let slot = start; slot <= end; slot++) {
      if (!this.#has(slot)) continue;
      const i = slot - this.#base;
      (this.#mask[i >> 3] as number) &= ~(1 << (i & 7));
      this.#size--;
    }
    for (const column of this.#columns) {
      column.data.fill(0, start - this.#base, end - this.#base + 1);
    }
  }

  /**
   * Makes the buffers hold `next`. If they must be reallocated, only the
   * points that survive the merge (`kept`) move across, and every new buffer
   * is allocated before the segment is touched. Capacity doubles, capped at
   * the slot cap, with the spare room on the side the segment grows towards.
   */
  #reserve(next: SlotRange, kept: SlotRange | undefined): void {
    const fits =
      next.start >= this.#base && next.end < this.#base + this.#capacity;
    if (fits) return;
    const needed = next.end - next.start + 1;
    const capacity = Math.min(
      this.#slotCap,
      Math.max(needed, this.#capacity * 2, MIN_CAPACITY),
    );
    const base = this.#placeBase(next, kept, capacity - needed, capacity);
    // Build phase: allocate and fill every new buffer. Anything here may
    // throw (allocation, or a view for the copy), and the segment is still
    // untouched.
    const mask = new Uint8Array(Math.ceil(capacity / 8));
    const buffers = this.#columns.map((column) => {
      const data = new column.ctor(capacity);
      if (kept !== undefined) {
        const from = kept.start - this.#base;
        data.set(
          column.data.subarray(from, from + (kept.end - kept.start + 1)),
          kept.start - base,
        );
      }
      return data;
    });
    let size = 0;
    if (kept !== undefined) {
      for (let slot = kept.start; slot <= kept.end; slot++) {
        if (!this.#has(slot)) continue;
        const i = slot - base;
        (mask[i >> 3] as number) |= 1 << (i & 7);
        size++;
      }
    }
    // Commit phase: assignments only.
    for (let c = 0; c < buffers.length; c++) {
      (this.#columns[c] as Column).data = buffers[c] as FieldArray;
    }
    this.#mask = mask;
    this.#base = base;
    this.#capacity = capacity;
    // Points outside `kept` were not copied; the caller clears the rest.
    this.#extent = kept;
    this.#size = size;
  }

  /** Base slot for new buffers; keeps every index a safe integer. */
  #placeBase(
    next: SlotRange,
    kept: SlotRange | undefined,
    spare: number,
    capacity: number,
  ): number {
    const growsLeft = kept !== undefined && next.start < kept.start;
    const growsRight = kept !== undefined && next.end > kept.end;
    let lead = Math.floor(spare / 2);
    if (growsLeft && !growsRight) lead = spare;
    if (growsRight && !growsLeft) lead = 0;
    const base = Math.max(next.start - lead, Number.MIN_SAFE_INTEGER);
    return Math.min(base, Number.MAX_SAFE_INTEGER - capacity + 1);
  }

  /** Stores validated points; the buffers already hold their slots. */
  #write(points: Columns): void {
    const { slots } = points;
    for (const slot of slots) {
      const i = slot - this.#base;
      const bit = 1 << (i & 7);
      if (((this.#mask[i >> 3] as number) & bit) !== 0) continue;
      (this.#mask[i >> 3] as number) |= bit;
      this.#size++;
    }
    for (const column of this.#columns) {
      const values = getOwn(points.fields, column.name) as FieldArray;
      for (let k = 0; k < slots.length; k++) {
        column.data[(slots[k] as number) - this.#base] = values[k] as number;
      }
    }
  }

  transferPayload(): DenseSegmentPayload {
    const extent = this.#extent;
    if (extent === undefined) {
      throw new RangeError("an empty segment has no payload");
    }
    const count = extent.end - extent.start + 1;
    const mask = new Uint8Array(Math.ceil(count / 8));
    for (let i = 0; i < count; i++) {
      if (this.#has(extent.start + i)) (mask[i >> 3] as number) |= 1 << (i & 7);
    }
    const from = extent.start - this.#base;
    const fields = this.#columns.map((column) => {
      const data = new column.ctor(count);
      data.set(column.data.subarray(from, from + count));
      return {
        name: column.name,
        dtype: column.dtype,
        data: data.buffer as ArrayBuffer,
      };
    });
    return {
      format: 1,
      layout: "dense",
      start: msOf(extent.start, this.#grid),
      count,
      interval: this.#grid.interval,
      alignmentOffset: this.#grid.alignmentOffset,
      mask,
      fields,
    };
  }
}
