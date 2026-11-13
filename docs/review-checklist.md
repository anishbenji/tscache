# Review Checklist

Every review of a step branch checks the diff against this list. Section references point to `docs/history/starter-prompt.md` (S§) and `docs/architecture.md` (A§; each decision of A§7–§8 is a file under `docs/decisions/`), which remain normative; this list only says where reviews must look hardest. Skip sections the diff does not touch.

## Severity

| Level   | Meaning                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0**  | Violates a locked decision or invariant below, corrupts or loses data, returns wrong results, or ships out-of-scope behaviour. Blocks merge. |
| **P1**  | Bug with a concrete failure scenario, or a specified behaviour with no test. Fix before merge.                                               |
| **P2**  | Maintainability or clarity problem with real cost (oversized function, misleading name, missing TSDoc on public API).                        |
| **nit** | Optional. Report only if it breaks a rule in `AGENTS.md`.                                                                                    |

## 1. Locked decisions and scope

- [ ] No silent deviation from S§3 or A§7–§8. Any deviation is P0 unless the diff or step review file records user approval.
- [ ] Nothing from the roadmap leaks in: TTL, aggregation/resampling, SharedArrayBuffer, `ColumnarSegment` or another segment layout (irregular timestamps), subscriptions (dirty notifications), LRU/eviction, per-field presence masks, an elected auth handler, `i64`/`u64`/`f16`, `worker_threads` hosting (S§3.3, S§10, A§1, A§8 N7; `docs/roadmap.md`). IndexedDB persistence is no longer on this list: it is specified in A§4.10 (N45–N61, N66).

## 2. Data model and validation (S§3.1, A§2.4, N1)

- [ ] `put` rejects misaligned, unsorted or duplicate timestamps **atomically**: no state is mutated before the throw, and the error names the first offender and the expected alignment.
- [ ] Alignment honours `alignmentOffset`; `interval` has no default.
- [ ] Ranges are inclusive at both ends. Unaligned `get`/`invalidate` inputs snap outward (floor start, ceil end).
- [ ] ms↔slot conversion happens at one site; all internal range math uses integer slot indices.
- [ ] Presence is per point, not per field; `NaN` is a legal value of a float field. A put rejects a non-number in any field and a fraction, `NaN`, `±Infinity` or an out-of-range value in an integer field, never coercing it (N68, decision 38).
- [ ] Dtypes are exactly `f64 f32 i32 u32 i16 u16 i8 u8`.

## 3. Coverage (S§3.2–§3.3, A§6.1)

- [ ] The index stays sorted and disjoint; adjacent and overlapping ranges merge; real gaps never split coverage.
- [ ] The volatile region (`t >= finalizedUntil`) never gains coverage authority.
- [ ] `put` authority defaults to the batch span `[t₀, tₙ]`; an explicit `range` must contain every point (N3).
- [ ] `invalidate` subtracts coverage and over-invalidates conservatively, never under.

## 4. Segments (S§3.2)

- [ ] Code outside `segment/` depends only on the `Segment` interface (`extent`, `size`, `lookup`, `slice`, `countIn`, `sliceInto`, `mergeFrom`, `transferPayload`), never on `DenseSegment` internals.
- [ ] Mask is 1 bit per slot, `ceil(count / 8)` bytes; bit order is consistent between write, read and payload.
- [ ] Gap split triggers at more than K intervals; the slot cap (32 768 default) is respected on every growth path.
- [ ] New data wins on overlap; the overlap-difference warning is off by default and costs nothing when off.

## 5. Payload invariant — one format, three uses (S§3.7, A§3.4)

- [ ] `DenseSegmentPayload` stays self-describing with `format: 1`, and any change keeps it valid as all three of: an RPC message, an IndexedDB value (structured-cloneable — no functions, class instances or getters), and an SSR hydration payload serialised into HTML.

## 6. Read contract (S§3.6, A§2.3)

- [ ] `get` returns present points only: `timestamps` and every field array have equal length, no holes, no mask.
- [ ] `misses` is always present (possibly empty), with reasons from `'uncached' | 'fetch-failed' | 'auth-pending'`.
- [ ] `get` never rejects for data availability; it rejects only for programmer errors (A§2.6).

## 7. Memory and transfer (S§3.4, A§3.3)

- [ ] Cache-owned buffers are never transferred; reads copy out first.
- [ ] Arrays passed to `put` / returned by fetchers are documented as consumed when transferred.
- [ ] No `SharedArrayBuffer` anywhere.

## 8. Layering (A§4)

- [ ] `engine/`, `coverage`, `segment/` import nothing from `rpc/`, `client/` or `orchestrator/`, and have no DOM or worker references at module top level (SSR/Node-safe).
- [ ] The `./fetcher` entry has zero imports beyond its own types and `AuthInvalidError` (N6).
- [ ] Auth failures are detected by `code === 'tscache:auth-invalid'`, never `instanceof` (N6, N8).

