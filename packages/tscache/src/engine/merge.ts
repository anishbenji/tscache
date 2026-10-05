/**
 * Put path (docs/architecture.md §4.3): all the segments of one cache, and
 * the policy that decides which segment a point lives in. A segment only
 * refuses to exceed its slot cap (§4.2); where runs of points are cut is
 * decided here.
 *
 * Layout (N14, N15): two present points with no present point between them
 * share a segment exactly when they are on the same page (a page is
 * `segmentSlotCap` slots, starting at a multiple of it) and at most
 * `gapSplitK` slots between them hold no point. The layout is therefore a
 * function of which points are present, whatever order they arrived in.
 */

import type { SlotRange } from "../grid";
import { assertPoints } from "../segment/assert";
import { DenseSegment } from "../segment/dense";
import { FIELD_ARRAYS, type FieldArrayConstructor } from "../segment/dtype";
import { getOwn, setOwn } from "../segment/own";
import type { Columns, Segment, SegmentOptions } from "../segment/types";
import type { Dtype, FieldArray, ResolvedCacheConfig } from "../types";
import { type Incoming, overlapWarnings, type SlotWarning } from "./overlap";

export type { SlotWarning } from "./overlap";

/** A segment in the store always has points, so always has an extent. */
function extentOf(segment: Segment): SlotRange {
  return segment.extent as SlotRange;
}

function span(segment: Segment): number {
  const { start, end } = extentOf(segment);
  return end - start;
}

export class SegmentStore {
  readonly #options: SegmentOptions;
  readonly #names: string[];
  readonly #ctors: FieldArrayConstructor[];
  readonly #cap: number;
  readonly #k: number;
  readonly #warn: boolean;
  /** No points, in the schema's shape: clears a range when merged with one. */
  readonly #nothing: Columns;
  #segments: Segment[] = [];

