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
  /**
   * Keep this cache in IndexedDB across sessions, so a reload or a new tab
   * starts from what earlier sessions fetched (docs/architecture.md §4.10).
   * Default false. Structural (N20): every tab must pass the same value.
   *
   * Acts only when the client's mode is 'shared' and the browser has
   * IndexedDB (N52). In the dedicated-worker and in-process hostings, in Node
   * and for an `Engine` used directly it is accepted and ignored, without an
   * event (N45); `client.mode` tells which case applies. Stored records are
   * readable by every script of the origin and outlive the session until
   * `clearAll` (from a client of any hosting, N66), so keep per-user or
   * sensitive caches in memory.
   */
  persist?: boolean;
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
  persist: boolean;
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
  /**
   * One array per schema field. Every value must be a number the field can
   * hold, else the whole batch rejects (N68): never `null`; in an integer
   * field, an integer inside the dtype's range (`1.5` rejects).
   */
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
   * URL of the worker script (the package's `@anishbenji/tscache/worker` entry) as your
   * bundler serves it; see docs/guides/worker-setup.md for Vite, webpack and
   * no-bundler setups. Required unless `mode` is 'in-process'.
   */
  workerUrl?: string | URL;
  /** Starting hosting; fallback continues down-chain from it. Default 'shared'. */
  mode?: HostingMode;
  /**
   * How long a hosting may take to say hello before the chain steps down
   * (N25). Default 5000 ms. The timeout bounds only the wait for hello:
   * what the worker does after hello, such as loading the `fetcher` module,
   * is not bounded by it. A fetcher module that fails to load rejects
   * `createClient` with a `TscacheError` (`init-err`) instead of falling
   * back. A protocol mismatch never falls back either.
   */
  handshakeTimeoutMs?: number;
  /** Worker-side fetch orchestration (§2.5). Omit for pure pull-model use. */
  fetcher?: {
    /** Module specifier or URL the worker will import(). */
    module: string | URL;
    /** Structured-cloneable config/auth material passed to the fetcher. */
    context?: unknown;
  };
  /**
   * Upper bound, in bytes, on what the worker's caches hold (§2.9): a
   * positive safe integer, shared by every cache and, in a SharedWorker, by
   * every tab. Above it the least recently used pages that nothing pins
   * are evicted, with their coverage, so a later read fetches them again.
   * Default: none, and nothing is evicted. The first budget a worker
   * receives holds for its life, and a worker that already holds a cache
   * takes none; `memoryStats()` reports the budget in force.
   */
  memoryBudget?: number;
}

/**
 * What the worker's caches hold now (§2.9), from `client.memoryStats()` or
 * `engine.memoryStats()`. Bytes are those the cached points' typed arrays
 * have allocated, spare capacity included; object overhead and transient
 * copies (read results, a load's records) are not counted, so the figure
 * is a floor of the worker's memory.
 */
export interface MemoryStats {
  /** The budget in force, in bytes; absent when there is none. */
  budget?: number;
  /** Bytes the segments of every cache hold. */
  bytes: number;
  /** Of those, bytes in pages pinned now (a pending get, a provisional point); 0 without a budget. */
  pinnedBytes: number;
  /** Pages evicted since the budget took effect; 0 without a budget. */
  evictedPages: number;
  /** One entry per cache, ascending by id: its bytes and the pages that hold points. */
  caches: { cacheId: string; bytes: number; pages: number }[];
}

/** `'<clientId>:<seq>'`, unique across tabs (N5). */
export type RequestId = string;

/**
 * An optional feature a worker may offer, listed in its hello (N79) and
 * exposed as `TscacheClient.features`. `'superseded'` (N113): the worker
 * can report that a worker of a newer generation of the application runs.
 * Only a SharedWorker that can find the other workers of its origin lists
 * it: a dedicated worker and the in-process hosting never do, and neither
 * does a worker script from before the feature.
 */
