# Step 38 — IndexedDB persistence

Branch: `feat/38-persistence` · Reviewer: GPT-6.1 Sol (high) · Rounds: 2 · Status: design redesigned after round 2, re-review pending · Verdict after triage: re-review

Design for keeping a cache's authoritative data in IndexedDB, so a reload or a new tab starts from what earlier sessions fetched (`docs/roadmap.md`, item 6 of the performance plan). This branch carries design text only: `docs/architecture.md` §4.10 and decision rows N45–N61. Codex writes the contract tests from §4.10 next; the implementation follows in three slices. The director settled the plan's decision points P1–P10 with the recommended options (rows N45–N54); the design took N55–N60 with its recommended options; the user confirmed all of it on 2026-10-30 (below). After review round 2 the concurrency core was redesigned under the convergence check of `docs/workflow.md` (step 7): rows N52, N55, N57, N58 and N59 changed in substance, N60 was amended and N61 added. The user has not confirmed the redesign yet; what it changes for the user is listed under "Decision concerns after round 2".

## Scope

| Commit | What |
|---|---|
| 20659e2 | `docs(architecture)`: §4.10 (public surface, records and versioning, the store seam, change tracking, the reconcile-on-load rule, the persister, merge mode, hosting wiring, interactions); `persist` in §2.2, `persistStopped` in §2.7, `persist/` in the module layout, pointers in §1, §3.4 and §5; rows N45–N60 in §8. `docs/roadmap.md`: the sketch points at §4.10 |
| c962134 | `docs(review)`: this file, the implementation plan |
| d2f8473 | `docs(review)`: the user's decision |
| 38e3fcc | `docs(review)`: round 1 triage, with the round 1 fixes in §4.10 and rows N49, N57, N58, N59 |
| 15668f9 | `docs(architecture)`: the redesign of §4.10.4–§4.10.7 after round 2: memory canonical on load, one writer with one deadline, merge mode on `hydrate`; rows N52, N55, N57, N58, N59 changed, N60 amended, N61 added |
| (this commit) | `docs(review)`: round 2 triage, the convergence check, the plan and test lists brought to the redesign |

### Implementation plan

Three slices, each a branch of its own cut from `main` after the previous one merged, each strict test-first for the parts §4.10 names (`CacheState.restore`, the `Persister`, the store contract): Codex writes their failing tests from §4.10, then the implementer makes them pass. Hosting and RPC wiring is tested with the code (AGENTS.md, hybrid TDD). Every slice ships its exact budgets and its end-to-end scenario, and its pull request carries the paired base and head numbers.

#### Slice (a): records, write-behind and the canonical load, SharedWorker only

Suggested branch `feat/38a-persist-shared`. After it, a persisted cache in the SharedWorker hosting survives a reload; dedicated and in-process hostings accept `persist: true` and do nothing (§4.10.1).

**Modules and functions.**

