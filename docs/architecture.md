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
  /** Dense segment splits when an internal gap exceeds K intervals. Default 4. */
  gapSplitK?: number;
  /** Max slots per segment. Default 32_768. */
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
   * path always passes the fetch's requested range automatically.
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

Dependency rule: `engine/*`, `coverage`, `segment/*` import nothing from `rpc/`, `client/`, or `orchestrator/` and contain no DOM/worker references. Arrows point at importers.

```
types.ts            public shared types (Range, Dtype, CacheConfig, GetResult, Miss, events)
errors.ts           §2.6 taxonomy
coverage.ts         coverage index: sorted disjoint ranges, binary search,
                    splice on merge, subtraction (invalidate), miss computation
segment/
  types.ts          Segment interface: lookup / slice / mergeFrom / transferPayload
  dense.ts          DenseSegment: implicit timestamps, presence bitmask, typed arrays
  payload.ts        DenseSegmentPayload encode/decode (one-format-three-uses lives here)
engine/
  validate.ts       put validation: alignment (offset-aware), sort, dup, field/dtype/length
  merge.ts          put path: segment selection, K-gap splitting, slot-cap, new-wins merge,
                    overlap-diff detection
  read.ts           read path: coverage intersection, present-point extraction to columnar
  engine.ts         Engine: caches map, watermarks, version check, clear/invalidate; pure
                    in-process API — unit-test target, './engine' export surface
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

These emerged while making the API concrete (working process §2.3: alternatives presented, user decided).

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

## 9. What happens after sign-off

Implementation follows the starter §11 commit plan (① scaffolding → ⑭ docs), each step green under `bun run ci`, hybrid TDD (strict test-first for `coverage`/`segment`/`engine`; pragmatic for scaffolding, RPC wiring, examples). Documentation debts (starter §8) ship with their related steps; this document seeds `docs/` and is updated only through review.
