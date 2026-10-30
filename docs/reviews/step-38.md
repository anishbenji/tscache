# Step 38 — IndexedDB persistence

Branch: `feat/38-persistence` · Reviewer: — · Rounds: 0 · Status: design text, not reviewed yet · Verdict after triage: —

Design for keeping a cache's authoritative data in IndexedDB, so a reload or a new tab starts from what earlier sessions fetched (`docs/roadmap.md`, item 6 of the performance plan). This branch carries design text only: `docs/architecture.md` §4.10 and decision rows N45–N60. Codex writes the contract tests from §4.10 next; the implementation follows in three slices. The director settled the plan's decision points P1–P10 with the recommended options (rows N45–N54); the design took N55–N60 with its recommended options. All of it happened under the user's grant of 2026-10-30, and the user has not confirmed it yet.

## Scope

| Commit | What |
|---|---|
| b64a822 | `docs(architecture)`: §4.10 (public surface, records and versioning, the store seam, change tracking, the reconcile-on-load rule, the persister, merge mode, hosting wiring, interactions); `persist` in §2.2, `persistStopped` in §2.7, `persist/` in the module layout, pointers in §1, §3.4 and §5; rows N45–N60 in §8. `docs/roadmap.md`: the sketch points at §4.10 |
| (this commit) | `docs(review)`: this file, the implementation plan |

### Implementation plan

Three slices, each a branch of its own cut from `main` after the previous one merged, each strict test-first for the parts §4.10 names (`CacheState.restore`, the `Persister`, the store contract): Codex writes their failing tests from §4.10, then the implementer makes them pass. Hosting and RPC wiring is tested with the code (AGENTS.md, hybrid TDD). Every slice ships its exact budgets and its end-to-end scenario, and its pull request carries the paired base and head numbers.

#### Slice (a): records, write-behind and reconcile-on-load, SharedWorker only

Suggested branch `feat/38a-persist-shared`. After it, a persisted cache in the SharedWorker hosting survives a reload; dedicated and in-process hostings accept `persist: true` and do nothing (§4.10.1).

**Modules and functions.**

