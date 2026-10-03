/**
 * Public shared types. Normative reference: docs/architecture.md §2.
 */

/** Field storage types. 64-bit ints and f16 are deliberately excluded (N7). */
export type Dtype = "f64" | "f32" | "i32" | "u32" | "i16" | "u16" | "i8" | "u8";

/** Runtime mirror of {@link Dtype} for validation. */
export const DTYPES: readonly Dtype[] = [
  "f64",
  "f32",
  "i32",
  "u32",
  "i16",
  "u16",
  "i8",
  "u8",
];

/** Typed arrays a field can materialize as. */
export type FieldArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array;

/**
 * Inclusive on BOTH ends (N1) — matches charting-library visible ranges, so
 * `chart.getVisibleRange()` feeds `get()` directly. Reads and invalidation
 * accept arbitrary ms values and snap outward to the alignment grid; `put`
 * timestamps must be exactly aligned. Internally all range math runs on
 * integer slot indices — the ms↔slot conversion is the one fencepost site.
 */
export interface Range {
  start: number;
  end: number;
}

/** Consumer-facing cache configuration. See docs/architecture.md §2.2. */
export interface CacheConfig {
  id: string;
  /** Interval in ms. Required — no default (resolved decision #2). */
  interval: number;
  /** Timestamps satisfy (t - alignmentOffset) % interval === 0. Default 0. */
  alignmentOffset?: number;
  /** Field name → dtype. At least one field. */
  fields: Record<string, Dtype>;
  /** Dense segment splits when an internal gap exceeds K intervals. Default 4. */
  gapSplitK?: number;
  /** Max slots per segment. Default 32_768. */
  segmentSlotCap?: number;
  /** Opt-in dataset version; mismatch on put → auto-clear + cacheCleared. */
  version?: string;
  /** Initial finalized-watermark; points at t >= watermark are provisional. */
  finalizedUntil?: number;
  /** Opt-in differs-on-overlap warning (O(overlap) cost). Default false. */
  warnOnOverlapDiff?: boolean;
}

/** {@link CacheConfig} with defaults applied; frozen. Internal currency. */
export interface ResolvedCacheConfig {
  id: string;
  interval: number;
  /** Normalized into [0, interval); names the same grid as the input. */
  alignmentOffset: number;
  fields: Readonly<Record<string, Dtype>>;
  gapSplitK: number;
  segmentSlotCap: number;
  warnOnOverlapDiff: boolean;
  version?: string;
  finalizedUntil?: number;
}

export type MissReason = "uncached" | "fetch-failed" | "auth-pending";

export interface Miss {
  range: Range;
  reason: MissReason;
  /** Present for 'fetch-failed': structured-cloneable error detail. */
  error?: { name: string; message: string };
}

/** Present-points-only columnar read result. See docs/architecture.md §2.3. */
export interface GetResult {
  timestamps: Float64Array;
  fields: Record<string, FieldArray>;
  /** Authoritative sub-ranges of the request; absent points inside = real gap. */
  coverage: Range[];
  /** Always present (possibly empty) — cannot be overlooked. */
  misses: Miss[];
}

export interface GetOptions {
  /** Skip orchestration, return current cache state immediately. Default false (N2). */
  cacheOnly?: boolean;
}

export interface PutBatch {
  /** Sorted ascending, aligned, no duplicates — else the whole batch rejects. */
  timestamps: Float64Array | number[];
  fields: Record<string, ArrayBufferView | number[]>;
  meta?: {
    version?: string;
    finalizedUntil?: number;
  };
}

export interface PutOptions {
  /**
   * Authority range; must contain all batch timestamps. Flanks without points
   * become CONFIRMED real gaps. Default: the batch's own span (N3).
   */
  range?: Range;
}

export interface MergeWarning {
  range: Range;
  fields: string[];
}

export interface PutResult {
  /** Non-empty only when warnOnOverlapDiff is on and overlapping values differed. */
  warnings: MergeWarning[];
}
