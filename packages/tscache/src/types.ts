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
  /**
   * Field name → dtype. At least one field. Presence is per point, not per
   * field: a float field can hold NaN for a missing value, while an integer
   * field cannot mark one (docs/guides/patterns.md).
   */
  fields: Record<string, Dtype>;
  /** Dense segment splits where more than K consecutive slots hold no point. Default 4. */
  gapSplitK?: number;
  /** Max slots per segment. Default 32_768; at most 2^31 - 1. */
  segmentSlotCap?: number;
  /** Opt-in dataset version; mismatch on put → auto-clear + cacheCleared. */
  version?: string;
  /** Initial finalized-watermark; points at t >= watermark are provisional. */
  finalizedUntil?: number;
  /**
   * Opt-in differs-on-overlap warning (O(overlap) cost). Default false.
   * Reported in `put()` results and `mergeWarning` events, and printed with
   * console.warn in development builds by the page that made the write.
   */
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
  /** Present when {@link GetOptions.snapshot} was set (§2.8). */
  snapshot?: Snapshot;
}

export interface GetOptions {
  /** Skip orchestration, return current cache state immediately. Default false (N2). */
  cacheOnly?: boolean;
  /**
   * Also return a {@link Snapshot} of the request, taken from the same state
   * as the result (docs/architecture.md §2.8, N36). Default false.
   */
  snapshot?: boolean;
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

/**
 * What a cache knows about a range (docs/architecture.md §2.8, N34): the
 * §3.4 payloads of its present points, clipped to the range, in an envelope
 * naming the grid and schema, the dataset version and watermark in force,
 * and the covered sub-ranges. Take one with `get(range, { snapshot: true })`;
 * apply one with `CacheHandle.hydrate`.
 */
export interface Snapshot {
  /** The envelope's schema version; each payload carries its own `format`. */
  format: 1;
  /** The grid and schema of the cache it was taken from; hydrate refuses any other. */
  interval: number;
  alignmentOffset: number;
  fields: Record<string, Dtype>;
  /** The request it answers, snapped outward (N1), in ms. */
  range: Range;
  /** The dataset version in force when it was taken, if any. */
  version?: string;
  /** The finalized watermark in force when it was taken, if any. */
  finalizedUntil?: number;
  /** Authoritative sub-ranges of `range`, ascending; equals the read's coverage. */
  coverage: Range[];
  /**
   * The present points inside `range`, covered or not (N16): one payload per
   * segment with a point inside the range, holding exactly those points;
   * ascending and disjoint; fresh buffers.
   */
  segments: DenseSegmentPayload[];
}

/** What `hydrate` did (§2.8, N35). */
export interface HydrateResult {
  /**
   * The ranges written, in ms, ascending and disjoint: the snapshot's
   * coverage minus what the cache already covered or holds as provisional.
   */
  applied: Range[];
  /** Set when nothing was applied because the two dataset versions differ. */
  skipped?: "version-mismatch";
}

/** A {@link DenseSegmentPayload} with its binary parts as base64 text (N38). */
export interface EncodedSegmentPayload
  extends Omit<DenseSegmentPayload, "mask" | "fields"> {
  /** Base64 of the mask bytes. */
  mask: string;
  /** Each field's data as base64 of its little-endian bytes. */
  fields: { name: string; dtype: Dtype; data: string }[];
}

/**
 * A {@link Snapshot} as a plain JSON value (N38): `encodeSnapshot` makes one,
 * `decodeSnapshot` restores the snapshot. `NaN` survives, as JSON numbers
 * would not.
 */
export interface EncodedSnapshot extends Omit<Snapshot, "segments"> {
  segments: EncodedSegmentPayload[];
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
   * become CONFIRMED real gaps. Default: the batch's own span (N3). A range
   * that is not on the grid covers only the grid points inside it (N13).
   */
  range?: Range;
}

export interface MergeWarning {
  range: Range;
  fields: string[];
}

export interface PutResult {
  /**
   * Non-empty only when warnOnOverlapDiff is on and overlapping values
   * differed. A client's `put()` also prints them in one console.warn in
   * development builds; an Engine called directly only returns them.
   */
  warnings: MergeWarning[];
}

/** Where the engine runs; the fallback chain steps down this list (§2.1). */
export type HostingMode = "shared" | "dedicated" | "in-process";

export interface ClientOptions {
  /**
   * URL of the worker script (the package's `tscache/worker` entry) as your
   * bundler serves it; see docs/guides/worker-setup.md for Vite, webpack and
   * no-bundler setups. Required unless `mode` is 'in-process'.
   */
  workerUrl?: string | URL;
  /** Starting hosting; fallback continues down-chain from it. Default 'shared'. */
  mode?: HostingMode;
  /**
   * How long a hosting may take to say hello before the chain steps down
   * (N25). Default 5000 ms. A protocol mismatch never falls back.
   */
  handshakeTimeoutMs?: number;
  /** Worker-side fetch orchestration (§2.5). Omit for pure pull-model use. */
  fetcher?: {
    /** Module specifier or URL the worker will import(). */
    module: string | URL;
    /** Structured-cloneable config/auth material passed to the fetcher. */
    context?: unknown;
  };
}

/** '<clientId>:<seq>' — unique across tabs (N5). */
export type RequestId = string;

/** Three scopes, one channel (N5, §2.7). */
export interface ClientEvents {
  /**
   * Fetcher signalled auth failure; broadcast to all tabs (step ⑪).
   * `context` is the fetcher context the refused fetch was issued with
   * (N33), so a tab refreshes only when its credential is the refused one.
   */
  authInvalid: { error: { name: string; message: string }; context: unknown };
  /** The fallback chain stepped down while connecting. */
  modeFallback: { from: HostingMode; to: HostingMode; reason: string };
  /**
   * The worker behind this client is gone (N32): every pending and later
   * call rejects with TscacheError; create a new client to go on (it starts
   * a new worker). At most once per client; never after dispose().
   */
  workerLost: { reason: string };
  /** A cache was cleared; in SharedWorker mode one tab's clear affects all. */
  cacheCleared: {
    cacheId: string;
    reason: "manual" | "clear-all" | "version-mismatch";
  };
  /**
   * Opt-in (warnOnOverlapDiff): an overlapping put differed. Every tab hears
   * it; in development builds only the tab that made the request prints it
   * with console.warn (decision #8).
   */
  mergeWarning: {
    cacheId: string;
    requestId: RequestId;
    range: Range;
    fields: string[];
  };
}

/** What the worker asks a fetcher for (§2.5): one coalesced miss range. */
export interface FetchRequest {
  cacheId: string;
  /** Inclusive ms range, already coalesced (flanks extended by one interval). */
  range: Range;
  interval: number;
  alignmentOffset: number;
  /** The latest context given to createClient or updateAuth. */
  context: unknown;
}

/** A fetcher's answer: a PutBatch for the whole requested range (§2.5). */
export interface FetchResponse {
  timestamps: Float64Array | number[];
  fields: Record<string, ArrayBufferView | number[]>;
  meta?: { version?: string; finalizedUntil?: number };
}

/** The fetcher module's default export (§2.5). */
export interface Fetcher {
  fetch(request: FetchRequest): Promise<FetchResponse>;
  /** Optional: observe auth updates (e.g. swap a token held in module state). */
  updateAuth?(context: unknown): void | Promise<void>;
}
