# tscache — Consolidated Architecture

Status: **draft for review** (starter-prompt §12 deliverable). All decisions from the starter's §3 Decision Register are locked and reflected here unchanged. Section 7 records the resolved open decisions; section 8 registers the *new* decision points that surfaced while concretizing the API — all resolved with the user on 2026-06-11.

---

## 1. Overview

`tscache` caches timestamp-aligned time-series data in the browser. One engine class runs in a SharedWorker, a dedicated Worker, or in-process (fallback chain, pinnable). Coverage (what is *known*) is tracked separately from data (what *exists*), so confirmed real gaps are first-class. The worker orchestrates fetches via a consumer-supplied fetcher module, deduplicating in-flight requests across tabs.

```
┌─ tab A ─────────┐  ┌─ tab B ─────────┐
│ client (RPC)    │  │ client (RPC)    │
└───────┬─────────┘  └────────┬────────┘
        └────── MessagePort ──┘
        ┌───────────▼────────────┐
        │ SharedWorker           │
        │  rpc server            │
        │  orchestrator ── fetcher (dynamic import)
        │  engine                │
        │   ├ coverage index     │
        │   └ segments (dense)   │
        └────────────────────────┘
```

Out of scope for v1 (roadmap): aggregation/resampling, ColumnarSegment, subscriptions, IndexedDB persistence, eviction, SharedArrayBuffer, per-field presence masks, irregular timestamps, elected auth handler, Node `worker_threads`.

## 2. Public API surface

All types below are exact proposals; names and shapes are the review surface.

### 2.1 Client creation and fallback chain

```ts
type HostingMode = 'shared' | 'dedicated' | 'in-process';

interface ClientOptions {
  /**
   * Worker script URL — the consumer resolves the packaged entry, e.g.
   * `new URL('tscache/worker', import.meta.url)` (bundler guide covers
   * Vite/webpack). Omit only when pinning 'in-process'.
   */
  workerUrl?: string | URL;
  /**
   * Pin the starting hosting mode; fallback continues down-chain from
   * the pin (shared → dedicated → in-process). Default: 'shared'.
   */
  mode?: HostingMode;
  /** Worker-side fetch orchestration (§2.5). Omit for pure pull-model use. */
  fetcher?: {
    /** Module specifier/URL the worker will dynamic-import(). */
    module: string | URL;
    /** Structured-cloneable config/auth material passed to the fetcher. */
    context?: unknown;
  };
}

/** Resolves after transport is established and the protocol handshake passed. */
declare function createClient(options?: ClientOptions): Promise<TscacheClient>;

interface TscacheClient {
  /**
   * Get-or-create. Identical config returns the existing cache (multi-tab:
   * every tab calls this with the same values). Structural mismatch with the
   * live config (interval/fields/offset/...) rejects with ConfigError (N4).
   */
  cache(config: CacheConfig): Promise<CacheHandle>;
  /** Which hosting mode actually won the fallback chain. */
  readonly mode: HostingMode;
  clearAll(): Promise<void>;
  /** Deliver new auth material to the fetcher; paused fetches retry. */
  updateAuth(context: unknown): Promise<void>;
  on<E extends keyof ClientEvents>(event: E, fn: (e: ClientEvents[E]) => void): () => void;
  off<E extends keyof ClientEvents>(event: E, fn: (e: ClientEvents[E]) => void): void;
  /** Release the port / terminate owned worker. Idempotent. */
  dispose(): Promise<void>;
}
```

The in-process engine has zero DOM/worker imports at module top level (lazy construction), so `'in-process'` is SSR/Node-safe and is the mode used by the SSR examples.

### 2.2 Cache configuration

```ts
type Dtype = 'f64' | 'f32' | 'i32' | 'u32' | 'i16' | 'u16' | 'i8' | 'u8'; // N7: final for v1

interface CacheConfig {
  id: string;
  /** Interval in ms. REQUIRED — no default (resolved decision #2). */
  interval: number;
  /** Timestamps satisfy (t - alignmentOffset) % interval === 0. Default 0. */
  alignmentOffset?: number;
  /** Field name → dtype. 'f64' is the documented default dtype. */
  fields: Record<string, Dtype>;
  /** Dense segment splits where more than K consecutive slots hold no point
   *  (N14). Default 4. */
  gapSplitK?: number;
  /** Max slots per segment. Default 32_768; at most 2^31 − 1 (N12). */
  segmentSlotCap?: number;
  /** Opt-in dataset version; mismatch on put → auto-clear + cacheCleared event. */
  version?: string;
  /** Initial finalized-watermark; points at t >= watermark are provisional. */
  finalizedUntil?: number;
  /** Opt-in differs-on-overlap warning (O(overlap) cost). Default false. */
  warnOnOverlapDiff?: boolean;
}
```

Timestamps are Float64 ms epoch, exact integers to 2^53, aligned to `interval` (modulo `alignmentOffset`). Presence is point-level (1 bit per point); `NaN` is a legal field value; integer fields cannot represent per-field missingness (documented limitation; the self-describing payload format leaves room for per-field masks later).

### 2.3 Read path

```ts
/**
 * Inclusive on BOTH ends (N1) — matches charting-library visible ranges
 * (Lightweight Charts setVisibleRange from/to, uPlot setScale min/max), so
 * chart.getVisibleRange() feeds get() directly. get/invalidate accept
 * arbitrary ms values and snap OUTWARD to the alignment grid (floor(start),
 * ceil(end)); put timestamps must be exactly aligned (locked). Internally
 * all range math runs on integer slot indices ((t - offset) / interval) —
 * the ms↔slot conversion is the single place fencepost logic lives.
 */
interface Range { start: number; end: number }

type MissReason = 'uncached' | 'fetch-failed' | 'auth-pending';

interface Miss {
  range: Range;
  reason: MissReason;
  /** Present for 'fetch-failed': structured-cloneable error detail. */
  error?: { name: string; message: string };
}

interface GetResult {
  /** Present points only — equal lengths, no holes, no mask. */
  timestamps: Float64Array;
  fields: Record<string, Float64Array | Float32Array | Int32Array | Uint32Array
                        | Int16Array | Uint16Array | Int8Array | Uint8Array>;
  /** Authoritative sub-ranges of the request. Absence of points inside = real gap. */
  coverage: Range[];
  /** Always present (possibly empty) — cannot be overlooked. */
  misses: Miss[];
}

interface GetOptions {
  /** Skip orchestration, return current cache state immediately. Default false (N2). */
  cacheOnly?: boolean;
}

// CacheHandle
get(range: Range, options?: GetOptions): Promise<GetResult>;
```

**Partial-result policy (locked):** `get` never rejects for data-availability reasons. With a fetcher configured, `get` awaits the (deduplicated) fetches for its miss ranges and returns the merged result; fetch failures and auth-pending ranges degrade to misses with reasons. Rejection is reserved for programmer errors (invalid range, unknown cache, disposed client). Auth-pending never blocks: affected ranges come back promptly as misses (design "y"), and the consumer re-`get`s after `updateAuth`.

Returned typed arrays are copies — never views into cache-owned memory.

### 2.4 Write path and invalidation