| Module | Adds |
|---|---|
| `types.ts` | `CacheConfig.persist`, `ResolvedCacheConfig.persist`, `ClientEvents.persistStopped` (§4.10.1) |
| `engine/validate.ts` | `persist`: default false, boolean or `ConfigError` |
| `engine/engine.ts` | `persist` in `STRUCTURAL` (N20); the internal accessor for the persister (a cache's `CacheState`, change subscription), exported by no entry (§4.10.4) |
| `engine/cache.ts` | `CacheChange`, `CacheStateHooks.onChange` and its calls per the table of §4.10.4; `RestoreResult`, `CacheState.restore` with its knows-nothing precondition, applying each valid page as `hydrate` applies a part (§4.10.5) |
| `persist/records.ts` | `CacheRecord`, `PageRecord`; `pageOf(slot, cap)` (the store's exact floor; share it with `engine/merge.ts` rather than duplicate it); `cacheRecordOf(state)`, `pageRecordsOf(state, pageRanges?)` (`recordsOf`, §4.10.2: the page snapshot's segments are those of `snapshot(r)` for each covered range `r` of the page) |
| `persist/store.ts` | `PersistStore`, `StoredCache`, `WritePlan`, `PageRange` (§4.10.3) |
| `persist/idb-store.ts` | `openIdbStore(factory, { name?, ifExists? })`: upgrade to version 1, relaxed writes, strict `clearAll`, close on `versionchange` |
| `persist/persister.ts` | `Persister`, plain mode: `open`, tracking, the abandon rule, the writer (one job at a time, priority for removal-carrying jobs, one deadline per job, lock requests with an `AbortSignal`, retries after `debounceMs` until the deadline, abandoned store calls), scheduling (`debounceMs`, `maxDelayMs`, immediate removals), `flush`, the removal count, `removals` and `durable`, `strict` plans, stops and the cleanup job, `clearAll`, `close` (§4.10.6). `LockManagerLike` is declared here; slice (a) passes no lock manager from the entry |
| `rpc/server.ts` | optional persister; `cache` awaits `open`; every op naming a cache reads `persister.removals(cacheId)` before and awaits `persister.durable(cacheId)` after when the count grew (`put`, `get`, `hydrate`, `invalidate`, `clear`, `setFinalizedUntil`); `clearAll` awaits `persister.clearAll()`; flush when the last connection goes; `persistStopped` broadcast (§4.10.8) |
| `entries/worker.ts` | the SharedWorker path builds a plain persister over `openIdbStore(indexedDB)` when `indexedDB` exists |
| `client/events.ts`, `client/cache.ts` | re-emit `persistStopped`; `CacheEvent` gains it |
| `docs/guides/patterns.md` | "Persistence": opting in, `navigator.storage.persist()`, version honesty across sessions, logout with `clearAll` in every tab, sensitive data (§4.10.1) |
| `package.json` (root) | `fake-indexeddb` dev dependency (pre-approved, N60) |

**Contract tests (Codex, before the code).** Files in `packages/tscache/test/`. Every timing test runs under fake timers with the default options unless it says otherwise.

| File | Behaviour | Enforces |
|---|---|---|
| `persist-memory-store.ts` | Test helpers: `MemoryStore` with call log, failure injection (next `n` calls of a kind, or every call), gates, record access; `FakeLockManager` with a log of requests, grants, releases and aborts, a way for the test to hold the lock, and the Web Locks abort rule | §4.10.3 |
| `config-persist.test.ts` | `persist` defaults to false; true and false resolve; a non-boolean throws `ConfigError` naming it; joining a live cache with another `persist` throws `ConfigError` naming `persist` and leaves the cache untouched; `Engine.cache` returns it | §4.10.1, N45, N20 |
| `persist-store-conformance.test.ts` | One suite, run against `MemoryStore` and `openIdbStore` over `fake-indexeddb`: empty read; write and read back (buffers, `Uint8Array`, `NaN`); pages ascending with negative pages; `read` with page ranges (inclusive ends, ±Infinity, overlapping ranges read once); `deletePages`; `putCache: null` deletes; other caches untouched; an uncloneable record rejects with `DataCloneError` and stores nothing of the plan; `clearAll`; copies in and out; `close` then `'InvalidStateError'`. `openIdbStore` only: name, version 1, stores and key paths; `ifExists` against a factory without the database resolves `undefined` and creates none | §4.10.3, §4.10.2 |
| `cache-changes.test.ts` | Every row of the change table: the kinds and slot ranges each operation reports, in order; a put wholly in the volatile region reports no `write`; the first watermark reports `remove [volatileFrom, MAX_SAFE_INTEGER]`; a failed write reports its withdrawal; `restore` reports `watermark` only when the watermark after it differs from the record's, and never a `write` | §4.10.4 |
| `cache-restore.test.ts` | Properties (a) round trip, `recordsOf(E)` equal to `recordsOf(S)`, no change reported, restoring the same records again throws (the cache now knows something); (b) knows nothing or throws: a covered slot, a point below the watermark, a provisional point, and the R1-1 state (watermark 100, provisional 150 = 20, stored watermark 200 covering 150 = 10) each throw `TscacheError` and change nothing; (c) the version cases; (e) a confirmed-gap page; (f) the watermark cases: a creation watermark above the record's is kept and `watermark` reported, one below advances without a report, a record without a watermark under a cache with one applies no coverage at or after it and sets `rewrite`; adjacent parts on neighbouring pages are merged in `applied` | §4.10.5 |
| `cache-restore-rejections.test.ts` | Property (d): an absent cache record (with and without orphan pages), `format` other than 1, each of the six config fields differing, a malformed `version` or `finalizedUntil`, apply nothing; a page with the wrong `cacheId`, a non-integer `page`, a range outside its page, a snapshot failing each `hydrate` check, or another version, is skipped while the others apply; `rewrite` in each case | §4.10.5, §4.10.2 (versioning table) |
| `persister-records.test.ts` | After a flush the store holds `recordsOf(S)`: page index `floor(slot / cap)`, negative pages, the fencepost slots `cap − 1` and `cap`; the hull; each page snapshot's envelope equals `Engine.snapshot(hull)`'s without `finalizedUntil`, and its segments are those of `Engine.snapshot(r)` for each covered range `r`, concatenated; a point inside the hull but outside coverage (invalidated, or provisional when fetched) is not stored; a covered page without points has `segments: []`; no record for a page without coverage; no point at or after the watermark in any record; the cache record's fields; equal states give equal records | §4.10.2 |
| `persister-load.test.ts` | `open`: resolves at once for a non-persisted cache, rejects with `UnknownCacheError` for an unknown id; one `read` per cache however often it is opened; `openStore` called once and lazily; a failing or `undefined` `openStore` stops this and later caches with `'unavailable'`; a failing read stops with `'error'`; a read held past 5000 ms resolves `open`, stops with `'unavailable'`, and a late result is ignored; `rewrite` from `restore` makes a full rewrite due at once; a `watermark` reported by `restore` is written at the next flush; `onStopped` payloads; a stop after a load failure runs one cleanup write | §4.10.6 (Open), N46, N59 |
| `persister-abandon.test.ts` | Property (h): with the read held by a gate, each of `put` (with and without `meta`), `hydrate`, `invalidate`, `setFinalizedUntil`, `clear` and `clearAll` resolves `open` at once, the released read applies nothing, and the next flush is a full rewrite holding `recordsOf(S)`; a removal among those changes makes the rewrite due at once and strict, and `durable` waits for it; a write makes it due after the quiet spell; nothing is written for a cache while its untouched load is pending; a change after the restore is an ordinary change | §4.10.5 (rule 2), §4.10.6 (Open), N57 |
| `persister-flush.test.ts` | Scheduling: many changes within 1000 ms give one write; quiet 1000 ms then a write; changes every 500 ms are written by 5000 ms; a `remove` or `clear` is flushed at once; one flush per cache at a time, a request during a running one runs after it, a request while one is queued joins it with the earlier due time and the removal; `flush(id)` and `flush()` resolve after their job and at once when nothing is dirty. Plans: dirty page ranges deleted and rewritten; `rewrite` (from a `clear`, a version change, a load) gives the full rewrite; a watermark-only change writes the cache record only; one write transaction per dirty cache. Failures: a rejected write is retried after 1000 ms with the union of the dirty state; a success before the deadline resets nothing to retry; writes failing past the deadline stop the cache with `'error'` carrying the last error's name and message; a write held past the deadline stops it with `'unavailable'`, its late result is ignored; a stop issues one strict cleanup delete of all the cache's records, ignores its failure and never writes again. `clearAll`: every record of every cache goes, caches never opened included; with no database it creates none; dirty state dropped on success; a failure is retried until the deadline, when every tracked cache stops and no per-cache cleanup follows; `clearAll()` resolves either way | §4.10.6, N50, N54, N58, N59, N61 |
| `persister-writer.test.ts` | Property (f): under fake timers, `durable` after an `invalidate` resolves within 2 × 5000 ms of it in each of: every write rejected; a write held forever; the lock held by the test throughout (the request is aborted at the deadline, its callback never runs, the cleanup's request is aborted too); ten addition flushes of other caches due ahead of it. Priority: a removal-carrying job runs before queued jobs that carry none, in the lock manager's and the store's logs. One job at a time: never two store write transactions or two lock grants of one persister overlapping. A job's lock request is made with `mode: 'exclusive'` and a signal; the lock is released when the job ends, including after an abandoned store call. Without `locks`, the same jobs run unlocked | §4.10.6 (The writer), N61 |
| `persister-durable.test.ts` | Property (d): `durable` after an `invalidate` with the next 1 or 2 writes failing stays pending through the failures and resolves after the successful write, which is `strict`, holds the removal, and leaves the range uncovered on the store; with every write failing, it resolves only after the deadline stop and the cleanup settled and the store holds nothing of the cache; with the write held past the deadline, after the `'unavailable'` stop and the cleanup; with the cleanup failing too, it still resolves and the records stay; `clearAll()` likewise, with no cleanup after its stop; `durable` resolves at once for an untracked cache and when nothing is pending; a removal recorded during a pending load abandons the load and is durable only after the rewrite's successful write. Property (e): a plan is `strict` exactly when it carries a removal or a clear; additions alone are relaxed. `removals` counts `remove` and `clear` changes | §4.10.6 (Durability of removals), N49, N58, N59 |
| `persister-property.test.ts` | Plain-mode properties (a) the store equals `recordsOf(S)` after every flush over random operation sequences, (b) a reload by a second engine and persister reads what the first had at its last flush and its own `recordsOf` equals the store, (c) incremental plans, (g) convergence: after `open` and one flush the store holds `recordsOf(S)` for every load outcome (applied in full, a skipped page, another version, another config, orphan pages, a clipped part, a creation watermark above and below the record's) | §4.10.6 (properties), §4.10.5 (g) |

**Tests with the code (implementer).**

| File | Behaviour | Enforces |
|---|---|---|
| `rpc-persist.test.ts` | Over `MessageChannel` with a `MemoryStore`: `cache` answers after the load, so a `get` right after it sees the restored data; two ports opening one cache read once and both answer after the one load; `invalidate`, `clear`, `setFinalizedUntil` back and `clearAll` answer only once their removal is durable, through a failed first write; a `put` and an orchestrated `get` whose data clears the cache for a new version, or sets its first watermark, answer only once that is durable; a `get` or `put` that removes nothing answers without waiting for the store, even while a write is held; a raw `clearAll` while another port's `cache` is loading abandons the load and the `cache` call still answers; the last connection's `dispose` flushes; `persistStopped` reaches every port as a cache-scoped event; a non-persisted cache never touches the store | §4.10.8 |
| `client.test.ts` (additions) | `client.on` and `cache.on` receive `persistStopped`, the latter filtered by cache id; an unknown cache-scoped event is still ignored | §4.10.1, §4.10.8 |

**Exact budgets** (`packages/tscache/test/perf/persist.test.ts`, gating in `bun run ci`):

| Budget | Value |
|---|---|
| Fetches when the counters scroll-back scenario (`counters.test.ts`: an opening read and twelve screens back) runs again on a second `RpcServer`, `Engine` and `Persister` over the first one's flushed `MemoryStore` | 0 |
| Read transactions per persisted cache opened; for a non-persisted cache | 1; 0 |
| Write transactions for 50 puts inside one debounce window, one cache | 1, relaxed |
| Write transactions after one `invalidate` | 1, strict |
| Page records put by a flush after a put inside one page | 1, plus the cache record |
| Write transactions after puts wholly inside the volatile region | 0 |
| Write transactions after a clean load (records applied in full, no change) | 0 |
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
| `persist/persister.ts` | merge mode: `removed` tracking, the read of the dirty pages inside the job's lock grant, the merged page records, the full-rewrite fallback; the lock around the plain job when `locks` is given (§4.10.7) |
| `persist/merge.ts` (if `persister.ts` grows past a small file) | `mergePage(state, stored, removedNow)`: the scratch `CacheState` of §4.10.7 step 5, built from two `hydrate` calls and the `invalidate` of each removed range |
| `entries/worker.ts` | the dedicated path builds a merge persister with `navigator.locks`; the SharedWorker path passes `navigator.locks` too |
| `client/hosting.ts` | `openInProcess` builds a merge persister in the page when `indexedDB` exists; `terminate` calls `persister.close()` |

**Contract tests (Codex).**

| File | Behaviour | Enforces |
|---|---|---|
| `persister-merge.test.ts` | Two engines and persisters on one `MemoryStore`: (M1) different parts of one page, either flush order, a third engine loads both; (M2) a merge does not restore its engine's removals; (M3) a stored record of another version or config is replaced wholesale; (M4) with `FakeLockManager`, each flush's read and write run inside one grant and two jobs never overlap; without locks the merge still runs; a merged flush is one read and one write transaction and one lock request, a full rewrite no read; a failed read or write keeps `removed` and the retry reads again; the plain mode takes the lock around its job when `locks` is given; (M6) the R1-2 state: `S` at watermark 100, the stored cache record at 200 and a dirty page's stored record covering 150: the merged page covers nothing at or after 100 and the cache record says 100; (M7) an `invalidate` between a flush's read and its write: that flush does not write the range back, and the next leaves it uncovered; (M8) the lock held by the test past the deadline: `durable` after an `invalidate` resolves within 2 × 5000 ms after the `'unavailable'` stop, both requests aborted, neither callback run, the engine still answering; a stored page record of the cache's version but with points outside its coverage (a foreign record) contributes only its covered points | §4.10.7, N52, N61 |
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
| `persister-quota.test.ts` | A `QuotaExceededError` write: no retry; `onStopped` once with `'quota-exceeded'` and the error's name and message; exactly one cleanup delete of the cache's records follows, and a failure of that delete is ignored; later changes are never written; other caches keep persisting | §4.10.6 (Failures), N47 |

**Tests with the code.** `hosting.test.ts` (additions): `openShared` passes `extendedLifetime: true` with `type: 'module'` (a stub `SharedWorker` records its options).

**Exact budgets.** After a quota failure: one failed write, then one delete transaction, then none.

**End-to-end** (Playwright, gating):

- `e2e/persist-quota.spec.ts`: the Chrome DevTools Protocol's `Storage.overrideQuotaForOrigin` sets a small quota; persisting past it emits `persistStopped` with `'quota-exceeded'`, the cache keeps answering from memory, and IndexedDB holds no record of it afterwards.
- `e2e/persist-lifetime.spec.ts`: a put, then the last tab closes inside the debounce window; a new page finds the cache's page record in IndexedDB. It runs where the browser reads the `extendedLifetime` member (detected in the page with a getter on the options object, which only a browser that knows the member calls).

## Decisions made in the step

The rows in `docs/architecture.md` §8 carry the full text. P1–P10 were settled by the director; D2–D13 were taken by the design, each with the recommended option, and confirmed by the user; D14–D18 were taken by the redesign after round 2 and await the user.

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | P1–P10 as N45–N54, with three additions: `persistStopped` carries an optional `error` (N47); `clearAll` uses strict durability (N49); the debounce has a 5 s cap (N50) | Diagnosis of a stop; a logout must survive a power loss; a steady live feed would otherwise never be quiet for a second | The exact P3 shape; relaxed `clearAll`; a pure debounce |
| D2 | Coverage stored per page: a page record is the snapshot of its covered ranges (N55; revised by D15) | Each record is self-contained and valid whoever wrote it, so a second writer (a deploy skew, a dedicated tab) costs coverage, never correctness; a lost page takes its coverage with it | Coverage in the cache record, as the roadmap sketch had it (one writer's coverage list can describe another writer's pages, confirming gaps where points exist) |
| D3 | Stored version applied only when equal, or adopted by an unversioned cache (N56) | A record written without a version may hold any version's data | `hydrate`'s rule; deleting mismatched records at load |
| D4 | Superseded by D14. Round 1's form: `restore` fills only what memory does not know, behind a fence of what changed while the load was pending (N57) | A load must never overwrite newer data nor undo a removal | Blocking every op on the cache during the load; applying records as a ranged `put` |
| D5 | `cache()` of a persisted cache resolves after the load, at most 5 s (N46, N57) | The first read after a reload must be served from disk, not race the load and fetch | Resolving at once and loading in the background (the reload fetches anyway) |
| D6 | Removals are flushed at once, strict, and the call that made them answers once they are durable, or once persistence stopped and the records' deletion settled; this covers a `put`, `hydrate` or `get` whose data caused one (N58, N49; revised at round 1; the bound revised by D16) | A lost addition is harmless; a lost removal would let the next session load what the app withdrew | Debouncing removals like additions |
| D7 | Failures never reject: `'unavailable'` for an open failure or a load past 5 s, `'error'` for a failed read; a stopped cache's records are deleted (N59; the write failure policy revised by D16) | The cache keeps working; the disk must not keep what memory withdrew | Retrying forever; stopping on the first failure; keeping the records |
| D8 | The page snapshot omits `finalizedUntil`, and a version change rewrites the whole cache (§4.10.2, §4.10.4) | A watermark change then rewrites one small record; a version change must reach every page, since each page names its version | A watermark in every page (each advance rewrites every page) |
| D9 | The SharedWorker writes plainly; it takes the lock from slice (b) (N52) | It is normally the only writer, and D2 makes a second writer safe; the lock keeps its write out of a merging engine's read-write window | Merging in the SharedWorker too (a read per dirty page per flush, for the deploy-skew case only) |
| D10 | `PersistStore` seam, `MemoryStore` for the logic, a conformance suite over `fake-indexeddb` for the adapter (N60; a fake lock manager added by D16) | The logic needs quota failures, held transactions and counts; the adapter needs real key ranges and atomic abort | `fake-indexeddb` everywhere; the fake alone |
| D11 | `persist: true` is inert, without an event, where there is no IndexedDB or no persister (N45) | A server render in Node shares the browser's config | `ConfigError` (breaks server rendering); a `persistStopped` at every server-side open |
| D12 | The database is opened lazily; `clearAll` before any open uses `ifExists`, so an app that never persists gets no database (§4.10.6) | No side effect for apps that do not use persistence | Always opening the database; deleting it at `clearAll` (blocks on other tabs' connections) |
| D13 | Dirty state kept per page, the stable container of segments (N15), for starter §3.7's "dirty-segment set" | Segments split and join; pages do not | Tracking segments (their identity changes with every split) |
| D14 | **Memory is canonical on load** (N57, replacing D4): `restore` applies records only into a cache that knows nothing and throws otherwise; any change while the load is pending abandons the load, and the cache's next flush rewrites its records from memory | Rounds 1 and 2 found two different leaks of the same slot-level merge; removing the merge removes the class. Handles already wait for the load, so only `clearAll` from another tab, a raw request or a directly driven `Engine` can touch a loading cache, and a cold start there costs nothing anyone relies on | Holding every op on the cache in the RPC server until the load ends: a per-cache queue in the server, `clearAll` waiting up to 5 s and then undoing what the load wrote, for a case handles already cover (the load of about 16 pages measures 6.8 ms, so the handle wait is the only cost that matters and it is already paid). A monotonic epoch in the cache record with pages ignored unless their epoch matches: a field and a rule to get what the full rewrite's one transaction, deleting and putting atomically, already gives. Keeping the fence with the R2-1 fix (mark skipped slots dirty): a third patch on the design the convergence check says to stop patching |
| D15 | **A page record holds only the points inside its coverage** (N55 revised): its segments are those of `snapshot(r)` for each covered range `r` | A record is then exactly what a load applies, so "the disk equals `recordsOf(S)`" is one mechanical check after any load and one flush, and no stored point exists that memory would refuse. Fewer bytes too | Storing every present point of the hull (the first design): simpler to produce, but the disk then holds data no load applies, which is what R2-1 exploited |
| D16 | **One writer per persister with one deadline per job** (N61; N58, N59 revised): flushes, `clearAll` and cleanups run one at a time, removal-carrying jobs first; each has `timeoutMs` from when it is due; the lock request carries an `AbortSignal` that fires then; a store call still pending is abandoned; at the deadline the cache stops (for `clearAll`, every tracked cache); retries wait `debounceMs` until then | The round-1 bound was a sum of bounded parts with an unbounded count (R2-2); one deadline per job bounds the sum by construction, and a removal's call then waits at most two deadlines (about 10 s). The retry count, the per-call timeout and a separate lock bound go | One writer per cache (a removal still waits behind the running job's lock grant; concurrency buys nothing under one lock). `ifAvailable` on the lock (two tabs flushing at once would stop each other's persistence). A deadline per attempt plus a retry count (what round 2 found unbounded). A second option for the flush deadline (`timeoutMs` already names the one bound; `cache()`'s 5 s is user-confirmed and the same option). Per-cache deletions after a failed `clearAll` (a disk that refused the clear for a deadline refuses them too, at one deadline per cache) |
| D17 | **Merge mode builds the merged page with `hydrate`** (N52 revised): a scratch `CacheState` carrying the writer's version and watermark, hydrated with the writer's page then the stored page, then `invalidate` for each removed range | `hydrate`'s rule, fill only where nothing is known and never at or after the watermark, is approved (N35), implemented and tested, and it is exactly the merge rule; no `restore`, no fence, no stored watermark can reach the merge | A scratch `restore` behind a fence (round 1's form, which R1-2 broke and the new `restore` precondition forbids); a merge rule of its own on coverage sets and points (a second implementation of what `hydrate` pins) |
| D18 | **`restore` throws on a cache that knows something** rather than falling back to `hydrate`'s fill rule | A silent fill rule would be a specified behaviour that a contract test could pin and a reviewer could find edge cases in (R1-1 was one); a thrown programming error keeps the design's one rule visible and catches a persister bug at once | Specifying `hydrate`'s rule for that case and relying on the persister never to reach it |

## Round 1 — reviewer verdict: block

Design review of b64a822..181d759 (before the rebase on `main` 15fa506; now 20659e2..c962134; `.reviews/step-38/round-1.md`). Each finding was validated by walking its scenario through the rules as written.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | Restore overwrites a provisional point when the stored watermark is higher | accepted | Valid: §4.10.5 step 4 advanced the watermark to 200, then step 6 subtracted only the volatile region after the advance, so the point put at 150 during the load (provisional under watermark 100) was replaced, against rule 1. Fixed at round 1 by a patch: step 6 subtracted every slot where the cache held a point, judged before the stored watermark applied, with property (b′). Superseded by the redesign after round 2 (D14): `restore` throws on a cache holding any point or coverage, and a change during the load abandons it, so the state cannot reach `restore` at all; pinned by the new property (b) |
| R1-2 | P0 | The merge's scratch restore lets the stored watermark advance the writer's | accepted | Valid: the fence `{ removed }` left `watermarkChanged` false, so the scratch advanced to 200 and the merged page covered 150 beside a cache record saying 100, contrary to step 5's own formula. Fixed at round 1 by building the scratch with `S`'s watermark and `watermarkChanged: true`; sibling fixed by excluding removals made between the read and the write (`removedNow`). Round 2 confirmed the fix. The redesign (D17) keeps both properties (M6, M7) and removes the fence: the scratch is built with `hydrate`, which never covers at or after the scratch's watermark |
| R1-3 | P0 | A removal is acknowledged after a failed first write | accepted | Valid: `flush(id)` resolved when its attempt settled, failure included, so `invalidate` answered with the retry still 5 s away. Fixed at round 1 by a removal count and `durable(id, mark)`, which waited through retries; siblings fixed (`clearAll`'s failure path; a version-mismatch clear or a first watermark caused by a `put`, `hydrate` or orchestrated `get`; removal-carrying plans `strict`, row N49 widened; a store-call bound of 5 s, row N59). Round 2 (R2-2) found the resulting wait still unbounded through lock acquisition and queued flushes. Superseded by the redesign (D16): one writer, one deadline per job, lock requests aborted at the deadline; properties (d) and (f) |

Sibling outside this step: `hydrate` (§4.5, N35, implemented in step 15) subtracts the volatile region after its own watermark advance, so a snapshot with a higher watermark replaces a provisional point the browser holds between the two watermarks. N35 approved this, and by N19's rule a source authoritative below its watermark may replace provisional points. In practice a page hydrates before its first live read, so the browser rarely holds one. Not changed here; listed for the user (decision concerns after round 1).

## Round 2 — reviewer verdict: block

Design review of 20659e2..38e3fcc (`.reviews/step-38/round-2.md`). Each finding was validated by walking its scenario through the round-1 rules.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P0 | R1-1's restore fix leaves skipped authority on disk | accepted | Valid: after the round-1 fix, `restore` kept the provisional point at 150 and left the slot uncovered, but reported no change and `rewrite: false`; the page record on disk still covered 150 with value 10, nothing marked it dirty, and the next reload restored it without a fetch, against §4.10.6's canonical-record property. The same area as R1-1, two rounds running: the convergence check applies (below). Redesigned (D14, D15): a change during the load abandons it and the next flush rewrites the cache from memory, so the disk cannot keep what memory rejected; `restore` never runs against a cache that holds a point. Walked through under "Convergence check"; pinned by §4.10.5 property (b) and §4.10.6 properties (g) and (h) |
| R2-2 | P1 | Lock acquisition bypasses the bounded removal wait | accepted | Valid: §4.10.7 step 2 requested the lock with no deadline, and the 5 s store-call bound counted per call, so an `invalidate` behind ten merge flushes of other engines, or behind a held lock, waited beyond any stated bound. The same area as R1-3, two rounds running: the convergence check applies. Redesigned (D16): one writer per persister, one deadline per job from when it is due, removal-carrying jobs first, the lock request aborted at the deadline, the cleanup bounded the same way; a removal's call waits at most two deadlines. Walked through below; pinned by §4.10.6 property (f) and §4.10.7 (M8) |
| R2-3 | P2 | The implementation plan still prescribes R1-3's broken acknowledgement | accepted | Valid: the slice (a) row for `rpc/server.ts` said `invalidate`, `clear` and `setFinalizedUntil` await `flush(cacheId)`, and omitted `put`, `hydrate` and the orchestrated `get`. The row now states §4.10.8's rule: `removals` before, `durable` after when the count grew, for every op that names a cache |

### Convergence check: redesigned

Both areas drew findings in rounds 1 and 2, so under `docs/workflow.md` step 7 the areas were redesigned rather than patched a third time (commit 15668f9). The root causes, and the rules that replace them:

- **Restore (R1-1, R2-1).** The load reconciled disk and memory slot by slot while memory kept changing, and the result of that reconciliation was never written back: every patch moved the line between "memory wins" and "disk wins" and left a slot on the wrong side, in memory (R1-1) or on disk (R2-1). New rules: `cache()` already keeps every handle behind the load; any change to a cache while its load is pending abandons the load and marks the cache for a full rewrite from memory; `restore` applies records only into a cache that covers nothing and holds no point, and throws otherwise; a page record holds exactly the points a load applies. There is no state in which stored and live data of one slot are compared, so the class cannot recur.
- **Durability (R1-3, R2-2).** Each step on the way to the disk had a bound of its own (a store-call timeout, a retry count, the debounce, the lock, the queue) and the acknowledgement waited for their sum, whose number of terms nothing bounded. New rules: one writer per persister runs one job at a time; every job has one deadline, `timeoutMs` after it is due, against which queue wait, lock wait (the request carries an `AbortSignal`), store calls and retries all count; removal-carrying jobs run before the rest; at the deadline the job stops its cache and one cleanup, bounded the same way, follows. A removal's call therefore waits at most two deadlines, whatever is ahead of it.

Each scenario of rounds 1 and 2, walked through the new rules:

1. **R1-1 and R2-1** (memory at watermark 100; during the pending load a `put` without `meta` writes provisional 150 = 20; the disk has watermark 200 and covers 150 with 10). The `put` is a `write` change for a loading cache: the load is abandoned, `open` resolves, the cache is running with `rewrite` set, and the read's result is ignored when it comes. Memory holds 150 = 20, provisional and uncovered, as the `put` left it; nothing from the disk is applied. The `write` makes a flush due after the quiet spell; its plan is the full rewrite: every page record deleted, `recordsOf(S)` put, and `S` covers nothing, so the cache's records are deleted entirely. A reload then starts cold and fetches 150; it can never restore 150 = 10 as covered. Reaching this state at all needs a raw request by cache id, since no handle exists before the load; through handles the load applies in full and nothing is rewritten.
2. **R1-2** (merge flush; `S` at watermark 100; the stored cache record says 200 and a dirty page's record covers 150). The scratch is built with `S`'s watermark 100 and hydrated with `S`'s page, then with the stored page: `hydrate` fills only below the scratch's `volatileFrom`, so 150 stays uncovered; the stored cache record's watermark is never read into anything. The merged page covers nothing at or after 100 and `putCache` says 100 (M6).
3. **R1-3** (an `invalidate`; the first write fails). The `remove` change makes a strict flush job due at once, with a deadline 5 s later. The attempt fails; the job retries after 1 s with the union of the dirty state; the second attempt succeeds before the deadline; the durable count reaches the removal; `durable` resolves and the `invalidate` answers. Had every attempt failed, the deadline would have stopped the cache with `'error'`, queued the cleanup job, and the call would have answered when the cleanup settled, within one more deadline. At no point does a failed attempt resolve `durable`.
4. **R2-2** (ten merge flushes of other caches, each 4 s to read and 4 s to write, ahead of an `invalidate`; or a lock held by another tab). Within one engine: the ten jobs are addition jobs; the `invalidate`'s job carries a removal and is queued ahead of every one of them, so it waits only for the running job, whose own deadline is at most 5 s away and whose lock is released when it is abandoned. Across engines: the job's lock request carries a signal that aborts 5 s after the removal; a held lock means the request rejects with `AbortError`, the job stops the cache with `'unavailable'`, the cleanup's request is bounded the same way, and the call answers within 10 s of the removal (M8). Within one engine the `invalidate` typically lands in milliseconds, since a removal job precedes the queued additions.
5. **R2-3** is a documentation row; fixed above.

What the redesign gives up, for the user's attention: a cache changed during its load starts cold instead of merged (unreachable through handles); the worst-case wait of a removal's call drops from about 30 s to about 10 s, with retries until the deadline instead of three attempts; page records no longer store points outside coverage.

## Contract-test changes

None. No contract test exists yet for this step; the lists above are what Codex writes from §4.10 as redesigned.

## Decision concerns

For the user; the design works around each.

1. **No final flush in the dedicated hosting.** `dispose()` terminates an owned dedicated worker at once (§4.8), so the flush that the last connection's dispose starts never runs there; the loss is the last debounce window, which is harmless for additions, and removals were already written at once (N58). Options: (a) accept it (recommended: nothing changes, the loss is bounded and safe); (b) let a dedicated worker with a persister close itself after a final flush, and have the client post `dispose` without terminating it (changes §4.8's dispose rule; a worker that never closes leaks until its page ends); (c) flush on the page's `visibilitychange` to hidden (a new client-to-worker hint, an additive op).
2. **Coverage per page instead of in the cache record (N55)** departs from the roadmap sketch. Nothing locked depends on the sketch, and starter §3.7's reconcile rule holds by construction, but the user may want to confirm it.
3. **`cache()` waits up to 5 s for a load** of a persisted cache (N46). The measured load is milliseconds; the bound only matters when IndexedDB stalls, and then persistence for the cache stops. Confirm the bound, or choose a shorter one.

## User decision (2026-10-30)

The user confirmed the design as written: N45–N60, and the four flagged items as recommended (no final flush in the dedicated-worker hosting; N55 coverage in each page record; the 5 s bound on `cache()` waiting for the load; the new public surface `CacheConfig.persist` and `persistStopped`). Next: Codex design review, then Codex contract tests, then slices (a), (b) and (c), one pull request each.

## Decision concerns after round 1

Raised after the user's decision above, so not covered by it.

1. **`hydrate` and provisional points under a higher snapshot watermark** (round 1 sibling of R1-1). `hydrate` (N35) replaces a provisional point the browser holds between its watermark and the snapshot's; the persistence load now cannot meet one at all (N57 as redesigned: a load applies only into a cache that knows nothing). Options: (a) leave `hydrate` as approved (recommended: N19 makes a snapshot authoritative below its watermark, and a page hydrates before its first live read); (b) give `hydrate` a rule that keeps every slot holding a point (a change to N35 and its contract tests, on a fix branch of its own).

## Decision concerns after round 2

The redesign keeps every intent the user confirmed (per-cache opt-in, eager loads, `persistStopped`, the app calling `storage.persist()`, one database with two stores, read-merge-write under a Web Lock, records mirroring the `Snapshot` envelope, `clearAll` emptying the disk, removals never acknowledged before they are durable or persistence stopped and cleaned up, failures never rejecting a call). Three things the user can observe changed, and should be confirmed or overruled:

1. **The bound on a removal's call** (N58, N59). About 10 s at most, down from about 30 s: one deadline of 5 s for the write (queue, lock, retries included), one more for the cleanup after a stop. Persistence of a cache therefore stops after 5 s of a failing or stalled disk instead of after three attempts over about 10 s. Options: (a) keep 5 s (recommended: the same `timeoutMs` the user confirmed for `cache()`; a disk that cannot commit a small transaction in 5 s is not one to wait for); (b) a longer flush deadline through a second option, say 10 s (a removal's call could then take 15 s).
2. **A cache changed while its load is pending starts cold** (N57). Nothing stored is applied and the disk is rewritten from memory. Through handles this cannot happen, since `cache()` resolves only after the load; it can through another tab's `clearAll` (where cold is right), a raw request or a directly driven `Engine`. The round-1 design merged instead. Options: (a) accept (recommended); (b) hold such requests in the RPC server until the load ends (a per-cache queue in the server; `clearAll` would wait for every pending load, up to 5 s, and then still clear what the load wrote).
3. **Page records hold only covered points** (N55). Not visible through any API; it changes the stored bytes of a page (fewer) and the statement of the record. Listed because N55 was confirmed in its earlier wording.