export type WorkerFeature = "cacheChanged" | "memoryBudget" | "superseded";

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
  /**
   * A worker of a newer generation of this application (another tscache
   * version, fetcher module or worker build) is running in the origin
   * (N113). This tab's worker no longer persists; the tab keeps working
   * from memory and its fetcher. Reload the tab to join the newer worker:
   * show the user a prompt, since the library never reloads a page. `lib`
   * is the newer worker's tscache version. At most once per client;
   * `client.superseded` holds the payload afterwards. A client created
   * against a worker that is already superseded hears it on the macrotask
   * after `createClient` resolves, as `modeFallback` is delivered, with
   * `client.superseded` already set.
   */
  superseded: { lib: string };
  /**
   * A cache was cleared; in SharedWorker mode one tab's clear affects all,
   * and a `clearAll` reaches the other SharedWorkers of the origin too
   * (N116), so one call can be heard more than once.
   */
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
  /**
   * Persistence of this cache stopped (N47): the cache goes on in memory,
   * and nothing more is written for it while its worker lives. A failure
   * never rejects a call; this event reports it. A stop while `cache()`
   * loads is emitted before the handle exists, so subscribe with
   * `client.on` to hear it.
   *
   * `'superseded'` (N112) is not a failure: a worker of a newer generation
   * of the application runs in the origin and owns the stored records now.
   * Nothing was deleted, and a reload joins that worker.
   */
  persistStopped: {
    cacheId: string;
    reason: "quota-exceeded" | "unavailable" | "error" | "superseded";
    /** The underlying failure, when there is one. */
    error?: { name: string; message: string };
  };
  /**
   * What a reader of this cache sees may have changed (§2.7, N71–N84).
   * Notify-only: it carries ranges, never data. Sent once per mutating
   * call that changed the cache, to every client that listens (the
   * writer's own included), before that call resolves. Ranges are in ms
   * on the grid, ascending, disjoint and not adjacent.
   *
   * To stay current, read the range you show again: with
   * `{ cacheOnly: true }` when `written` is not empty and a written or
   * removed range overlaps it, or `cleared` is set; with a fetching `get`
   * when nothing was written and `cleared` is set or a removed range
   * overlaps it; otherwise not at all. A fetching read after every event
   * would loop over a volatile tail. "The range you show" is that range
   * as read: snapped outward to the grid, as `get` snaps it, so a change
   * at a grid point just outside an unaligned range counts. Coalesce
   * bursts, for example to one read per animation frame.
   *
   * Needs a worker that offers it (`client.features.has('cacheChanged')`):
   * against an older worker the listener is never called.
   */
  cacheChanged: {
    cacheId: string;
    /** Points or coverage were written here: a put, a fetch, a hydrate. */
    written: Range[];
    /** Coverage was withdrawn here; the points may still be present. */
    removed: Range[];
    /** Every point and all coverage went (clear, clearAll, version mismatch). */
    cleared: boolean;
    /**
     * Coverage the memory budget evicted here (§2.9): the data did not
     * change, so a view's copy is still right and nothing needs re-reading;
     * a later read of the range fetches it again. Absent when the call
     * evicted nothing, and always without a budget.
     */
    evicted?: Range[];
    /**
     * The call that made the change: a put, invalidate, clear, clearAll,
     * hydrate or setFinalizedUntil, or for a fetch the get that issued it.
     */
    requestId?: RequestId;
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
  /** As `PutBatch.fields` (N68): map a JSON `null` to `NaN` for a float field. */
  fields: Record<string, ArrayBufferView | number[]>;
  meta?: { version?: string; finalizedUntil?: number };
}

/** The fetcher module's default export (§2.5). */
export interface Fetcher {
  fetch(request: FetchRequest): Promise<FetchResponse>;
  /** Optional: observe auth updates (e.g. swap a token held in module state). */
  updateAuth?(context: unknown): void | Promise<void>;
}