```ts
interface PutBatch {
  /** Sorted ascending, aligned, no duplicates — else the whole batch is rejected. */
  timestamps: Float64Array | number[];
  fields: Record<string, ArrayBufferView | number[]>;
  meta?: {
    /** Dataset version; mismatch with stored version → auto-clear + event. */
    version?: string;
    /** Advance the finalized watermark. */
    finalizedUntil?: number;
  };
}

interface PutOptions {
  /**
   * The range this data is authoritative for. Must contain all batch
   * timestamps (else PutError 'range-mismatch'). Coverage is recorded for
   * the whole range minus the volatile region — flanks without points become
   * CONFIRMED real gaps, never re-fetched; only invalidate() undoes a wrong
   * claim. Default: the batch's own span [t₀, tₙ] — safe for streaming
   * appends, claims nothing the points don't prove (N3). The orchestrated
   * path always passes the fetch's requested range automatically. A range
   * that is not on the grid snaps INWARD: it covers the grid points inside it
   * and no others (N13).
   */
  range?: Range;
}

interface MergeWarning { range: Range; fields: string[] }

interface PutResult {
  /** Non-empty only when warnOnOverlapDiff is on and overlapping values differed. */
  warnings: MergeWarning[];
}

// CacheHandle
put(batch: PutBatch, options?: PutOptions): Promise<PutResult>;
invalidate(range: Range): Promise<void>;   // coverage subtraction
clear(): Promise<void>;                    // NOTE: SharedWorker mode — affects ALL tabs
setFinalizedUntil(t: number): Promise<void>;
```

**Atomic reject (locked):** misaligned, unsorted, or duplicate timestamps reject the entire batch with a descriptive error naming the first offender and the expected alignment (`PutError`, §2.6). Merge policy is new-data-wins; the volatile region (`t >= finalizedUntil`) is excluded from coverage authority, so the live tail is always re-fetched and merged new-wins.

**What a put removes (N11):** a write that states its range — every orchestrated fetch, and a `put` with `options.range` — replaces that range: afterwards the points inside it are exactly the batch's, so a point the backend no longer returns disappears. A `put` without `range` only adds or overwrites the points it carries and never removes one.

**Restatements without a version signal are undetectable.** If the backend revises a point that the cache already holds as covered and reports no `version` change, no library mechanism can notice: the cache keeps returning the old value until the consumer calls `invalidate` over the range or `clear`. The `version` machinery only helps when the backend reports a version. (Documentation debt from starter §8, committed.)

TTL is deliberately not in core: call `invalidate`/`clear` on your own clock (a documented consumer pattern).

### 2.5 Fetcher module contract

The consumer provides a self-contained ES module (no closure over main-thread state); the worker `import()`s it. Config/auth arrives only via structured-cloneable `context`.

```ts
// What the fetcher module must export (default export):
interface Fetcher {
  fetch(req: FetchRequest): Promise<FetchResponse>;
  /** Optional: observe auth updates (e.g. swap a token held in module state). */
  updateAuth?(context: unknown): void | Promise<void>;
}

interface FetchRequest {
  cacheId: string;
  range: Range;           // already miss-coalesced (flank-extended by one interval)
  interval: number;
  alignmentOffset: number;
  context: unknown;       // latest auth/config material
}

interface FetchResponse {
  timestamps: Float64Array | number[];
  fields: Record<string, ArrayBufferView | number[]>;
  meta?: { version?: string; finalizedUntil?: number };
}

/**
 * Distinguished auth-failure signal: THROW it from fetch() (N8). Exported
 * from the 'tscache/fetcher' subpath (N6) — a ~20-line module (this class +
 * the types above, zero other imports) so fetcher bundles stay lean and pull
 * no DOM-touching client code into the worker. Detection in the orchestrator
 * is marker-based (error.code === 'tscache:auth-invalid'), NOT instanceof:
 * fetcher and worker are separate bundles and may each hold their own copy
 * of the class.
 */
declare class AuthInvalidError extends Error {
  readonly code: 'tscache:auth-invalid';
}
```

Worker-side orchestration (locked behaviors): in-flight dedup keyed per `(cacheId, range)` in the worker — one fetch serves all tabs; miss coalescing extends computed miss ranges by one interval on flanks abutting existing coverage; an `AuthInvalidError` flips the auth state, broadcasts `authInvalid` to all tabs (design "b"), pauses affected fetches, and `updateAuth(context)` from any tab delivers new material and retries them. The examples ship a copy-pasteable Web Locks snippet for refresh-token rotation safety.

Cookie-based auth needs none of this machinery — cookies flow in worker fetches natively.

### 2.6 Errors (programmer errors — these reject; see N8)

```ts
class TscacheError extends Error {}                 // base
class ConfigError extends TscacheError {}           // invalid CacheConfig / config conflict (N4)
class InvalidRangeError extends TscacheError {}     // NaN/inverted endpoints (alignment is snapped, not rejected — N1)
class UnknownCacheError extends TscacheError {}
class PutError extends TscacheError {               // atomic batch reject
  code: 'misaligned' | 'unsorted' | 'duplicate' | 'field-mismatch'
      | 'length-mismatch' | 'range-mismatch';      // range-mismatch: options.range excludes batch timestamps
  offenderIndex: number;
  offenderTimestamp?: number;
  expected?: string;     // e.g. "t ≡ 0 (mod 60000)"
}
class ProtocolMismatchError extends TscacheError {  // handshake refusal
  clientProtocol: number;
  workerProtocol: number;
}
class AuthInvalidError extends TscacheError {       // fetcher signal (canonical home: ./fetcher)
  readonly code: 'tscache:auth-invalid';            // marker for cross-bundle detection
}
```

### 2.7 Events — three scopes (N5)

One wire channel, three scopes. Subscribe via `client.on(...)` (hears everything of that type) or `cache.on(...)` (cacheId-filtered sugar for cache/request-scoped events).

```ts
/** '<clientId>:<seq>' — clientId is per-connection, so ids are unique across
    tabs; tab B can trace which tab/request originated a broadcast event. */
type RequestId = string;

interface ClientEvents {
  // ── client-scoped ──
  /** Fetcher signaled auth failure. Broadcast to ALL tabs (design "b"). */
  authInvalid: { error: { name: string; message: string } };
  /** Fallback chain stepped down (e.g. no SharedWorker on Chrome Android). */
  modeFallback: { from: HostingMode; to: HostingMode; reason: string };

  // ── cache-scoped ──
  /** Cache was cleared. In SharedWorker mode one tab's clear affects all tabs. */
  cacheCleared: { cacheId: string; reason: 'manual' | 'clear-all' | 'version-mismatch' };

  // ── request-scoped (carries originating request's id) ──
  /** Opt-in (warnOnOverlapDiff): overlapping put differed outside volatile region.
      Also console.warn in dev builds (resolved decision #8). */
  mergeWarning: { cacheId: string; requestId: RequestId; range: Range; fields: string[] };
}
```

The initiating call additionally receives request-scoped results directly — `put()` resolves with its own `warnings` (§2.4) — so the common case needs no event wiring; the event channel serves telemetry and cross-tab observability. Roadmap events slot into existing scopes: dirty-notifications → cache-scoped, fetch lifecycle → request-scoped.

`modeFallback` is an addition beyond the starter's event list — observability for the documented Chrome-Android path (accepted under N5).

## 3. RPC protocol

### 3.1 Handshake (locked)

On connect, the worker immediately reports its protocol version; the client refuses on mismatch with `ProtocolMismatchError`. Protects against package skew and stale cached worker scripts.

```ts
const PROTOCOL_VERSION = 1;

// worker → client, unprompted on connect:
{ t: 'hello', protocol: 1, lib: '0.1.0' }
// client → worker (also carries fetcher config so the worker can import it):
{ t: 'init', protocol: 1, fetcher?: { module: string, context?: unknown } }
// worker → client:
{ t: 'init-ok' } | { t: 'init-err', error: WireError }
```

### 3.2 Message envelopes