## 9. Workers, RPC and orchestration (S§3.4–§3.5, A§3, N2, N5)

- [ ] The protocol-version handshake rejects a mismatch with a clear error.
- [ ] Fallback order is SharedWorker → dedicated Worker → in-process; pinning continues down-chain from the pin.
- [ ] Fetch dedup is keyed in the worker so one fetch serves all tabs; miss ranges extend by one interval on flanks abutting coverage.
- [ ] `authInvalid` broadcasts to all tabs; `updateAuth` is accepted from any tab, switches the context and restores auth; nothing is paused or retried (a `get` that returned `auth-pending` is re-issued by the consumer).
- [ ] While auth is invalid, `get` resolves promptly with `auth-pending` misses; nothing awaits a human-speed event. With a fetcher, `get` awaits deduplicated fetches unless `{ cacheOnly: true }`.
- [ ] Events use the three scopes; `requestId` is `<clientId>:<seq>`; `put()` returns its warnings.
- [ ] `clear` in SharedWorker mode affects all tabs (documented); a version mismatch auto-clears and emits `cacheCleared` with `reason: 'version-mismatch'`.

## 10. Tests

- [ ] Every behaviour the diff adds or changes has a test, including the rejection paths.
- [ ] Fenceposts are covered: single-slot ranges, `start === end`, snap-outward, segment-cap boundaries, gap exactly K vs K+1.
- [ ] Property-style tests exist where A§5 calls for them (coverage merge/subtraction, segment merge).
- [ ] Contract tests written by Codex were not weakened, skipped or deleted unless the step review file records why.
- [ ] Multi-tab behaviour is tested in Playwright with one `BrowserContext` and multiple pages, not separate contexts.
- [ ] No test reads the wall clock, times itself or sleeps for an effect (`docs/testing.md`); `bun scripts/test-clocks.ts` passes, and every `clock-ok` comment says why that line cannot flake.
- [ ] An assertion that depends on which bar, day or year "now" falls in pins the clock (Vitest fake timers, `page.clock`, the backend's `advanceMs`), and a read up to now ends on the grid, not at now.
- [ ] Timing assertions (elapsed time, ratios) live in the bench, never in Vitest or Playwright; a timeout only detects a hang.
- [ ] A test that changes shared state (the backend's clock, failures, latency or version, a server's cache) undoes it or sets up its own preconditions; Playwright retries stay at 0.

## 11. Toolchain and code quality (AGENTS.md)

- [ ] No `bun test`, no tsup, ESM-only.
- [ ] Exported declarations satisfy `isolatedDeclarations` (explicit types on exports); public API has TSDoc explaining _why_.
- [ ] Small functions and modules; no new dependency without recorded user approval.
- [ ] Documentation debts (S§8) touched by this step ship with it.

## 12. Persistence (A§4.10, N45–N61, N66)

- [ ] `persist` is per cache, default false, a boolean or `ConfigError`, and structural under N20. Only the SharedWorker hosting with IndexedDB loads or writes records; the dedicated-worker and in-process hostings only clear the database, through the clear-only call (item 10 below, N66). Elsewhere `persist: true` is accepted and does nothing, without an event. A failure never rejects a call; it emits `persistStopped` once per cache, and `PROTOCOL_VERSION` stays 1 (A§4.10.1, N45, N52, N59).
- [ ] `persist/` builds on `engine/`, `grid`, `coverage`, `segment/` and `types` (its hosting adapters, `hosted.ts` and `clear-only.ts`, also take the `Persistence` type from `rpc/server`); nothing under `engine/`, `grid`, `coverage` or `segment/` imports `persist/` or gains a timer, DOM or worker reference. The persister, `restore`, the record builder, the IndexedDB adapter and `clearDisk` stay in the lazy chunk, so an application without a persisted cache or a `clearAll` never loads them (A§4.10 intro, A§4.10.8).
- [ ] Every stored layer keeps its version: database `tscache` at IndexedDB version 1 with stores `caches` and `pages` and their key paths; `CacheRecord.format`; the N20 config; the dataset `version`; `Snapshot.format` and each payload's `format`. A layout change bumps the IndexedDB version and migrates in its upgrade; a record change bumps its `format`. Each mismatch at load has the outcome of A§4.10.2's table: a `CacheRecord.format`, config or `version` mismatch applies nothing of the cache; a `Snapshot.format` or payload `format` mismatch skips only that page, and the others are applied (item 5 below); in every case nothing is cleared in memory, nothing is emitted, and the cache is rewritten at its next flush. A database at a higher version makes persistence `'unavailable'` (A§4.10.2, N51, N53).
- [ ] Records reuse the `Snapshot` envelope and the §3.4 payloads (§5 above), and hold exactly `recordsOf(S)`: one self-contained record per page that holds coverage, only covered slots below the watermark and the points inside them, a confirmed gap as `segments: []`, no `finalizedUntil` in a page snapshot. Only the cache record moves the watermark (A§4.10.2, N53, N55).
- [ ] Stored records are decoded as untrusted input: `restore` takes `unknown` and checks every field of A§4.10.5 steps 2 and 5 (cache record format, config, version and watermark; page `cacheId`, safe-integer `page`, `hydrate`'s validation, range inside the page, version equal to the record's, no `finalizedUntil`). An invalid cache record applies nothing; an invalid page is skipped, the others applied, and `rewrite` set; a malformed record never rejects a call or reaches memory (A§4.10.5, property (d)).
- [ ] A stored version applies only when it equals the cache's, or when the cache has none and adopts it; an unversioned record never loads into a versioned cache, and a mismatch deletes nothing at load (N56).
- [ ] Memory is canonical: `cache()` resolves only after its load settled; `restore` applies only into a cache that knows nothing and throws otherwise; any mutating call while the load is pending (`onMutate`) abandons it and sets `rewrite`; a flush builds its plan from memory and never reads the disk (A§4.10.5, A§4.10.6, N57).
- [ ] Two engines writing one database: a change keeps the single-writer design of N52 (a disk read-merge, a lock, or persistence in the dedicated-worker or in-process hostings is a locked-decision change). Where two SharedWorkers overlap (deploy skew, a closing worker and its successor), each writes plainly from its own memory and the overlap may cost coverage, or write back a range the other removed while it still holds it, never a wrong point. The deploy-skew limit in `site/guides/workers.md` and `site/guides/persistence.md` stays accurate for any change to that behaviour (A§4.10.7, N52, N55, N56).
- [ ] Every removal (`invalidate`, `clear`, `clearAll`, a watermark moved back or set first, a version-mismatch clear, and a `put`, `hydrate` or orchestrated `get` that caused one) is, outside a `clearAll` barrier, flushed at once with strict durability, and its call answers only when it is durable, or after the cache stopped and its cleanup, when one runs, settled; additions are written behind, relaxed. A removal recorded during a barrier, or whose flush job is queued or running at the `clearAll()` call, gets no flush of its own: the clear makes it durable when its job succeeds, or its stops release it (N49, N50, N58; A§4.10.6, properties (j), (l)).
- [ ] `clearAll` reaches storage: it empties both stores, caches this engine never opened included, with strict durability, and resolves after. While its job is pending no flush is written and no load reads the disk, except that the flush attempt running at the call finishes, and is final: no retry, no stop, its taken state not put back; queued flush jobs are absorbed, and cleanups queued before the call run first. A failed clear stops every tracked cache without a cleanup, and the persister persists nothing more: a cache opened later stops at once, reads nothing and has no cleanup (property (n)). In the dedicated-worker and in-process hostings it runs the clear-only call (`ifExists`, the connection closed before it answers, bounded by the deadline, no event) (A§4.10.6, A§4.10.7, N54, N66).
- [ ] Load time and deadlines: a persisted cache loads eagerly at open in one read-only transaction; `cache()` answers within `timeoutMs` (5 s), the chunk's import included. Each writer job has one deadline covering queue, store calls and retries, so a removal's call waits at most two deadlines; a removal on a cache whose open waits for the persistence chunk, and a `clearAll` before the chunk has loaded, first wait for the import, itself bounded by `timeoutMs` (N46, N59, N61, A§4.10.8).
- [ ] Quota and failures: a flush write rejected with `QuotaExceededError` stops the cache with `'quota-exceeded'` and no retry; other rejections retry after `debounceMs` until the deadline. Three writes keep their own rules: a `store.clearAll()` quota rejection is retried like any other; a cleanup's failure, a quota error included, is ignored; the attempt running at a `clearAll()` call is final. A stop drops dirty state and, when a store is open, runs one strict cleanup deletion with no retry, except the stops of a failed `clearAll` and of caches opened after it, which run none. The library never calls `navigator.storage.persist()` (N47, N48, N59).
- [ ] Persistence logic is tested first against `MemoryStore` under fake timers, the IndexedDB adapter by the conformance suite over `fake-indexeddb`, and Chromium's IndexedDB in Playwright; the properties of A§4.10.5 and A§4.10.6 stay pinned (A§4.10.3, N60).

## Output format

Report each finding as:

```
### [P0|P1|P2|nit] <one-line title>
- Where: <path>:<line>
- Checklist: <section and item, e.g. §2 atomic reject>
- Failure scenario: <concrete inputs or state → wrong outcome>
- Suggested fix: <short>
```

Then, if you disagree with a locked decision, add a separate `## Decision concerns` section (these are not findings). End with one line: `Verdict: block | merge after fixes | merge`.
