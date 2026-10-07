# Step 08 — Engine assembly

Branch: `feat/08-engine` · Reviewer: GPT-6.1 Sol (high) · Rounds: 4 · Status: settled · Verdict after triage: merge

## Round 1 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | `src/entries/engine.ts` still exported nothing, so `import { Engine } from "tscache/engine"` failed; `dist/engine.js` was empty | accepted | Confirmed from the build output. Fixed in 26b917c: the entry exports `Engine`, `EngineEvents` and the public types and errors a Node consumer needs; a test imports the entry and runs a cache through it (`dist/engine.js` is now 52.8 kB) |
| R1-2 | P0 | A listener that throws for one cache interrupted `clearAll`, leaving later caches uncleared and unnotified (N22) | accepted | Reproduced. Fixed in 26b917c: every cache is cleared and notified, the first listener error is rethrown at the end; regression test added |
| R1-3 | P1 | `has("missing")` was left unpinned by the contract tests | accepted | Pinned to `false` in 26b917c (replacing the author's clarification comment; recorded below) |

## Round 2 — reviewer verdict: block

R1-1 to R1-3 confirmed fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P0 | A version-changing put whose write then failed had already cleared the cache and adopted the version, but its throw bypassed the event; the retry emitted nothing either | accepted | Reproduced. Fixed in 565a6fa: `CacheState` takes an `onVersionClear` hook (architecture §4.5), called after the put applied or, on a failed write, before the error propagates; the engine emits from it. Regression test: event once, error propagated, retry silent. Follow-up 21819df moves the recovery out of `put` for the complexity gate |
| R2-2 | P2 | `Engine.setFinalizedUntil` lacked TSDoc on the two directions and the need to refetch | accepted | TSDoc added to every `Engine` method in 565a6fa |

## Round 3 — reviewer verdict: merge after fixes

R2-1 and R2-2 confirmed fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | In the failed-write path, a throwing `cacheCleared` listener replaced the write error the caller must see | accepted | Reproduced. Fixed in d6be9f9: the listener's error is dropped in that path and the write error propagates (recorded in §4.6); regression test with both failures |

## Round 4 — reviewer verdict: merge

No findings; R3-1 confirmed fixed.

## Contract-test changes

`engine-e2e.test.ts`, lifecycle test: the invalidate range `{ start: 12.5, end: 22.5 }` was changed to `{ start: 13, end: 22.5 }`. The test expected slots 13–23 to be forgotten and slot 3 to stay covered, but under N1/§4.1 an unaligned start floors outward, so 12.5 snaps to the grid point 3 and the expectation contradicted the locked rule. Starting at the aligned 13 produces exactly the states the author asserted for the rest of the scenario. No assertion was weakened or removed.

`engine-cache.test.ts`: the author's "has(unknownId) unpinned" comment was replaced by a test asserting `false`, per the settled §4.6 rule.

## Decision concerns

None. Three spec ambiguities raised by the contract-test author were settled by the implementer and recorded in architecture §4.6: `has()` answers `false` for an unknown id (the one exception to the `UnknownCacheError` rule); `cache()` returns the resolved config the cache was created with; the emitter rethrows the first listener error after all listeners ran.

## Merge request

**Scope.** Step ⑧ of the commit plan: engine assembly. `Engine` (`engine/engine.ts`), `Emitter` (`engine/emitter.ts`), the `./engine` package entry populated, and an `onVersionClear` hook on `CacheState`. Architecture §4.6 (new), N20–N22, §4.5 hook. The in-process mode is usable end-to-end: create a cache, put, get with coverage and misses, invalidate, watermark, version bump, clear, events — all under Node with no DOM or worker globals (tested).

**Decisions taken on this branch** (user-confirmed 2026-10-07). N20: every resolved config field except `version`/`finalizedUntil` must match on `cache()`, and a joining tab's dataset fields are ignored. N21: the RPC server emits request-scoped `mergeWarning`; the engine emits only cache-scoped `cacheCleared`. N22: `clearAll` empties caches and keeps their configs. Settled by the implementer and recorded in §4.6: `has()` answers `false` for an unknown id; `cache()` returns the creation-time resolved config; the emitter rethrows the first listener error; in the failed-write path after a version clear the write error is the one the caller sees.

**Review outcome.** Four rounds. Round 1: two P0s (empty `./engine` entry — `dist/engine.js` had nothing; a throwing listener interrupted `clearAll`) and an unpinned test. Round 2: one P0 (a version-changing put whose write then failed lost its `cacheCleared` event) and a TSDoc P2. Round 3: one P1 (listener error masking the write error in that path). Round 4: no findings. Two contract-test changes, both recorded above: an invalidate range corrected to agree with N1, and `has("missing")` pinned.

**Confidence: high.** Every finding reproduced by a test before its fix and confirmed fixed by the reviewer the next round. The e2e test asserts exact `GetResult`s through a full lifecycle; the entry test runs a cache through the built export surface.

**Blast radius: small.** New modules plus the entry and one additive constructor parameter on `CacheState`; no other module's behaviour changed. 971 tests pass under `bun run ci`; 96 of them (six files) are the step's contract tests.

**Known limits, by design.** Every `get` is cache-only until orchestration (step ⑪). The engine exposes no getters for the current version or watermark; the RPC layer reaches them through `CacheState` if needed. Request ids and `mergeWarning` emission arrive with the RPC server (step ⑨).