```ts
type WireError = { name: string; message: string; code?: string; data?: unknown };

// request/response (client → worker → client), id correlates; the wire id is
// the <seq> half of the public RequestId ('<clientId>:<seq>', §2.7):
{ t: 'req', id: number, op: Op, params: unknown }
{ t: 'res', id: number, ok: true,  result: unknown }
{ t: 'res', id: number, ok: false, error: WireError }

// broadcast (worker → every connected port), scope-discriminated (N5):
{ t: 'evt', scope: 'client',  event: string, payload: unknown }
{ t: 'evt', scope: 'cache',   cacheId: string, event: string, payload: unknown }
{ t: 'evt', scope: 'request', cacheId: string, requestId: string, event: string, payload: unknown }

type Op = 'cache' | 'get' | 'put' | 'invalidate' | 'clear' | 'clearAll'
        | 'setFinalizedUntil' | 'updateAuth' | 'dispose';
```

SharedWorker: one RPC server, N ports; `evt` fans out to all ports. Dedicated worker / in-process: same protocol over one port (in-process uses a direct in-memory port pair — the RPC layer is exercised even without a worker, and unit tests run against the engine beneath it).

### 3.3 Transfer semantics (locked)

`get` results: the worker copies requested slices out of cache-owned buffers, then **transfers** the copies (zero-copy move of the copy; cache-owned memory is never transferred). `put`/`FetchResponse` typed arrays are transferred into the worker where possible and are consumed — documented. No SharedArrayBuffer in v1.

### 3.4 Segment transfer payload — one format, three uses (locked invariant)

The same self-describing structure is the RPC wire format, the future IndexedDB persistence value, and the SSR hydration payload serialized into HTML. Every design change must keep all three viable.

```ts
interface DenseSegmentPayload {
  format: 1;                 // payload schema version (persistence requirement)
  layout: 'dense';           // future: 'columnar', ...
  start: number;             // aligned first-slot timestamp
  count: number;             // slot count; t_i = start + i * interval
  interval: number;
  alignmentOffset: number;
  mask: Uint8Array;          // ceil(count/8) bytes, 1 bit per slot
  fields: { name: string; dtype: Dtype; data: ArrayBuffer }[];
}
```

Settled persistence notes (roadmap §3.7): write-behind only (dirty-segment set, debounce + `pagehide` flush), volatile region excluded, coverage reconciled against actual segment presence on hydrate, `format` field mandatory.

## 4. Module layout — `packages/tscache/src`

Dependency rule: `engine/*`, `grid`, `coverage`, `segment/*` import nothing from `rpc/`, `client/`, or `orchestrator/` and contain no DOM/worker references. Arrows point at importers.

```
types.ts            public shared types (Range, Dtype, CacheConfig, GetResult, Miss, events)
errors.ts           §2.6 taxonomy
grid.ts             ms↔slot conversion — the single fencepost site (N1, N9)
coverage.ts         coverage index on slot ranges: sorted disjoint ranges, binary
                    search, splice on merge, subtraction (invalidate), miss computation
segment/
  types.ts          Segment interface: lookup / slice / mergeFrom / transferPayload
  assert.ts         programming-error checks shared by segments and the merge path
  dense.ts          DenseSegment: implicit timestamps, presence bitmask, typed arrays
  payload.ts        DenseSegmentPayload encode/decode (one-format-three-uses lives here)
engine/
  validate.ts       CacheConfig validation and defaults
  batch.ts          put validation: alignment (offset-aware), sort, dup, field/length,
                    range; converts a batch to slot terms
  merge.ts          put path: SegmentStore — segment selection, K-gap splitting, slot-cap
                    pages, new-wins merge
  overlap.ts        overlap-diff detection for the opt-in merge warning
  read.ts           read path: present-point extraction across segments, coverage
                    intersection, 'uncached' misses, ms conversion of the result
  cache.ts          CacheState: one cache's store, coverage, watermark and version;
                    put/get/invalidate/clear/setFinalizedUntil in ms
  emitter.ts        minimal typed emitter for engine events (engine/ must not import client/)
  engine.ts         Engine: caches map keyed by id, get-or-create with config conflicts (N4,
                    N20), cacheId-first ops, cacheCleared events; pure in-process API —
                    unit-test target, './engine' export surface
orchestrator/
  orchestrator.ts   miss-driven fetch loop, in-flight dedup, miss coalescing, retry-after-auth
  auth.ts           auth state machine: valid → invalid (broadcast) → updated (retry)
rpc/
  protocol.ts       PROTOCOL_VERSION, message types, (de)serialization helpers
  server.ts         worker-side shell: ports, envelope dispatch → engine/orchestrator, evt fanout
  port-client.ts    client-side port wrapper: req/res correlation, handshake, evt re-emit
client/
  client.ts         createClient: fallback chain (shared → dedicated → in-process), pinning
  cache.ts          CacheHandle facade
  events.ts         typed emitter
entries/
  index.ts          '.'        → createClient + public types/errors
  worker.ts         './worker' → SharedWorker (onconnect) + dedicated (onmessage) entry
  engine.ts         './engine' → Engine direct (SSR/Node, tests)
  fetcher.ts        './fetcher' → fetcher author surface: types + AuthInvalidError, zero other imports (N6)
```