| Module | Adds |
|---|---|
| `types.ts` | `CacheConfig.persist`, `ResolvedCacheConfig.persist`, `ClientEvents.persistStopped` (§4.10.1) |
| `engine/validate.ts` | `persist`: default false, boolean or `ConfigError` |
| `engine/engine.ts` | `persist` in `STRUCTURAL` (N20); the internal accessor for the persister (a cache's `CacheState`, change subscription), exported by no entry (§4.10.4) |
| `engine/cache.ts` | `CacheChange`, `CacheStateHooks.onChange` and its calls per the table of §4.10.4; `LoadFence`, `RestoreResult`, `CacheState.restore`, `CacheState.coveredSlots` (§4.10.5) |
| `persist/records.ts` | `CacheRecord`, `PageRecord`; `pageOf(slot, cap)` (the store's exact floor; share it with `engine/merge.ts` rather than duplicate it); `cacheRecordOf(state)`, `pageRecordsOf(state, pageRanges?)` (`recordsOf`, §4.10.2) |
| `persist/store.ts` | `PersistStore`, `StoredCache`, `WritePlan`, `PageRange` (§4.10.3) |
| `persist/idb-store.ts` | `openIdbStore(factory, { name?, ifExists? })`: upgrade to version 1, relaxed writes, strict `clearAll`, close on `versionchange` |
| `persist/persister.ts` | `Persister`, plain mode: `open`, tracking and fence, scheduling (`debounceMs`, `maxDelayMs`, immediate removals), `flush`, failures and stop, `clearAll`, `close` (§4.10.6) |
| `rpc/server.ts` | optional persister; `cache` awaits `open`; `invalidate`, `clear`, `setFinalizedUntil` await `flush(cacheId)`; `clearAll` awaits `persister.clearAll()`; flush when the last connection goes; `persistStopped` broadcast (§4.10.8) |
| `entries/worker.ts` | the SharedWorker path builds a plain persister over `openIdbStore(indexedDB)` when `indexedDB` exists |
| `client/events.ts`, `client/cache.ts` | re-emit `persistStopped`; `CacheEvent` gains it |
| `docs/guides/patterns.md` | "Persistence": opting in, `navigator.storage.persist()`, version honesty across sessions, logout with `clearAll` in every tab, sensitive data (§4.10.1) |
| `package.json` (root) | `fake-indexeddb` dev dependency (pre-approved, N60) |

**Contract tests (Codex, before the code).** Files in `packages/tscache/test/`.

| File | Behaviour | Enforces |
|---|---|---|
| `persist-memory-store.ts` | Test helper: `MemoryStore` with call log, failure injection, gates, record access | §4.10.3 |
| `config-persist.test.ts` | `persist` defaults to false; true and false resolve; a non-boolean throws `ConfigError` naming it; joining a live cache with another `persist` throws `ConfigError` naming `persist` and leaves the cache untouched; `Engine.cache` returns it | §4.10.1, N45, N20 |
| `persist-store-conformance.test.ts` | One suite, run against `MemoryStore` and `openIdbStore` over `fake-indexeddb`: empty read; write and read back (buffers, `Uint8Array`, `NaN`); pages ascending with negative pages; `read` with page ranges (inclusive ends, ±Infinity, overlapping ranges read once); `deletePages`; `putCache: null` deletes; other caches untouched; an uncloneable record rejects with `DataCloneError` and stores nothing of the plan; `clearAll`; copies in and out; `close` then `'InvalidStateError'`. `openIdbStore` only: name, version 1, stores and key paths; `ifExists` against a factory without the database resolves `undefined` and creates none | §4.10.3, §4.10.2 |
| `cache-changes.test.ts` | Every row of the change table: the kinds and slot ranges each operation reports, in order; a put wholly in the volatile region reports no `write`; the first watermark reports `remove [volatileFrom, MAX_SAFE_INTEGER]`; a failed write reports its withdrawal; `restore` reports nothing | §4.10.4 |
| `cache-restore.test.ts` | Properties (a) round trip and idempotence, (b) never overwrites covered or provisional slots, `applied` exact, (c) the fence (`removed`, `cleared`, `watermarkChanged`), (d) the version cases, (f) a confirmed-gap page; the watermark advance is forwards only; adjacent parts on neighbouring pages are merged in `applied` | §4.10.5 |
| `cache-restore-rejections.test.ts` | Property (e): an absent cache record (with and without orphan pages), `format` other than 1, each of the six config fields differing, a malformed `version` or `finalizedUntil`, apply nothing; a page with the wrong `cacheId`, a non-integer `page`, a range outside its page, a snapshot failing each `hydrate` check, or another version, is skipped while the others apply; `rewrite` in each case | §4.10.5, §4.10.2 (versioning table) |
| `persister-records.test.ts` | After a flush the store holds `recordsOf(S)`: page index `floor(slot / cap)`, negative pages, the fencepost slots `cap − 1` and `cap`; the hull; each page snapshot deep-equals `Engine.snapshot(hull)` without `finalizedUntil`; a covered page without points has `segments: []`; no record for a page without coverage; no point at or after the watermark in any record; the cache record's fields; equal states give equal records | §4.10.2 |
| `persister-load.test.ts` | `open`: resolves at once for a non-persisted cache, rejects with `UnknownCacheError` for an unknown id; one `read` per cache however often it is opened; `openStore` called once and lazily; a failing or `undefined` `openStore` stops this and later caches with `'unavailable'`; a failing read stops with `'error'`; a read held past 5000 ms resolves `open`, stops with `'unavailable'`, and a late result is ignored; `rewrite` leads to a full rewrite at the next flush; `onStopped` payloads | §4.10.6 (Open), N46, N59 |
| `persister-flush.test.ts` | Fake timers: many changes within 1000 ms give one write; quiet 1000 ms then a write; changes every 500 ms are written by 5000 ms; a `remove` or `clear` is flushed at once; no flush while a load is pending, and changes made then are flushed after it; one flush per cache at a time; `flush(id)` and `flush()` resolve after their write and at once when nothing is dirty. Plans: dirty page ranges deleted and rewritten; `cleared`, `rewrite` and a version change give the full rewrite; a watermark-only change writes the cache record only; one write transaction per dirty cache. Failures: a generic error is retried after 5000 ms with the union of the dirty state, and the third consecutive one stops with `'error'` (name and message); a success resets the count; a stop issues one delete of all the cache's records, ignores its failure and never writes again. `clearAll`: every record of every cache goes, caches never opened included; with no database it creates none; dirty state dropped on success; on failure each tracked cache's next flush deletes its records; a pending load restores nothing | §4.10.6, N50, N54, N58, N59 |
| `persister-property.test.ts` | Plain-mode properties (a) the store equals `recordsOf(S)` after every flush over random operation sequences, (b) a reload by a second engine and persister reads what the first had at its last flush, (c) incremental plans | §4.10.6 (properties) |
| `persister-fence.test.ts` | With the read held by a gate: a `put`, `hydrate` or raw orchestrated write during the load keeps its data; an `invalidate`, `clear`, `clearAll` or `setFinalizedUntil` during the load is not undone by it; a watermark moved meanwhile is not overridden | §4.10.5 (atomicity), N57 |

**Tests with the code (implementer).**

| File | Behaviour | Enforces |
|---|---|---|
| `rpc-persist.test.ts` | Over `MessageChannel` with a `MemoryStore`: `cache` answers after the load, so a `get` right after it sees the restored data; two ports opening one cache read once; `invalidate`, `clear`, `setFinalizedUntil` and `clearAll` answer after their write; the last connection's `dispose` flushes; `persistStopped` reaches every port as a cache-scoped event; a non-persisted cache never touches the store | §4.10.8 |
| `client.test.ts` (additions) | `client.on` and `cache.on` receive `persistStopped`, the latter filtered by cache id; an unknown cache-scoped event is still ignored | §4.10.1, §4.10.8 |

**Exact budgets** (`packages/tscache/test/perf/persist.test.ts`, gating in `bun run ci`):

| Budget | Value |
|---|---|
| Fetches when the counters scroll-back scenario (`counters.test.ts`: an opening read and twelve screens back) runs again on a second `RpcServer`, `Engine` and `Persister` over the first one's flushed `MemoryStore` | 0 |
| Read transactions per persisted cache opened; for a non-persisted cache | 1; 0 |
| Write transactions for 50 puts inside one debounce window, one cache | 1 |
| Page records put by a flush after a put inside one page | 1, plus the cache record |
| Write transactions after puts wholly inside the volatile region | 0 |
| Stored bytes per bar (payload masks and field buffers, summed from the store) for the memory budget's three fixtures | at most its bounds: 36.75 / 36.75 / 37.25 B |
| Entry sizes (`scripts/size.ts`) | `worker` budget raised by the measured growth, with the reason in the commit; `index` unchanged (the client gains a type and one event branch) |

**End-to-end.**

- Playwright, gating (`e2e/persist.spec.ts`, shared mode): a reload reads its bars from IndexedDB with no fetch (the second page uses a new worker URL, so a new SharedWorker loads from disk rather than serving memory); the provisional tail is fetched again after the reload; after `clearAll` resolves, both stores are empty (read from the page with `indexedDB`); a reload whose config names another `version` fetches again; a second tab's `cache()` waits for the first tab's load and then reads without a fetch.
- Bench scenario `reload-first-read` (`packages/tscache/bench/e2e.ts`, `scripts/bench-e2e.ts`), report-only like the others: per run, a setup page reads 1,500 bars into a persisted cache (one fetch) and disposes its client, and the driver waits until IndexedDB holds the page records; then a new page with a worker URL no earlier run used creates a client, opens the cache and reads the same 1,500 bars. Timed from `createClient` to that `get` resolving: worker start, handshake, the database open, one read transaction, the restore and the transfer. Each run uses a cache id of its own. Head must make no fetch; the base, which has no persistence and ignores `persist`, fetches once per run, so the pair is the gain over `handshake-first-read`'s path. Fails on a wrong result or a fetch by head.
- No new timing case in `bench/cases.ts`: the cases drive the public engine, which has no persister. The restore's cost is that of `hydrate`, which `snapshot-roundtrip` already times.

#### Slice (b): read-merge-write for dedicated and in-process hostings

Suggested branch `feat/38b-persist-merge`. After it, every hosting with IndexedDB persists.

**Modules and functions.**

| Module | Adds |
|---|---|
| `persist/persister.ts` | merge mode: `removed` tracking, the lock grant around read and write, the read of the dirty pages, the merged page records, the full-rewrite fallback; the lock around the plain write when `locks` is given (§4.10.7) |
| `persist/merge.ts` (if `persister.ts` grows past a small file) | `mergePage(state, stored, removed)`: the scratch `CacheState` build of §4.10.7 step 5 |
| `entries/worker.ts` | the dedicated path builds a merge persister with `lockManager()`; the SharedWorker path passes `lockManager()` too |
| `client/hosting.ts` | `openInProcess` builds a merge persister in the page when `indexedDB` exists; `terminate` calls `persister.close()` |

**Contract tests (Codex).**

| File | Behaviour | Enforces |
|---|---|---|
| `persister-merge.test.ts` | Two engines and persisters on one `MemoryStore`: (M1) different parts of one page, either flush order, a third engine loads both; (M2) a merge does not restore its engine's removals; (M3) a stored record of another version or config is replaced wholesale; (M4) with a fake lock manager, each flush's read and write run inside one grant and two flushes never overlap; without locks the merge still runs; a merged flush is one read and one write transaction and one lock request, a full rewrite no read; a failed read or write puts `removed` back; the plain mode takes the lock around its write when `locks` is given | §4.10.7, N52 |
| `persister-merge-property.test.ts` | (M5) immutable data (each slot's value a function of the slot): random interleavings of two engines' puts, invalidations and flushes; a third engine's load never shows another value and never a confirmed gap where the function has a point | §4.10.7 |

**Tests with the code.** `hosting.test.ts` (additions): the dedicated entry and `openInProcess` build merge persisters, the in-process `terminate` closes the store; two in-process clients in one page do not erase each other's coverage on disk.

**Exact budgets.** Transactions per merged flush of one dirty cache: one read and one write, and one lock request; a full rewrite: one write. Entry sizes: `index` raised by the measured growth (the in-process hosting now carries the persister), `worker` by the merge code.

**End-to-end.**

- Playwright, gating (`e2e/persist-merge.spec.ts`): two pages pinned to `mode: 'dedicated'` persist different ranges of one page; a third dedicated page reads both without a fetch. An in-process page persists and its reload reads without a fetch.
- Bench scenario `reload-first-read` gains a `dedicated` variant (the same steps with `mode: 'dedicated'`), report-only.

#### Slice (c): the quota event and extended lifetime

Suggested branch `feat/38c-persist-quota`.

**Modules and functions.**

| Module | Adds |
|---|---|
| `persist/persister.ts` | a write rejecting with `QuotaExceededError` stops the cache at once with `'quota-exceeded'`, no retry (§4.10.6, N47) |
| `client/hosting.ts` | `openShared` creates the worker with `{ type: 'module', extendedLifetime: true }` (§4.10.8, N50) |

**Contract tests (Codex).**

| File | Behaviour | Enforces |
|---|---|---|
| `persister-quota.test.ts` | A `QuotaExceededError` write: no retry; `onStopped` once with `'quota-exceeded'` and the error's name and message; exactly one delete of the cache's records follows, and a failure of that delete is ignored; later changes are never written; other caches keep persisting | §4.10.6 (Failures), N47 |

**Tests with the code.** `hosting.test.ts` (additions): `openShared` passes `extendedLifetime: true` with `type: 'module'` (a stub `SharedWorker` records its options).

**Exact budgets.** After a quota failure: one failed write, then one delete transaction, then none.

**End-to-end** (Playwright, gating):

- `e2e/persist-quota.spec.ts`: the Chrome DevTools Protocol's `Storage.overrideQuotaForOrigin` sets a small quota; persisting past it emits `persistStopped` with `'quota-exceeded'`, the cache keeps answering from memory, and IndexedDB holds no record of it afterwards.
- `e2e/persist-lifetime.spec.ts`: a put, then the last tab closes inside the debounce window; a new page finds the cache's page record in IndexedDB. It runs where the browser reads the `extendedLifetime` member (detected in the page with a getter on the options object, which only a browser that knows the member calls).

## Decisions made in the step

The rows in `docs/architecture.md` §8 carry the full text. P1–P10 were settled by the director; the rest were taken here, each with the recommended option.

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | P1–P10 as N45–N54, with three additions: `persistStopped` carries an optional `error` (N47); `clearAll` uses strict durability (N49); the debounce has a 5 s cap (N50) | Diagnosis of a stop; a logout must survive a power loss; a steady live feed would otherwise never be quiet for a second | The exact P3 shape; relaxed `clearAll`; a pure debounce |
| D2 | Coverage stored per page: a page record is the snapshot of its covered hull (N55) | Each record is self-contained and valid whoever wrote it, so a second writer (a deploy skew, a dedicated tab) costs coverage, never correctness; a lost page takes its coverage with it | Coverage in the cache record, as the roadmap sketch had it (one writer's coverage list can describe another writer's pages, confirming gaps where points exist) |
| D3 | Stored version applied only when equal, or adopted by an unversioned cache (N56) | A record written without a version may hold any version's data | `hydrate`'s rule; deleting mismatched records at load |
| D4 | `restore` fills only what memory does not know, behind a fence of subtractions, clears and watermark changes made while the load was pending (N57) | A load must never overwrite newer data nor undo a removal; atomic as `hydrate` is | Blocking every op on the cache during the load; applying records as a ranged `put` |
| D5 | `cache()` of a persisted cache resolves after the load, at most 5 s (N46, N57) | The first read after a reload must be served from disk, not race the load and fetch | Resolving at once and loading in the background (the reload fetches anyway) |
| D6 | Removals are flushed at once and their calls resolve after the write (N58) | A lost addition is harmless; a lost removal would let the next session load what the app withdrew | Debouncing removals like additions |
| D7 | Failures never reject: `'unavailable'` for an open failure or a load past 5 s, `'error'` for a failed read or three consecutive failed writes; a stopped cache's records are deleted (N59) | The cache keeps working; the disk must not keep what memory withdrew | Retrying forever; stopping on the first failure; keeping the records |
| D8 | The page snapshot omits `finalizedUntil`, and a version change rewrites the whole cache (§4.10.2, §4.10.4) | A watermark change then rewrites one small record; a version change must reach every page, since each page names its version | A watermark in every page (each advance rewrites every page) |
| D9 | The SharedWorker writes plainly; it takes the lock from slice (b) (N52) | It is normally the only writer, and D2 makes a second writer safe; the lock keeps its write out of a merging engine's read-write window | Merging in the SharedWorker too (a read per dirty page per flush, for the deploy-skew case only) |
| D10 | `PersistStore` seam, `MemoryStore` for the logic, a conformance suite over `fake-indexeddb` for the adapter (N60) | The logic needs quota failures, held transactions and counts; the adapter needs real key ranges and atomic abort | `fake-indexeddb` everywhere; the fake alone |
| D11 | `persist: true` is inert, without an event, where there is no IndexedDB or no persister (N45) | A server render in Node shares the browser's config | `ConfigError` (breaks server rendering); a `persistStopped` at every server-side open |
| D12 | The database is opened lazily; `clearAll` before any open uses `ifExists`, so an app that never persists gets no database (§4.10.6) | No side effect for apps that do not use persistence | Always opening the database; deleting it at `clearAll` (blocks on other tabs' connections) |
| D13 | Dirty state kept per page, the stable container of segments (N15), for starter §3.7's "dirty-segment set" | Segments split and join; pages do not | Tracking segments (their identity changes with every split) |

## Contract-test changes

None.

## Decision concerns

For the user; the design works around each.

1. **No final flush in the dedicated hosting.** `dispose()` terminates an owned dedicated worker at once (§4.8), so the flush that the last connection's dispose starts never runs there; the loss is the last debounce window, which is harmless for additions, and removals were already written at once (N58). Options: (a) accept it (recommended: nothing changes, the loss is bounded and safe); (b) let a dedicated worker with a persister close itself after a final flush, and have the client post `dispose` without terminating it (changes §4.8's dispose rule; a worker that never closes leaks until its page ends); (c) flush on the page's `visibilitychange` to hidden (a new client-to-worker hint, an additive op).
2. **Coverage per page instead of in the cache record (N55)** departs from the roadmap sketch. Nothing locked depends on the sketch, and starter §3.7's reconcile rule holds by construction, but the user may want to confirm it.
3. **`cache()` waits up to 5 s for a load** of a persisted cache (N46). The measured load is milliseconds; the bound only matters when IndexedDB stalls, and then persistence for the cache stops. Confirm the bound, or choose a shorter one.

## User decision (2026-10-30)

The user confirmed the design as written: N45–N60, and the four flagged items as recommended (no final flush in the dedicated-worker hosting; N55 coverage in each page record; the 5 s bound on `cache()` waiting for the load; the new public surface `CacheConfig.persist` and `persistStopped`). Next: Codex design review, then Codex contract tests, then slices (a), (b) and (c), one pull request each.
