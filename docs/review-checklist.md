# Review Checklist

Every review of a step branch checks the diff against this list. Section references point to `starter-prompt.md` (S§) and `docs/architecture.md` (A§), which remain normative; this list only says where reviews must look hardest. Skip sections the diff does not touch.

## Severity

| Level | Meaning |
|---|---|
| **P0** | Violates a locked decision or invariant below, corrupts or loses data, returns wrong results, or ships out-of-scope behaviour. Blocks merge. |
| **P1** | Bug with a concrete failure scenario, or a specified behaviour with no test. Fix before merge. |
| **P2** | Maintainability or clarity problem with real cost (oversized function, misleading name, missing TSDoc on public API). |
| **nit** | Optional. Report only if it breaks a rule in `AGENTS.md`. |

## 1. Locked decisions and scope

- [ ] No silent deviation from S§3 or A§7–§8. Any deviation is P0 unless the diff or step review file records user approval.
- [ ] Nothing from the roadmap leaks in: TTL, aggregation/resampling, SharedArrayBuffer, `ColumnarSegment`, IndexedDB persistence, LRU/eviction, `i64`/`u64`/`f16`, `worker_threads` hosting (S§10, A§8 N7).

## 2. Data model and validation (S§3.1, A§2.4, N1)

- [ ] `put` rejects misaligned, unsorted or duplicate timestamps **atomically**: no state is mutated before the throw, and the error names the first offender and the expected alignment.
- [ ] Alignment honours `alignmentOffset`; `interval` has no default.
- [ ] Ranges are inclusive at both ends. Unaligned `get`/`invalidate` inputs snap outward (floor start, ceil end).
- [ ] ms↔slot conversion happens at one site; all internal range math uses integer slot indices.
- [ ] Presence is per point, not per field; `NaN` is a legal field value.
- [ ] Dtypes are exactly `f64 f32 i32 u32 i16 u16 i8 u8`.

## 3. Coverage (S§3.2–§3.3, A§6.1)

- [ ] The index stays sorted and disjoint; adjacent and overlapping ranges merge; real gaps never split coverage.
- [ ] The volatile region (`t >= finalizedUntil`) never gains coverage authority.
- [ ] `put` authority defaults to the batch span `[t₀, tₙ]`; an explicit `range` must contain every point (N3).
- [ ] `invalidate` subtracts coverage and over-invalidates conservatively, never under.

## 4. Segments (S§3.2)

- [ ] Code outside `segment/` depends only on the `Segment` interface (`lookup`, `slice`, `mergeFrom`, `transferPayload`), never on `DenseSegment` internals.
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
- [ ] `authInvalid` broadcasts to all tabs; `updateAuth` is accepted from any tab and retries paused fetches.
- [ ] While auth is invalid, `get` resolves promptly with `auth-pending` misses; nothing awaits a human-speed event. With a fetcher, `get` awaits deduplicated fetches unless `{ cacheOnly: true }`.
- [ ] Events use the three scopes; `requestId` is `<clientId>:<seq>`; `put()` returns its warnings.
- [ ] `clear` in SharedWorker mode affects all tabs (documented); a version mismatch auto-clears and emits `cacheCleared` with `reason: 'version-mismatch'`.

## 10. Tests

- [ ] Every behaviour the diff adds or changes has a test, including the rejection paths.
- [ ] Fenceposts are covered: single-slot ranges, `start === end`, snap-outward, segment-cap boundaries, gap exactly K vs K+1.
- [ ] Property-style tests exist where A§5 calls for them (coverage merge/subtraction, segment merge).
- [ ] Contract tests written by Codex were not weakened, skipped or deleted unless the step review file records why.
- [ ] Multi-tab behaviour is tested in Playwright with one `BrowserContext` and multiple pages, not separate contexts.

## 11. Toolchain and code quality (AGENTS.md)

- [ ] No `bun test`, no tsup, ESM-only.
- [ ] Exported declarations satisfy `isolatedDeclarations` (explicit types on exports); public API has TSDoc explaining *why*.
- [ ] Small functions and modules; no new dependency without recorded user approval.
- [ ] Documentation debts (S§8) touched by this step ship with it.

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
