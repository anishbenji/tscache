/**
 * Segment contract (docs/architecture.md §4.2). Code outside `segment/`
 * depends only on these types, so coverage logic, merge orchestration and
 * RPC stay layout-agnostic when further layouts (columnar, …) arrive.
 */

import type { Grid, SlotRange } from "../grid";
import type { Dtype, FieldArray } from "../types";

/**
 * Present points only, in slot terms: every field array has `slots.length`
 * elements, and slots are strictly ascending safe integers.
 */
export interface Columns {
  slots: Float64Array;
  fields: Record<string, FieldArray>;
}

/**
 * Self-describing segment transfer payload (architecture §3.4). One format,
 * three uses: RPC message, IndexedDB value and SSR hydration payload, so it
 * must stay a plain structured-cloneable object.
 */
export interface DenseSegmentPayload {
  /** Payload schema version. */
  format: 1;
  layout: "dense";
  /** Timestamp of the first slot. */
  start: number;
  /** Slot count; slot i is at start + i * interval. */
  count: number;
  interval: number;
  alignmentOffset: number;
  /** ceil(count / 8) bytes; slot i is bit (i & 7) of byte (i >> 3). */
  mask: Uint8Array;
  /** Schema declaration order; little-endian; absent slots hold zero. */
  fields: { name: string; dtype: Dtype; data: ArrayBuffer }[];
}

/** What a segment needs from the cache's resolved config. */
export interface SegmentOptions {
  grid: Grid;
  fields: Readonly<Record<string, Dtype>>;
  /** Maximum slots the extent may span. */
  slotCap: number;
}

export interface Segment {
  /** First to last present slot (tight); undefined when no point is present. */
  readonly extent: SlotRange | undefined;
  /** Number of present points. */
  readonly size: number;

  /**
   * The point at `slot` as a fresh object holding exactly the schema's
   * fields, or undefined if no point is present there. A present point
   * whose value is NaN is returned: presence is per point, not per value.
   */
  lookup(slot: number): Record<string, number> | undefined;

  /** The present points inside `range`, as fresh arrays (never views). */
  slice(range: SlotRange): Columns;

  /**
   * Writes points in; new values win. Without `authority` it only adds or
   * overwrites. With `authority` the present points inside that range end up
   * exactly `points` (N11). Validates before mutating; copies its input.
   */
  mergeFrom(points: Columns, authority?: SlotRange): void;

  /** A self-describing copy in fresh buffers, safe to transfer. */
  transferPayload(): DenseSegmentPayload;
}