  constructor(config: ResolvedCacheConfig) {
    this.#options = {
      grid: {
        interval: config.interval,
        alignmentOffset: config.alignmentOffset,
      },
      fields: config.fields,
      slotCap: config.segmentSlotCap,
    };
    this.#names = Object.keys(config.fields);
    this.#ctors = this.#names.map(
      (name) => FIELD_ARRAYS[getOwn(config.fields, name) as Dtype],
    );
    this.#cap = config.segmentSlotCap;
    this.#k = config.gapSplitK;
    this.#warn = config.warnOnOverlapDiff;
    this.#nothing = this.#columns(
      new Float64Array(0),
      0,
      0,
      this.#ctors.map((ctor) => new ctor(0)),
    );
  }

  /** Ascending by extent, disjoint, none empty, in the layout above. */
  get segments(): readonly Segment[] {
    return this.#segments;
  }

  /**
   * Merges validated points in; new values win. Without `authority` it only
   * adds or overwrites; with it the present points inside that range end up
   * exactly `points` (N11). Returns the overlap warnings, always empty when
   * `warnOnOverlapDiff` is off. Malformed input throws RangeError before
   * anything changes.
   */
  put(points: Columns, authority?: SlotRange): SlotWarning[] {
    assertPoints(points, this.#names, authority);
    const incoming = this.#incoming(points);
    const warnings = this.#warn
      ? overlapWarnings(this.#segments, incoming)
      : [];
    const carved = authority === undefined ? undefined : this.#carve(authority);
    try {
      this.#insertChunks(incoming);
    } finally {
      // Also after a failed insert: the layout must hold for the next put.
      if (carved !== undefined && authority !== undefined) {
        this.#resplit(carved, authority);
      }
    }
    return warnings;
  }

  /** Writes the batch one chunk at a time; a chunk is a run that shares a segment. */
  #insertChunks(incoming: Incoming): void {
    const { slots, columns } = incoming;
    let from = 0;
    for (let k = 1; k <= slots.length; k++) {
      if (
        k < slots.length &&
        this.#together(slots[k - 1] as number, slots[k] as number)
      ) {
        continue;
      }
      this.#insert(this.#columns(slots, from, k, columns));
      from = k;
    }
  }

  /** Drops every segment. */
  clear(): void {
    this.#segments = [];
  }

  /** The points as one array per schema field, in schema order and dtype. */
  #incoming(points: Columns): Incoming {
    const columns = this.#names.map((name, c) => {
      const values = getOwn(points.fields, name) as FieldArray;
      const ctor = this.#ctors[c] as FieldArrayConstructor;
      if (values instanceof ctor) return values;
      const converted = new ctor(values.length);
      converted.set(values);
      return converted;
    });
    return { slots: points.slots, names: this.#names, columns };
  }

  /** Points `[from, to)` of schema-ordered columns, as views. */
  #columns(
    slots: Float64Array,
    from: number,
    to: number,
    columns: readonly FieldArray[],
  ): Columns {
    const fields: Record<string, FieldArray> = {};
    this.#names.forEach((name, c) => {
      setOwn(fields, name, (columns[c] as FieldArray).subarray(from, to));
    });
    return { slots: slots.subarray(from, to), fields };
  }

  /**
   * floor(slot / cap), exactly: the float division could round across a page
   * edge for slots near ±2^53, so it is built from the exact remainder.
   */
  #page(slot: number): number {
    const r = slot % this.#cap;
    const q = (slot - r) / this.#cap;
    return r < 0 ? q - 1 : q;
  }

  /**
   * The page's slots, clamped to safe integers. Each product is formed on
   * the side where it cannot leave exact-integer range before the clamp.
   */
  #pageRange(page: number): SlotRange {
    const cap = this.#cap;
    const end = page < 0 ? (page + 1) * cap - 1 : page * cap + (cap - 1);
    return {
      start: Math.max(page * cap, Number.MIN_SAFE_INTEGER),
      end: Math.min(end, Number.MAX_SAFE_INTEGER),
    };
  }

  /**
   * Whether two ascending batch points certainly share a segment: same page
   * and at most K slots between them. Stored points between them can only
   * narrow the gap.
   */
  #together(a: number, b: number): boolean {
    return b - a - 1 <= this.#k && this.#page(a) === this.#page(b);
  }

  /** Index of the first segment ending at or after `slot`. */
  #firstEndingFrom(slot: number): number {
    let lo = 0;
    let hi = this.#segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (extentOf(this.#segments[mid] as Segment).end < slot) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Removes the stored points inside `authority`. Returns the segment that
   * reaches past it on both sides, if there is one: clearing its middle may
   * have opened a gap wider than K, which is settled once the batch is in.
   */
  #carve(authority: SlotRange): Segment | undefined {
    let interior: Segment | undefined;
    let i = this.#firstEndingFrom(authority.start);
    while (i < this.#segments.length) {
      const segment = this.#segments[i] as Segment;
      const extent = extentOf(segment);
      if (extent.start > authority.end) break;
      if (extent.start < authority.start && extent.end > authority.end) {
        interior = segment;
      }
      segment.mergeFrom(this.#nothing, authority);
      if (segment.extent === undefined) this.#segments.splice(i, 1);
      else i++;
    }
    return interior;
  }

  /**
   * Adds a chunk of points that share a segment. Every stored segment on the
   * chunk's page that overlaps it, or lies within K slots of it, belongs to
   * the same run, so they all end up in one segment with the chunk. Either
   * the whole chunk goes in or, if an allocation fails, nothing changes.
   */
  #insert(chunk: Columns): void {
    const first = chunk.slots[0] as number;
    const last = chunk.slots[chunk.slots.length - 1] as number;
    const page = this.#pageRange(this.#page(first));
    const lo = Math.max(first - this.#k - 1, page.start);
    const hi = Math.min(last + this.#k + 1, page.end);
    const at = this.#firstEndingFrom(lo);
    let end = at;
    while (
      end < this.#segments.length &&
      extentOf(this.#segments[end] as Segment).start <= hi
    ) {
      end++;
    }
    if (end === at) {
      const segment = new DenseSegment(this.#options);
      segment.mergeFrom(chunk);
      this.#segments.splice(at, 0, segment);
    } else if (end === at + 1) {
      (this.#segments[at] as Segment).mergeFrom(chunk);
    } else {
      this.#join(at, end, chunk);
    }
  }

  /**
   * Joins segments `[at, end)` and the chunk into the widest of them. The
   * other segments and the chunk are first gathered in a scratch segment, so
   * the stored one changes in a single merge, which is atomic (§4.2), and the
   * list is edited only after it. The widest segment is the one not copied
   * twice.
   */
  #join(at: number, end: number, chunk: Columns): void {
    let t = at;
    for (let i = at + 1; i < end; i++) {
      if (
        span(this.#segments[i] as Segment) > span(this.#segments[t] as Segment)
      ) {
        t = i;
      }
    }
    const target = this.#segments[t] as Segment;
    const scratch = new DenseSegment(this.#options);
    for (let i = at; i < end; i++) {
      const segment = this.#segments[i] as Segment;
      if (segment !== target)
        scratch.mergeFrom(segment.slice(extentOf(segment)));
    }
    // Last, so the chunk's values win over stored ones.
    scratch.mergeFrom(chunk);
    target.mergeFrom(scratch.slice(extentOf(scratch)));
    this.#segments.splice(at, end - at, target);
  }

  /**
   * Splits `segment` wherever the replace of `authority` left more than K
   * empty slots in a row. Only gaps touching the authority can be new, and
   * the stored points bounding them lie within K + 1 slots of it.
   */
  #resplit(segment: Segment, authority: SlotRange): void {
    const extent = extentOf(segment);
    const { slots } = segment.slice({
      start: Math.max(extent.start, authority.start - this.#k - 1),
      end: Math.min(extent.end, authority.end + this.#k + 1),
    });
    const cuts: number[] = [];
    for (let i = 1; i < slots.length; i++) {
      const gap = (slots[i] as number) - (slots[i - 1] as number) - 1;
      if (gap > this.#k) cuts.push(slots[i] as number);
    }
    if (cuts.length === 0) return;
    // Build every new segment, and the new list, before the old one is cut back.
    const parts = cuts.map((start, c) => {
      const next = cuts[c + 1];
      const part = new DenseSegment(this.#options);
      part.mergeFrom(
        segment.slice({
          start,
          end: next === undefined ? extent.end : next - 1,
        }),
      );
      return part;
    });
    // A spread into splice would overflow the stack for very many parts.
    const at = this.#segments.indexOf(segment) + 1;
    const next = this.#segments
      .slice(0, at)
      .concat(parts, this.#segments.slice(at));
    // Nothing above changed the store; nothing below can fail.
    segment.mergeFrom(this.#nothing, {
      start: cuts[0] as number,
      end: extent.end,
    });
    this.#segments = next;
  }
}
