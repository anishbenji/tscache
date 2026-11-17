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

/**
 * floor(slot / cap), exactly: the float division could round across a page
 * edge for slots near ±2^53, so it is built from the exact remainder. The
 * persisted page records use the same pages (§4.10.2).
 */
export function pageOf(slot: number, cap: number): number {
  const r = slot % cap;
  const q = (slot - r) / cap;
  return r < 0 ? q - 1 : q;
}

/**
 * The page's slots, clamped to safe integers. Each product is formed on
 * the side where it cannot leave exact-integer range before the clamp.
 */
export function pageRange(page: number, cap: number): SlotRange {
  const end = page < 0 ? (page + 1) * cap - 1 : page * cap + (cap - 1);
  return {
    start: Math.max(page * cap, Number.MIN_SAFE_INTEGER),
    end: Math.min(end, Number.MAX_SAFE_INTEGER),
  };
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
  /**
   * The running total of the segments' bytes once `count` switched it on
   * (M3, with a memory budget); undefined otherwise, when `bytes` walks.
   */
  #total: number | undefined;
  /** Told every change of the running total. */
  #onBytes: ((delta: number) => void) | undefined;

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
   * The bytes the segments have allocated (§2.9, N90): the running total
   * once `count` switched it on, otherwise the sum over the segments.
   */
  get bytes(): number {
    return this.#total ?? this.#bytesIn(undefined);
  }

  /**
   * Keeps a running total of the segments' bytes from now on, and reports
   * each change of it to `onBytes` (M3: only an engine with a budget pays
   * for it). Called once, on a store that holds nothing.
   */
  count(onBytes: (delta: number) => void): void {
    this.#total = this.#bytesIn(undefined);
    this.#onBytes = onBytes;
  }

  /** Adds `delta` to the running total, if one is kept. */
  #counted(delta: number): void {
    if (this.#total === undefined || delta === 0) return;
    this.#total += delta;
    this.#onBytes?.(delta);
  }

  /** The bytes of the segments that overlap `range`; every segment when undefined. */
  #bytesIn(range: SlotRange | undefined): number {
    let bytes = 0;
    let i = range === undefined ? 0 : this.#firstEndingFrom(range.start);
    for (; i < this.#segments.length; i++) {
      const segment = this.#segments[i] as Segment;
      if (range !== undefined && extentOf(segment).start > range.end) break;
      bytes += segment.bytes;
    }
    return bytes;
  }

  /**
   * The slots of the pages a put may change: every page from the first to
   * the last slot of its points and authority. Segments never cross a page
   * (N15), so no segment the put touches lies outside them.
   */
  #pagesOf(points: Columns, authority: SlotRange | undefined): SlotRange {
    const n = points.slots.length;
    let start = authority?.start ?? Number.POSITIVE_INFINITY;
    let end = authority?.end ?? Number.NEGATIVE_INFINITY;
    if (n > 0) {
      start = Math.min(start, points.slots[0] as number);
      end = Math.max(end, points.slots[n - 1] as number);
    }
    return {
      start: this.#pageRange(this.#page(start)).start,
      end: this.#pageRange(this.#page(end)).end,
    };
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
    if (
      this.#total === undefined ||
      (points.slots.length === 0 && authority === undefined)
    ) {
      return this.#put(points, authority);
    }
    // Counting: the bytes of the pages the put may change, before and after.
    const pages = this.#pagesOf(points, authority);
    const before = this.#bytesIn(pages);
    try {
      return this.#put(points, authority);
    } finally {
      this.#counted(this.#bytesIn(pages) - before);
    }
  }

  #put(points: Columns, authority: SlotRange | undefined): SlotWarning[] {
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

  /**
   * Writes the batch one write run at a time, in ascending slot order (N70).
   * A write run is a maximal stretch of consecutive batch points, each on the
   * same page as the one before it with at most K slots between them; it is
   * cut from the batch alone, so stored points never decide where it ends.
   */
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
    this.#counted(-(this.#total ?? 0));
  }

  /** Index range `[from, to)` of the segments on `page`. */
  #onPage(page: number): [number, number] {
    const { start, end } = this.#pageRange(page);
    const from = this.#firstEndingFrom(start);
    let to = from;
    while (
      to < this.#segments.length &&
      extentOf(this.#segments[to] as Segment).start <= end
    ) {
      to++;
    }
    return [from, to];
  }

  /**
   * Drops every segment on `page` (§4.3, N91): they are contiguous, and
   * none reaches another page (N15). Returns the bytes freed.
   */
  evictPage(page: number): number {
    const [from, to] = this.#onPage(page);
    let freed = 0;
    for (let i = from; i < to; i++)
      freed += (this.#segments[i] as Segment).bytes;
    if (to > from) this.#segments.splice(from, to - from);
    this.#counted(-freed);
    return freed;
  }

  /** The bytes of the segments on `page`. */
  pageBytes(page: number): number {
    const [from, to] = this.#onPage(page);
    let bytes = 0;
    for (let i = from; i < to; i++)
      bytes += (this.#segments[i] as Segment).bytes;
    return bytes;
  }

  /** The last present slot on `page`, or undefined when it holds none. */
  lastSlotOn(page: number): number | undefined {
    const [from, to] = this.#onPage(page);
    return to > from
      ? extentOf(this.#segments[to - 1] as Segment).end
      : undefined;
  }

  /**
   * Calls `fn` once per page that holds points and overlaps `range`,
   * ascending; every such page when `range` is undefined.
   */
  forEachPage(range: SlotRange | undefined, fn: (page: number) => void): void {
    let last: number | undefined;
    let i = range === undefined ? 0 : this.#firstEndingFrom(range.start);
    for (; i < this.#segments.length; i++) {
      const extent = extentOf(this.#segments[i] as Segment);
      if (range !== undefined && extent.start > range.end) break;
      const page = this.#page(extent.start);
      if (page !== last) fn(page);
      last = page;
    }
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

  /**
   * Points `[from, to)` of schema-ordered columns, as views; the arrays
   * themselves when that is all of them, as for most single-segment puts.
   * Segments copy what they are given, so neither is kept.
   */
  #columns(
    slots: Float64Array,
    from: number,
    to: number,
    columns: readonly FieldArray[],
  ): Columns {
    const whole = from === 0 && to === slots.length;
    const fields: Record<string, FieldArray> = {};
    for (let c = 0; c < this.#names.length; c++) {
      const column = columns[c] as FieldArray;
      setOwn(
        fields,
        this.#names[c] as string,
        whole ? column : column.subarray(from, to),
      );
    }
    return { slots: whole ? slots : slots.subarray(from, to), fields };
  }

  #page(slot: number): number {
    return pageOf(slot, this.#cap);
  }

  #pageRange(page: number): SlotRange {
    return pageRange(page, this.#cap);
  }

  /**
   * Whether two consecutive batch points belong to the same write run (N70):
   * same page and at most K slots between them. Stored points between them
   * are not counted, so the answer depends on the batch alone.
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
   * Adds one write run (N70) as `chunk`. Every stored segment on the run's
   * page that overlaps it, or lies within K slots of it, is merged with the
   * run into one segment; such segments join the run's segment but never
   * decide where the run ends. Either the whole run goes in or, if an
   * allocation fails, nothing changes.
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
