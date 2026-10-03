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
import { FIELD_ARRAYS, type FieldArrayConstructor } from "./dtype";
import { getOwn, setOwn } from "./own";
import type {
  Columns,
  DenseSegmentPayload,
  Segment,
  SegmentOptions,
} from "./types";

/** Smallest allocation, so a segment built point by point grows in few steps. */
const MIN_CAPACITY = 64;

interface Column {
  name: string;
  dtype: Dtype;
  ctor: FieldArrayConstructor;
  data: FieldArray;
}

function assertSlot(slot: number, what: string): void {
  if (!Number.isSafeInteger(slot)) {
    throw new RangeError(`${what} must be a safe integer, got ${slot}`);
  }
}

function assertSlotRange(r: SlotRange, what: string): void {
  assertSlot(r.start, `${what} start`);
  assertSlot(r.end, `${what} end`);
  if (r.start > r.end) {
    throw new RangeError(`${what} start ${r.start} is after its end ${r.end}`);
  }
}

function assertAscending(slots: Float64Array): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const slot of slots) {
    assertSlot(slot, "point slot");
    if (slot <= previous) {
      throw new RangeError(
        `point slots must be strictly ascending, got ${slot} after ${previous}`,
      );
    }
    previous = slot;
  }
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
  #mask: Uint8Array = new Uint8Array(0);
  /** Slot stored at buffer index 0. */
  #base = 0;
  /** Slots the buffers can hold. */
  #capacity = 0;
  #extent: SlotRange | undefined;
  #size = 0;

  constructor(options: SegmentOptions) {
    this.#grid = options.grid;
    this.#slotCap = options.slotCap;
    this.#columns = Object.entries(options.fields).map(([name, dtype]) => {
      const ctor = FIELD_ARRAYS[dtype];
      return { name, dtype, ctor, data: new ctor(0) };
    });
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
    if (authority !== undefined) assertSlotRange(authority, "authority");
    this.#assertPoints(points, authority);
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

  /** Rejects malformed input before anything is written (programming errors). */
  #assertPoints(points: Columns, authority: SlotRange | undefined): void {
    const { slots, fields } = points;
    assertAscending(slots);
    if (Object.keys(fields).length !== this.#columns.length) {
      throw new RangeError("point fields must be exactly the schema's fields");
    }
    for (const column of this.#columns) {
      const values = getOwn(fields, column.name);
      if (values === undefined || values.length !== slots.length) {
        throw new RangeError(
          `point field "${column.name}" must hold ${slots.length} values`,
        );
      }
    }
    if (authority === undefined || slots.length === 0) return;
    const first = slots[0] as number;
    const last = slots[slots.length - 1] as number;
    if (first < authority.start || last > authority.end) {
      throw new RangeError(
        `points [${first}, ${last}] lie outside the authority [${authority.start}, ${authority.end}]`,
      );
    }
  }

  /** Tight extent of the points that survive clearing `authority`. */
  #keptExtent(authority: SlotRange | undefined): SlotRange | undefined {
    const extent = this.#extent;
    if (extent === undefined) return undefined;
    if (authority === undefined) return { ...extent };
    const left = extent.start < authority.start;
    const right = extent.end > authority.end;
    if (!left && !right) return undefined;
    // extent.start and extent.end are present, so each scan terminates.
    let start = extent.start;
    if (!left) {
      start = authority.end + 1;
      while (!this.#has(start)) start++;
    }
    let end = extent.end;
    if (!right) {
      end = authority.start - 1;
      while (!this.#has(end)) end--;
    }
    return { start, end };
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
    const mask = new Uint8Array(Math.ceil(capacity / 8));
    const buffers = this.#columns.map((column) => new column.ctor(capacity));
    // Everything is allocated; from here on nothing throws.
    let size = 0;
    if (kept !== undefined) {
      for (let slot = kept.start; slot <= kept.end; slot++) {
        if (!this.#has(slot)) continue;
        const i = slot - base;
        (mask[i >> 3] as number) |= 1 << (i & 7);
        size++;
      }
    }
    this.#columns.forEach((column, c) => {
      const data = buffers[c] as FieldArray;
      if (kept !== undefined) {
        const from = kept.start - this.#base;
        data.set(
          column.data.subarray(from, from + (kept.end - kept.start + 1)),
          kept.start - base,
        );
      }
      column.data = data;
    });
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