`package.json` exports: `.`, `./worker`, `./engine` (locked) + `./fetcher` (N6, accepted 2026-06-11). ESM-only (resolved decision #6). `tsconfig` strict with `isolatedDeclarations: true`.

### 4.1 Internal contracts — `grid.ts` and `coverage.ts` (N9, approved 2026-10-03)

Internal modules: not exported from any package entry. Contract tests (step ③) pin this surface.

**Supported domain: safe integers.** Timestamps and slot indices are safe integers (|x| ≤ 2^53 − 1), so every `± 1` on a slot and every ms↔slot conversion is exact. Values outside the domain are rejected at the boundary as described below (user-confirmed 2026-10-03).

```ts
// grid.ts — every ms↔slot conversion in the codebase goes through here (N1).
/** Built from ResolvedCacheConfig: interval a positive safe integer,
 *  alignmentOffset in [0, interval). */
interface Grid { interval: number; alignmentOffset: number }
/** Inclusive on both ends; safe-integer slot indices; start <= end. Slots
 *  may be negative (timestamps before the grid origin). */
interface SlotRange { start: number; end: number }

/** True when t is a safe integer lying exactly on the grid:
 *  (t - alignmentOffset) % interval === 0 in exact integer arithmetic, for
 *  every safe-integer t (the literal floating-point expression is not the
 *  definition: its subtraction can round near ±2^53). False for anything
 *  else, including fractions, NaN and |t| >= 2^53. */
function isAligned(t: number, g: Grid): boolean;
/** Slot of an aligned timestamp. Throws RangeError if t is not aligned —
 *  callers validate first (put validation reports PutError 'misaligned'). */
function slotOf(t: number, g: Grid): number;
/** Timestamp of a slot: alignmentOffset + slot * interval. */
function msOf(slot: number, g: Grid): number;
/** get/invalidate input → slots, snapped OUTWARD: start floors to the slot at
 *  or before it, end ceils to the slot at or after it. Never narrower than the
 *  input. Throws InvalidRangeError if either endpoint is not a finite number
 *  within ±(2^53 − 1), if start > end, or if the outward snap lands on a grid
 *  point beyond ±(2^53 − 1). start === end is legal (one slot if aligned,
 *  else two). */
function snapOut(r: Range, g: Grid): SlotRange;
/** put's options.range → slots, snapped INWARD (N13): the grid points lying
 *  inside r, or undefined when there is none. Never wider than the input,
 *  so unlike snapOut it cannot land beyond ±(2^53 − 1). Throws
 *  InvalidRangeError if either endpoint is not a finite number within
 *  ±(2^53 − 1) or if start > end. */
function snapIn(r: Range, g: Grid): SlotRange | undefined;
/** Slot range → inclusive ms Range (GetResult.coverage and misses). */
function toMs(r: SlotRange, g: Grid): Range;
/** First slot whose timestamp is at or after t (the watermark's slot: points
 *  at t >= finalizedUntil are provisional, §2.4). Throws InvalidRangeError
 *  if t is not a finite number within ±(2^53 − 1), or if that slot's
 *  timestamp would not be a safe integer. */
function slotAtOrAfter(t: number, g: Grid): number;

// coverage.ts — one index per cache; slot ranges only, no ms arithmetic.
class CoverageIndex {
  /** Record r as authoritative. Overlapping AND adjacent ranges merge
   *  (a.end + 1 === b.start: no slot lies between them). */
  add(r: SlotRange): void;
  /** Forget r (invalidate). May split one range into two; subtracting an
   *  uncovered range is a no-op. */
  subtract(r: SlotRange): void;
  /** Covered sub-ranges of r, ascending, each clipped to r. */
  covered(r: SlotRange): SlotRange[];
  /** Uncovered sub-ranges of r, ascending, each clipped to r. covered(r) and
   *  gaps(r) are disjoint and together tile r exactly. */
  gaps(r: SlotRange): SlotRange[];
  /** Copy of the index: sorted, disjoint, no two adjacent. Mutating the
   *  result does not affect the index. */
  ranges(): SlotRange[];
  clear(): void;
}
```

Ownership: `CoverageIndex` never shares range objects with its callers. It does not keep an object passed to it, and `covered()`, `gaps()` and `ranges()` return fresh objects, so callers may mutate or keep results freely.

`CoverageIndex` methods throw `RangeError` for a malformed `SlotRange` (endpoints that are not safe integers, or start > end): a programming error, never reachable from consumer input, which `snapOut`/`slotOf` validate. Out of step ③ by design: excluding the volatile region (`t >= finalizedUntil`) from coverage is the engine's job (step ⑦); flank coalescing of misses is the orchestrator's (step ⑪).

### 4.2 Internal contracts — `segment/` (N10, N11, approved 2026-10-04)

Internal modules: not exported from any package entry. Contract tests (step ④) pin this surface. Code outside `segment/` depends only on the `Segment` interface. Segments work in slot terms and do no ms arithmetic of their own; the payload's `start` goes through `grid.ts`.

```ts
// segment/types.ts
/** Present points only, in slot terms: every field array has slots.length
 *  elements; slots are strictly ascending safe integers. */
interface Columns {
  slots: Float64Array;
  fields: Record<string, FieldArray>;
}

interface Segment {
  /** First to last PRESENT slot (tight); undefined when no point is present. */
  readonly extent: SlotRange | undefined;
  /** Number of present points. */
  readonly size: number;

  /** The point at slot as a fresh { field name → value } object holding
   *  exactly the schema's fields, or undefined if no point is present there
   *  (including outside the extent). A present point whose value is NaN is
   *  returned: presence is per point, not per value. */
  lookup(slot: number): Record<string, number> | undefined;

  /** The present points inside range, as fresh arrays (never views into the
   *  segment): one array per schema field, of that field's dtype. The range
   *  may reach beyond the extent; an empty result has zero-length arrays. */
  slice(range: SlotRange): Columns;

  /** Write points in; new values win over old ones at the same slot.
   *  - Without authority (upsert): each point becomes present with its
   *    values; nothing else changes.
   *  - With authority (replace): afterwards the present points inside
   *    authority are exactly `points`; points outside it are unchanged.
   *    Empty `points` with an authority clears that range.
   *  Values are stored by typed-array assignment into the field's dtype.
   *  The input arrays are copied, not kept. */
  mergeFrom(points: Columns, authority?: SlotRange): void;

  /** A self-describing copy of the whole segment (§3.4), in fresh buffers
   *  that share nothing with the segment, so it is safe to transfer. */
  transferPayload(): DenseSegmentPayload;
}

// segment/dense.ts
class DenseSegment implements Segment {
  /** Empty at construction. fields and slotCap come from ResolvedCacheConfig. */
  constructor(options: { grid: Grid; fields: Readonly<Record<string, Dtype>>; slotCap: number });
}

// segment/payload.ts
/** Rebuilds a segment from a payload, copying its buffers. */
function segmentFromPayload(
  payload: DenseSegmentPayload,
  options: { grid: Grid; fields: Readonly<Record<string, Dtype>>; slotCap: number },
): Segment;
```

Rules:

- **Slot cap.** `slotCap` is a positive integer up to 2^31 − 1 (N12); the constructor throws `RangeError` otherwise. `mergeFrom` throws `RangeError` if the extent after the merge would span more than `slotCap` slots. Where to split (gap-split K, segment selection) is merge-path policy (step ⑤); the segment only refuses to exceed its own limit. A segment grows in either direction.
- **Atomic.** `mergeFrom` validates, and allocates any buffers it needs, before it mutates; when it throws, including on an allocation failure, the segment is unchanged.
- **Programming errors** throw `RangeError`: a slot or range that is not made of safe integers or has start > end; `points` whose slots are not strictly ascending safe integers, whose field names are not exactly the schema's, or whose field arrays differ in length from `slots`; a point outside `authority`; `transferPayload()` on an empty segment. None is reachable from consumer input, which put validation rejects first.
- **Payload layout.** `start` is the timestamp of `extent.start`; `count` is the extent's slot count; `mask` is a `Uint8Array` of exactly `ceil(count / 8)` bytes in which slot `i` of the extent is bit `i & 7` of byte `i >> 3`, with unused trailing bits zero; `fields` follows the schema's declaration order, each `data` an `ArrayBuffer` of exactly `count × bytes-per-element`, with the values of absent slots zero. Equal segments therefore produce equal payloads. Field data is little-endian, which is the native order of every supported platform; no byte swapping is done. The payload is a plain structured-cloneable object.
- **Decoding.** `segmentFromPayload` throws `TscacheError` with a descriptive message for an invalid payload: `format` other than 1, `layout` other than `'dense'`, `interval` or `alignmentOffset` differing from the grid, `start` not aligned, `count` not a positive safe integer or greater than `slotCap`, a mask of the wrong type or length or with trailing bits set, fields that do not match the schema's names and dtypes with correctly sized buffers, or a `start` and `count` whose last slot has no safe-integer timestamp. Field entries may come in any order (a schema declared in a different key order names the same fields); re-encoding restores schema order. Values stored under absent mask bits are ignored, since presence is decided by the mask alone; re-encoding writes zeros. The decoded segment's extent is the tight bounds of the present points, and `segmentFromPayload(s.transferPayload(), …)` is equal to `s` in every observable way.

Out of step ④ by design: gap-split K and segment selection (step ⑤), the overlap-difference warning (step ⑤ builds it from `slice`, so it costs nothing when off), ms conversion of results and concatenation across segments (step ⑥).

### 4.3 Internal contracts — put path (N13–N15, approved 2026-10-05)

Internal modules: not exported from any package entry. Contract tests (step ⑤) pin this surface. Both work in slot terms; the only ms arithmetic is the calls into `grid.ts`.

```ts
// engine/batch.ts
/** Validates a consumer batch against the cache's config and converts it to
 *  slot terms. Rejects the whole batch (§2.4) by throwing; never mutates or
 *  keeps its input. `authority` is the inward snap of `range` (N13), and
 *  undefined when no range was given or the range holds no grid point. */
function validateBatch(
  batch: PutBatch,
  config: ResolvedCacheConfig,
  range?: Range,
): { points: Columns; authority: SlotRange | undefined };

// engine/merge.ts
/** A merge warning in slot terms; the engine converts it to a MergeWarning. */
interface SlotWarning { range: SlotRange; fields: string[] }

/** All the segments of one cache. */
class SegmentStore {
  constructor(config: ResolvedCacheConfig);
  /** Ascending by extent, disjoint, none empty, in the layout defined below. */
  readonly segments: readonly Segment[];
  /** Merges validated points in; new values win. Without authority it only
   *  adds or overwrites; with authority the present points inside it end up
   *  exactly `points` (N11). Returns the overlap warnings, always empty when
   *  `warnOnOverlapDiff` is off. */
  put(points: Columns, authority?: SlotRange): SlotWarning[];
  /** Drops every segment. */
  clear(): void;
}
```

Rules for `validateBatch`:

- **Order of checks.** (1) The batch is an object whose `timestamps` is a `number[]` or a `Float64Array`, and whose `fields` is an object with exactly the schema's field names, each a `number[]` or a typed array other than a BigInt one (a `DataView` is not accepted; arrays made in another realm, such as an iframe, are recognized): otherwise `PutError` `'field-mismatch'`. (2) Every field array has as many elements as `timestamps`: otherwise `'length-mismatch'`. (3) Timestamps are scanned once in order, and the first offender is reported with its index and value: a timestamp that is not on the grid is `'misaligned'` (with `expected`, e.g. `"t ≡ 0 (mod 60000)"`); otherwise one equal to its predecessor is `'duplicate'` and one below it is `'unsorted'`. Anything that is not an aligned safe integer, including `NaN` and a non-number, is `'misaligned'`; a non-number offender is reported by index only, without `offenderTimestamp`. (4) With a `range`: a malformed range throws `InvalidRangeError` (as `snapOut`), and the first timestamp outside it is `'range-mismatch'`. Structural rejects (1) and (2) have no offending timestamp and carry `offenderIndex: -1`. Error messages never call a value's own string conversion, so a hostile value (a symbol, a null-prototype object) still produces the documented error.
- **Values.** Each field is copied into a fresh array of the schema's dtype by typed-array assignment, whatever kind of array it arrived in, so `1.5` given for an `i32` field is stored as `1`. Values are not otherwise validated; `NaN` is legal. An element that cannot be converted to a number at all (a symbol, or an object whose conversion throws) rejects the batch as `'field-mismatch'`.
- **Empty batch.** Zero timestamps is legal. With a range it states that the range holds no points; without one it does nothing.
- **Not here.** `meta` (`version`, `finalizedUntil`) is validated and applied in step ⑦.

Rules for `SegmentStore`:

- **Layout (N14, N15).** With `K = gapSplitK` and `cap = segmentSlotCap`, the page of slot `s` is `floor(s / cap)`. Two present points with no present point between them share a segment exactly when they are on the same page and at most `K` slots between them hold no point. The layout is therefore a function of which points are present, whatever order they arrived in, and it holds after every `put`: a replace that opens a gap wider than `K` splits a segment, and a point that closes one joins two. No segment spans more than `cap` slots. Each segment is built with `slotCap = cap`.
- **Overlap warning.** When `warnOnOverlapDiff` is on, a batch point *differs* if a point was already present at its slot and at least one field's stored value changes; values are compared after conversion to the field's dtype, and two values are equal when `a === b` or both are `NaN`. Each maximal run of batch points that are consecutive in the batch and all differ yields one warning: `range` from the first to the last slot of the run, `fields` the names that differed anywhere in the run, in schema order. A point that a replace removes is not a difference. When the option is off no comparison is made. Excluding the volatile region from warnings is step ⑦.
- **Programming errors** throw `RangeError` before anything changes: the same malformed `points` and `authority` that `Segment.mergeFrom` rejects (§4.2). None is reachable through `validateBatch`.
- **Allocation failure.** Segments are updated in place, so a `put` that fails because memory cannot be allocated may be left half done. It works in steps, each of which either completes or changes nothing: first, for a replace, the old points inside the authority are removed; then the batch goes in one run of points at a time (a run is a stretch of the batch that shares a segment). After a failure the store is therefore still well formed (ascending, disjoint, no empty segment) and in the layout above — the one exception is a replace that cleared the middle of a segment and then could not allocate the split — and no slot outside the put's range has changed. The engine records coverage only after `put` returns, and when `put` throws it must also withdraw any coverage it already held for the put's range (step ⑦), so a half-written range is refetched and never trusted. Rejected: copying every touched segment first, which would cost a full segment copy on each live-tail append.

Out of step ⑤ by design: coverage recording, the watermark and version handling (step ⑦); converting warnings to ms and emitting `mergeWarning` (step ⑧).

### 4.4 Internal contracts — read path (N16, approved 2026-10-06)

Internal module: not exported from any package entry. Contract tests (step ⑥) pin this surface. Input is in slot terms; the result is the consumer's `GetResult` (§2.3), so this is where slots become milliseconds again, through `grid.ts`.

```ts
// engine/read.ts
/** The present points of `segments` inside `range`, concatenated ascending,
 *  as fresh arrays (never views): one per field of `fields` (the cache's
 *  schema), of that field's dtype, so the result has the schema's shape
 *  even when there is no segment. Segments are the store's: ascending and
 *  disjoint. */
function collect(
  segments: readonly Segment[],
  range: SlotRange,
  fields: Readonly<Record<string, Dtype>>,
): Columns;

/** Assembles a GetResult for a request already snapped to slots. */
function read(
  request: SlotRange,
  segments: readonly Segment[],
  coverage: CoverageIndex,
  grid: Grid,
  fields: Readonly<Record<string, Dtype>>,
): GetResult;
```

Rules:

- **What is returned (N16).** Every present point inside the request, whether or not its slot is covered: `timestamps` are their slots in ms (`msOf`), ascending; `fields` holds one array per schema field, same length. The live tail (volatile region, never covered) and points whose coverage was invalidated but not yet refetched are therefore returned too; `coverage` says which parts are authoritative.
- **Coverage and misses.** `coverage` is `coverage.covered(request)` in ms (`toMs`), ascending; `misses` is `coverage.gaps(request)` in ms, ascending, each with `reason: 'uncached'` and no `error`. They tile the request exactly: every slot of the request is in exactly one of them, and both are independent of which points are present: a covered stretch without points is still coverage (a confirmed gap), and a request with no points and no coverage yields zero-length arrays, `coverage: []` and `misses: [request in ms]`.
- **Fresh results.** Arrays and range objects in the result share nothing with the segments or the index; mutating a result changes nothing.
- **Programming errors** throw `RangeError` for a malformed `request` (not safe integers, start > end), as the store does. None is reachable from consumer input: `snapOut` validates first.
- **Not here.** Snapping the consumer's ms range outward is the engine's job (step ⑧); excluding the volatile region from the coverage passed in is the engine's job (step ⑦), as is the version check; miss reasons other than `'uncached'` are set by the orchestrator (step ⑪), which rewrites the misses of a request after fetching.

### 4.5 Internal contracts — per-cache state (N17, N18, approved 2026-10-06)

Internal module: not exported from any package entry. Contract tests (step ⑦) pin this surface. `CacheState` is one cache: its resolved config, a `SegmentStore`, a `CoverageIndex`, the finalized watermark and the dataset version. It speaks milliseconds to its callers and slots to the modules beneath it; every conversion goes through `grid.ts`. Step ⑧'s `Engine` is a map of these plus events.

```ts
// engine/cache.ts
interface CachePutResult {
  /** In ms, outside the volatile region only. */
  warnings: MergeWarning[];
  /** True when a version mismatch cleared the cache before this put. */
  cleared: boolean;
}

class CacheState {
  constructor(config: ResolvedCacheConfig);
  readonly config: ResolvedCacheConfig;
  /** The dataset version in force: config.version, then whatever puts report. */
  readonly version: string | undefined;
  /** Points at t >= finalizedUntil are provisional; undefined: nothing is. */
  readonly finalizedUntil: number | undefined;

  put(batch: PutBatch, options?: PutOptions): CachePutResult;
  get(range: Range): GetResult;
  invalidate(range: Range): void;
  clear(): void;
  setFinalizedUntil(t: number): void;
}
```

Rules:

- **Volatile region (§2.4, starter §3.3).** `volatileFrom = slotAtOrAfter(finalizedUntil)`; with no watermark there is no volatile region. Coverage is excluded **when it is recorded**: a put records `[claim.start, min(claim.end, volatileFrom − 1)]`, where `claim` is the put's authority (N13) or, without a range, the batch's span (N3); nothing is recorded if that is empty. Slots that were provisional when fetched are therefore never covered, and when the watermark later moves forward they are fetched once more, which is the point: provisional data may have changed. Rejected: excluding the volatile region when coverage is read, which would promote stale provisional points to authoritative the moment the watermark passes them.
- **Moving the watermark.** `setFinalizedUntil(t)` sets it exactly. Moving it **backwards** subtracts coverage from the new `volatileFrom` onward (those points are provisional again); moving it forwards subtracts nothing. `t` is validated as `slotAtOrAfter` does, throwing `InvalidRangeError`. `put` with `meta.finalizedUntil` only ever **advances** the watermark (N17): a value at or below the current one is ignored, so fetch responses that arrive out of order cannot pull it back.
- **Version (starter §3.3).** `version` starts as `config.version`. A put whose `meta.version` differs from a **set** `version` first clears the cache (segments and coverage, as `clear()` does), then adopts the new version and applies the put; the result's `cleared` is true and the engine emits `cacheCleared` with `reason: 'version-mismatch'` (step ⑧). When `version` is unset, the first `meta.version` seen is adopted without clearing (N18). A put without `meta.version` never triggers any of this; in particular a restatement from a backend that reports no version is undetectable (§2.4), and only `invalidate` or `clear` recovers from it. `meta` must be an object when present, `meta.version` a non-empty string and `meta.finalizedUntil` a timestamp `slotAtOrAfter` accepts; otherwise `PutError` `'field-mismatch'` with `offenderIndex: -1`, raised after the batch's own checks and before anything changes.
- **A response's own watermark bounds its authority (N19).** When a put carries `meta.finalizedUntil`, it is authoritative only for slots below `slotAtOrAfter(meta.finalizedUntil)`: its replace authority (N11) and its coverage claim are clipped there, and its points at or beyond that slot are merged new-wins but neither replace anything nor record coverage. A response that arrives late with an older watermark therefore cannot delete, or confirm as a gap, a point it itself called provisional. A put without `meta.finalizedUntil` keeps its full authority.
- **Order inside `put`.** Validate the batch (so a rejected batch never clears anything) → version check and clear → `store.put` → advance the watermark → record coverage. If `store.put` throws (an allocation failure, §4.3), nothing is recorded, the coverage the put would have recorded is subtracted so a half-written range is refetched, and the error is rethrown.
- **Warnings** come back in ms, dropping any inside the volatile region (§2.4), judged against the watermark **after** this put's `meta.finalizedUntil` has been applied: a response that declares points final also vouches for the differences it found there. A warning range that straddles `volatileFrom` is clipped to end at `volatileFrom − 1`; its `fields` are kept as reported for the whole run.
- **`get`** snaps the range outward (N1) and returns `read()` over the store and the index; since the index never holds volatile slots, no further filtering is needed. **`invalidate`** snaps outward and subtracts; the points stay (N16). **`clear`** drops segments and coverage and keeps config, version and watermark, which describe the dataset rather than its contents.
- **Errors.** `get`/`invalidate` throw `InvalidRangeError` for a malformed range (as `snapOut`), `setFinalizedUntil` as `slotAtOrAfter` does; `put` throws as `validateBatch` does; a `config.finalizedUntil` that `slotAtOrAfter` rejects makes the constructor throw `ConfigError`. Nothing is changed by a call that throws, except the recorded coverage withdrawal above.

Out of step ⑦ by design: the caches map, `clearAll`, config conflicts (N4) and event emission (step ⑧); orchestration (step ⑪).

### 4.6 Internal contracts — engine assembly (N20–N22, approved 2026-10-07)

`Engine` is the `./engine` export surface (SSR/Node, tests) and what the RPC server (step ⑨) drives. Contract tests (step ⑧) pin this surface. It is a map of `CacheState` (§4.5) keyed by cache id, with the cache-scoped events; it speaks milliseconds and consumer types only. Zero DOM/worker imports at module top level (locked, §2.1).

```ts
// engine/emitter.ts
/** Minimal typed emitter: on() returns the unsubscribe; listeners added or
 *  removed during emit do not affect that emit; a throwing listener does
 *  not stop the others (the first error is rethrown after all ran). */
class Emitter<Events extends object> {
  on<E extends keyof Events>(event: E, fn: (payload: Events[E]) => void): () => void;
  off<E extends keyof Events>(event: E, fn: (payload: Events[E]) => void): void;
  emit<E extends keyof Events>(event: E, payload: Events[E]): void;
}

// engine/engine.ts
interface EngineEvents {
  /** Cache-scoped (N5). */
  cacheCleared: { cacheId: string; reason: 'manual' | 'clear-all' | 'version-mismatch' };
}

class Engine {
  /** Get-or-create (N4, N20). Returns the resolved config in force. */
  cache(config: CacheConfig): ResolvedCacheConfig;
  has(cacheId: string): boolean;
  /** Current state only: no orchestration (that is step ⑪). */
  get(cacheId: string, range: Range): GetResult;
  put(cacheId: string, batch: PutBatch, options?: PutOptions): PutResult;
  invalidate(cacheId: string, range: Range): void;
  clear(cacheId: string): void;
  clearAll(): void;
  setFinalizedUntil(cacheId: string, t: number): void;
  on<E extends keyof EngineEvents>(event: E, fn: (e: EngineEvents[E]) => void): () => void;
  off<E extends keyof EngineEvents>(event: E, fn: (e: EngineEvents[E]) => void): void;
}
```

Rules:

- **Get-or-create (N20).** `cache(config)` first resolves the config (`resolveCacheConfig`, so a bad config throws `ConfigError` before the map is touched). With no cache under that id, a `CacheState` is created from it. With one, the resolved **structural** fields must equal the live ones: `interval`, `alignmentOffset`, `fields` (same names and dtypes; key order irrelevant), `gapSplitK`, `segmentSlotCap`, `warnOnOverlapDiff`; any difference throws `ConfigError` naming the field, and the live cache is untouched. `version` and `finalizedUntil` describe the dataset, not the structure: they apply only when the cache is created and are **ignored** when joining an existing cache, so a tab from an older deploy can neither clear nor rewind the live cache. The return value is the resolved config the cache was **created** with (`CacheState.config`): it carries the creation-time `version` and `finalizedUntil`, while the current ones are observable through behaviour (and, for the RPC layer, through `CacheState` — the engine exposes no getters for them in step ⑧).
- **Unknown id.** Every method that takes a `cacheId`, except `has`, throws `UnknownCacheError` for an id without a cache, before validating anything else; `has` answers `false`.
- **Delegation.** `get`, `put`, `invalidate`, `setFinalizedUntil` delegate to the `CacheState` and keep its errors and results; `put` returns `{ warnings }` (§2.4) and, when the state reports `cleared`, emits `cacheCleared` with `reason: 'version-mismatch'` **after** the put has been applied. `clear(id)` clears that cache and emits `'manual'`.
- **`clearAll` (N22).** Clears every cache's data and coverage and emits `cacheCleared` with `reason: 'clear-all'` for each, in creation order; the caches themselves, their configs, versions and watermarks stay, so handles in every tab remain valid. An engine with no caches emits nothing.
- **Events (N21).** The engine emits only cache-scoped events. Request-scoped `mergeWarning` (requestId `clientId:seq`, §2.7) is emitted by the RPC server from `put`'s return value (step ⑨); the engine never carries request identity. Listeners run synchronously inside the emitting call, after the state change they describe.
- **No DOM, no worker, no timers** at module top level or in any method: the module is importable and usable in Node.

Out of step ⑧ by design: orchestration and `cacheOnly` (step ⑪ — until then every `get` is cache-only), RPC envelopes and request ids (step ⑨), `updateAuth`/`dispose` (client and worker layers).

## 5. Testing hooks (how this layout maps to the locked strategy)

- Vitest/Node against `engine/`, `coverage`, `segment/` directly (~90% of logic), plus RPC protocol over an in-memory port pair; property-style tests for coverage merge/subtraction and segment merge.
- Vitest browser mode (single page): worker construction, fallback chain, transferable round-trips.
- Playwright (one `BrowserContext`, multiple pages → shared SharedWorker): cross-tab dedup, `authInvalid` broadcast + Web Locks recovery, version-mismatch clear propagation, tab death mid-fetch.
- mitata micro-benches: coverage binary search, dense merge, payload transfer; Vitest bench for regression gating.

## 6. Decision register — locked (starter §3, unchanged)

Summary pointers only; the starter text is normative: coverage separated from data · sorted-array coverage index · authoritative-response semantics minus volatile region · `Segment` interface day one, DenseSegment v1, ColumnarSegment fast-follow · K-gap split, size-capped self-describing segments · `finalizedUntil` watermark · `invalidate`/`clear`/`clearAll` · opt-in `version` auto-clear · TTL rejected · SharedWorker→Worker→in-process with pinning · one engine three hostings · same-origin only · transferables, no SAB · protocol handshake · pull primitive + worker orchestration · fetcher via dynamic import, cloneable context · in-flight dedup + flank coalescing · auth design (b) + design (y) · present-points-only read shape · never-reject-for-availability · one-format-three-uses.

### 6.1 Coverage index — rejected alternatives (doc-debt, committed)

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **Sorted disjoint array + binary search** (chosen) | O(log n) lookup, O(n) splice with tiny n (tens of ranges), trivially serializable, easy to property-test | O(n) insert/remove worst case | n stays small by construction (ranges merge aggressively; real gaps don't split coverage) — array wins on simplicity |
| Interval tree | O(log n) insert/stab | Pointer-heavy, allocation churn, serialization cost, complexity unjustified at n≈10–100 | rejected |
| Skip list | O(log n) ops, ordered iteration | Same complexity objection; probabilistic structure harder to test deterministically | rejected |

### 6.2 Auth designs compared (doc-debt, committed)

| Design | Mechanism | Pros | Cons | Status |
|---|---|---|---|---|
| (a) initiating-tab-only | Only the tab whose `get` hit the 401 is told | Minimal noise | Other tabs stay silently stale; duplicate refresh attempts | rejected |
| **(b) broadcast to all tabs** | `authInvalid` event fans out; any tab may `updateAuth` | Simple, no election; Web Locks snippet dedupes refresh | Possible thundering-herd without the lock | **v1** |
| (c) worker-elected handler | Worker elects one tab to refresh, fails over on tab death | Cleanest UX at scale | Election + failover complexity | roadmap |

## 7. Resolved open decisions (starter §9 — user-confirmed 2026-06-11)

| # | Decision | Resolution |
|---|---|---|
| 1 | Name / scope / license | `tscache`, unscoped (npm name verified free), MIT |
| 2 | Default interval | **Required, no default** — deviates from starter proposal (60 000 ms): a silent default produces misalignment rejects far from the cause; one explicit line per cache is cheap |
| 3 | Alignment anchor | per-cache `alignmentOffset`, default 0 |
| 4 | Gap-split / slot cap | K = 4, cap = 32 768 (both per-cache configurable) |
| 5 | Changelog | git-cliff |
| 6 | Module format | ESM-only |
| 7 | Examples mapping | starter §7 table confirmed |
| 8 | Overlap warning | emitted `mergeWarning` event + `console.warn` in dev builds |

## 8. New decision points — RESOLVED (user-confirmed 2026-06-11)

These emerged while making the API concrete (N9–N22 later, at steps ③–⑧) (working process §2.3: alternatives presented, user decided).

| # | Decision | Resolution |
|---|---|---|
| N1 | Range endpoint semantics | **Inclusive `[start, end]`** — matches charting-library visible ranges (Lightweight Charts `setVisibleRange`, uPlot `setScale` min/max; verified against current docs), so chart ranges feed `get` directly. Unaligned `get`/`invalidate` inputs **snap outward** to the grid (floor start, ceil end — invalidate over-invalidates conservatively). Internal range math runs on integer slot indices; the ms↔slot conversion is the one fencepost site. Rejected: half-open `[start, end)` (cleaner splicing, but every chart consumer would need ±interval shims) |
| N2 | `get` orchestration | With a fetcher configured, `get` **awaits the deduplicated fetches** for its misses (machine-speed waits only; auth-pending/failures degrade to misses immediately). `{ cacheOnly: true }` skips orchestration. Rejected: fire-and-forget + immediate partials — forces consumers into re-poll loops |
| N3 | `put` authority range | `options.range` optional; **default = batch's own span `[t₀, tₙ]`** (safe, streaming-friendly). Explicit range (validated to contain all points) claims flank emptiness as confirmed real gaps. Orchestrated path passes the fetch's requested range automatically. Rejected: always-required range (ceremony) |
| N4 | `cache()` config conflict | **Get-or-create; structural mismatch rejects** with `ConfigError`; identical config returns existing cache. All tabs are expected to request identical config. Rejected: last-writer-wins reconfigure (silently destructive cross-tab) |
| N5 | Event surface | **Three scopes** — client (`authInvalid`, `modeFallback`), cache (`cacheCleared`), request (`mergeWarning` with `requestId = '<clientId>:<seq>'`, unique across tabs). Wire envelope carries a scope discriminator; `cache.on(...)` is cacheId-filtered sugar; initiating calls also get request-scoped results directly (`put()` returns its warnings). `modeFallback` addition accepted |
| N6 | `./fetcher` subpath | **Added** to the export list. Tiny module (AuthInvalidError + fetcher types, zero other imports) — lean fetcher bundles, no DOM-code-in-worker hazard. Auth-error detection is marker-based (`error.code === 'tscache:auth-invalid'`), never `instanceof` (separate bundles duplicate class identity) |
| N7 | Dtype set | `f64 f32 i32 u32 i16 u16 i8 u8`. Excluded: `i64/u64` (BigInt interop friction — roadmap if demanded), `f16` (patchy 2026 support). Self-describing format makes additions non-breaking |
| N8 | Auth-failure signal | Fetcher **throws `AuthInvalidError`** (idiomatic, composes with fetch wrappers). Rejected: result code on `FetchResponse` (bifurcates return shape). Single mechanism only |
| N9 | Grid and coverage internals | **`grid.ts` holds every ms↔slot conversion** (`isAligned`, `slotOf`, `msOf`, `snapOut`, `toMs`); `coverage.ts` works on integer slot ranges only. Internal contract in §4.1. Rejected: conversion inside `coverage.ts` (no doc change, but two concerns in one module and the single-site rule harder to verify). User-confirmed 2026-10-03 |
| N10 | Segment internals | **`Segment` interface in slot terms** (`extent`, `size`, `lookup`, `slice`, `mergeFrom`, `transferPayload`) with `DenseSegment` and `segmentFromPayload`; contract in §4.2. The segment enforces the slot cap; split policy stays in the merge path. An invalid payload throws plain **`TscacheError`** (rejected: a new `PayloadError` class, which would add to §2.6). Field data is **little-endian, documented, no byte swapping** (rejected: explicit conversion on every transfer for platforms that do not exist in practice). User-confirmed 2026-10-04 |
| N11 | What a put removes | **Replace only when the range is explicit** (chosen provisionally on 2026-10-04 and confirmed as final at step ⑤, 2026-10-05). An orchestrated fetch or a `put` with `options.range` replaces that range; a `put` without `range` only adds or overwrites. Rejected: always replace the batch's span (a sparse pushed batch would delete the points between its ends, which the cache cannot refetch because the span is marked known); never remove (a point deleted upstream could not be removed short of `clear()`). Consequences for fetcher authors, to document at step ⑪: a response must be complete for the requested range, so a fetcher against a paginated API loops until it has all of it; and because a slot returned without a point is cached as a confirmed gap and never refetched, a fetcher for a backend that publishes late must report `finalizedUntil` so data that is not final yet stays provisional. **Design intent recorded with this decision:** the primary envisioned use is data that never changes once returned (OHLC candles from a trading system feeding a chart). The purpose of the cache is to avoid refetching; refetching to overwrite is acceptable only in specific scenarios (live tail, explicit invalidation, version change). Replacement adds no fetches: it only governs what happens to old points when a fetch or ranged put occurs anyway. User-confirmed 2026-10-04 |
| N12 | Upper bound on `segmentSlotCap` | **At most 2^31 − 1**; a larger value is rejected with `ConfigError`. The presence mask is indexed with 32-bit integer arithmetic, which is exact only below 2^31 slots, and a segment that large (over 2 GB per field) could not be used anyway. Rejected: a lower practical limit such as 2^24 (an arbitrary number to defend); no limit with division-based indexing (slower on the hottest loops and not testable without a 2 GB allocation). User-confirmed 2026-10-04 |
| N13 | Unaligned `put` range | **Snaps inward**: `options.range` covers the grid points inside it and no others (`snapIn` in `grid.ts`); a range holding no grid point claims nothing. `get`/`invalidate` snap outward because reading or forgetting too much is safe; claiming too much is not, since a claimed slot without a point is a confirmed gap that is never refetched. Rejected: snap outward (consistent with `get`, but vouches for slots the caller never named); reject an unaligned range (unambiguous, but every caller passing a chart range must align it first). User-confirmed 2026-10-05 |
| N14 | How the K gap is counted | **A segment splits where more than K consecutive slots hold no point.** With K = 4 at one minute, 10:00 and 10:05 (four absent) share a segment; 10:00 and 10:06 (five absent) do not. Rejected: split when the two points are more than K intervals apart (tolerates K − 1 absent slots; reads less naturally as "a gap of K"). User-confirmed 2026-10-05 |
| N15 | How the slot cap is applied | **Fixed pages**: a segment never crosses a multiple of `segmentSlotCap`. The layout then depends only on which points are present, so tests can state it exactly, equal data persists as equal payloads, and prepending history never reshuffles later segments. Cost: a short run that straddles a page edge is two segments. Rejected: fill a segment to the cap, then open the next (fewer segments in the straddling case, but the layout depends on arrival order). User-confirmed 2026-10-05 |
| N16 | What `get` returns | **Every present point in the request**, covered or not; `coverage` marks the authoritative parts. Needed for the live tail, whose slots are never covered yet whose last candle must show, and it keeps an invalidated range on screen until the refetch replaces it. Rejected: only points inside coverage (nothing stale ever shows, but the volatile region would need a special case and an invalidated range would go blank until refetched). User-confirmed 2026-10-06 |
| N17 | `meta.finalizedUntil` direction | **Forwards only**: a put's `meta.finalizedUntil` advances the watermark and a lower value is ignored, so fetch responses arriving out of order cannot pull it back and drop coverage. `setFinalizedUntil()` can still move it either way. Rejected: set exactly from `meta` (simpler rule, order-dependent result). User-confirmed 2026-10-06 |
| N18 | First version seen by an unversioned cache | **Adopt without clearing**: when `config.version` is unset, the first `meta.version` a put reports becomes the cache's version and existing data is kept; later mismatches clear. The starter's "inert when unset" holds, since nothing is cleared, while a backend that reports a version still protects the cache. Rejected: ignore it (a reported version could never protect an unversioned cache); treat it as a mismatch (wipes the cache on the first versioned response). User-confirmed 2026-10-06 |
| N19 | Authority of a response with its own watermark | **Clipped to its own watermark**: a put carrying `meta.finalizedUntil` replaces and covers only slots below it; points at or beyond are upserted. Raised by the step ⑦ adversarial review: a late empty response reporting an older watermark would otherwise delete a provisional point and record it as a confirmed gap. Rejected: discard responses with an older watermark (throws away valid final data and can loop against a backend whose watermark lags); apply as is (weakest). Companion decision for step ⑪: the orchestrator stamps requests with the cache's version generation and drops responses from before the last version change, so a late old-version response cannot clear fresh data. User-confirmed 2026-10-06 |
| N20 | Scope of the `cache()` config conflict | **Every resolved field except the dataset ones must match**: `interval`, `alignmentOffset`, `fields`, `gapSplitK`, `segmentSlotCap`, `warnOnOverlapDiff` (they shape the layout or cross-tab behaviour) → `ConfigError` on mismatch. `version` and `finalizedUntil` apply at creation only and are ignored by a joining tab, so a stale tab cannot clear or rewind the live cache. Rejected: grid and schema only, rest first-creator-wins (a tab asking for warnings would silently get none); everything must match (tabs started minutes apart with a moving `finalizedUntil` would reject each other). User-confirmed 2026-10-07 |
| N21 | Who emits `mergeWarning` | **The RPC server, from `put`'s result**: it knows the request id. The engine emits only cache-scoped `cacheCleared`; in-process callers get warnings from `put()` directly. Rejected: the engine with a made-up `engine:<seq>` id (carries request identity it does not need). User-confirmed 2026-10-07 |
| N22 | `clearAll` | **Empties every cache and keeps the configs**, emitting `cacheCleared 'clear-all'` per cache; handles in every tab stay valid. Rejected: dropping the caches (live handles would fail with `UnknownCacheError` until each tab calls `cache()` again). User-confirmed 2026-10-07 |

## 9. What happens after sign-off

Implementation follows the starter §11 commit plan (① scaffolding → ⑭ docs), each step green under `bun run ci`, hybrid TDD (strict test-first for `coverage`/`segment`/`engine`; pragmatic for scaffolding, RPC wiring, examples). Documentation debts (starter §8) ship with their related steps; this document seeds `docs/` and is updated only through review.
