# Step 11 — Fetcher orchestration, dedup and auth events

Branch: `feat/11-orchestrator` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 11 + adversarial (cap raised once by the user) · Status: settled · Verdict after triage: merge (round 11 fixes unreviewed, per the user's decision)

Not an engine step: tests were written with the code (fetcher modules served as data: URLs through the real RPC path; one Playwright spec with two pages sharing one fetch).

Round 1 ran twice: the first pair of sessions hit Codex's usage limit mid-review (paused until the reset per the standing rule); the second round 1 completed, while its adversarial companion was cut off by the 2-hour background limit before writing a report and is rerun after this triage.

## Round 1 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | Two tabs initializing concurrently with different fetcher modules both passed the conflict check before either import resolved; the last import replaced the shared fetcher | accepted | Reproduced in reasoning. Fixed in 4c7585e: the module name is reserved before the import starts and the load promise is shared; a different module is a `ConfigError` in `init-err`. Test with three concurrent connections |
| R1-2 | P0 | The fence retry filtered out any miss overlapping an earlier applied range, so a dropped second fetch of the same get was never re-requested | accepted | Reproduced. Fixed in 4c7585e: after a drop, everything still uncached is re-requested once minus ranges that failed or were auth-blocked (range subtraction), since a clear wipes applied ranges too. Test: coverage in the middle, two in-flight fetches, version clear between their completions |
| R1-3 | P0 | Flank expansion stepped past ±(2^53 − 1), so a fully covered single-slot read at the boundary threw `InvalidRangeError` once a fetcher was loaded | accepted | Reproduced. Fixed in 4c7585e: no probe when there are no misses; probe and extensions clamp to the safe domain. Test at `MAX_SAFE_INTEGER` |
| R1-4 | P0 | Warnings returned by an orchestrated put were discarded (locked overlap-warning decision) | accepted | Fixed in 4c7585e: broadcast as request-scoped `mergeWarning` once per deduplicated fetch, under the id of the get that started it (`Orchestrator.get` takes the request id). Test |
| R1-5 | P1 | A late auth failure from a request issued under old credentials re-invalidated auth after `updateAuth` had restored it | accepted | Fixed in 4c7585e: fetches carry an auth generation; a failure from a superseded generation does not invalidate. Test |

## Round 2 — reviewer verdict: block

Completed on the fourth attempt (three sessions stalled; retried hourly per the user's rule). R1-1, R1-2, R1-4, R1-5 confirmed fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P0 | The coverage probe clamped to ±(2^53 − 1) in ms, which `snapOut` then pushed past the domain: an aligned single-slot read near the boundary on an offset grid threw (R1-3 incomplete) | accepted | Reproduced. Fixed in 396bc7e: the probe is built on slots and only steps to a neighbour that is a safe grid point. Test at `MAX_SAFE_INTEGER − 8` on the 10/3 grid |
| R2-2 | P0 | Subtracting failed ranges in ms produced off-grid retry ranges (`[24,73]` instead of `[33,73]`) | accepted | Reproduced. Fixed in 396bc7e: all range math moved to slots (N9); retry ranges are aligned by construction. Test |
| R2-3 | P0 | One overlapping failure labelled a whole merged miss; a range whose retry was fenced should stay `uncached` | accepted | Reproduced. Fixed in 396bc7e: a remaining miss is cut at fetch boundaries and each piece carries its own reason. Test |
| R2-4 | P1 | A get issued after `updateAuth` joined an in-flight fetch started under the old credentials, so its late 401 returned `auth-pending` without a fresh attempt | accepted | Fixed in 396bc7e: in-flight entries carry their auth generation; a stale one is not joined, a new fetch starts. Test |
| R2-5 | P1 | The R1-5 regression test could not fail: the fixture checked its mode before stalling, so neither fetch threw | accepted | Fixed in 396bc7e: the fixture can fail with the auth marker after its stall; the test now exercises the late 401 |

**Convergence rule.** Range math drew findings in rounds 1 and 2, so 396bc7e moves it wholesale onto slots through `grid.ts` instead of patching the ms arithmetic (the N9 rule applied to the orchestrator as well).

## Round 3 — reviewer verdict: block

R2-1 to R2-5 confirmed fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P0 | A fence retry could join an in-flight fetch that the same clear had already made stale (dedup checked only the auth generation) | accepted | Reproduced. Fixed in c931a98: in-flight entries carry the cache generation; a stale one is not joined. Test with three fenced fetches |
| R3-2 | P1 | During an asynchronous `fetcher.updateAuth()` the generation was already bumped, so a fetch issued with the old token carried the new stamp and its late 401 invalidated the new credentials (R1-5 incomplete) | accepted | Reproduced. Fixed in c931a98: the context and generation switch only after the hook completes, and a fetch waits for an in-progress transition. Test with a stalled hook |
| R3-3 | P1 | A superseded `updateAuth` completing late restored auth after a newer failure | accepted | Fixed in c931a98: updates apply one at a time in arrival order, so no obsolete completion can run after a newer one. Test with two concurrent updates (arrival order across two ports is not fixed; the test asserts one transition at a time) |

## Round 4 — reviewer verdict: block

R1–R3 fixes confirmed present.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R4-1 | P0 | A get under invalid auth awaited an in-progress `updateAuth` hook before answering, so it could hang on a human-speed refresh (design y) | accepted | Reproduced. Fixed in c67e1d4: invalid auth answers `auth-pending` before the transition wait (and again after it). Test races a get against a stalled hook |
| R4-2 | P1 | A joining tab's `init.fetcher.context` replaced the context without advancing the auth generation, so its get joined an old-token fetch whose late 401 then invalidated the new credentials | accepted | Reproduced. Fixed in c67e1d4: a joining tab whose context differs goes through the serialized `updateAuth` path; one with the same context (the normal case) changes nothing. Test with two tabs and a stale fetch |
| R4-3 | P1 | No test for a malformed fetcher response | accepted | Added in c67e1d4: misaligned timestamps → `fetch-failed` with the `PutError` name and message, nothing cached, the next get retries |

## Round 5 — reviewer verdict: block

Other accepted fixes confirmed; R4-1 and R4-2 found incomplete.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R5-1 | P0 | A get that was waiting for an in-progress `updateAuth` hook stayed blocked when auth became invalid meanwhile (R4-1 incomplete) | accepted | Fixed in 94dd109 by redesign (below): fetches no longer wait for a transition at all. Test: 401 lands during a stalled hook, the get answers at once |
| R5-2 | P1 | The structural context comparison treated two `Map`s as equal (no enumerable keys) and recursed forever on cycles | accepted | Fixed in 94dd109: only the identical value counts as the same context; anything else is conservatively new material (documented in §4.9). Test with `Map` contexts |
| R5-3 | P1 | A tab joining while the first import was still pending had its context applied before `#fetcher` existed, skipping the hook | accepted | Fixed in 94dd109: the joining context is applied after the shared load completes. Test with a slow module |

**Convergence rule.** The auth transition drew findings in rounds 3, 4 and 5, so 94dd109 removes the mechanism that kept leaking instead of patching it: no fetch waits for a transition; a fetch started meanwhile carries the credentials and generation still in place, and a stale-generation 401 is ignored. One consequence, recorded in §4.9: a tab joining with an equal-by-value context (every second tab in practice) runs the fetcher's `updateAuth` hook once more and advances the generation; two tests' expectations changed accordingly.

## Round 6 — reviewer verdict: merge after fixes

R1–R5 fixes confirmed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R6-1 | P1 | `updateAuth` from a pull-model tab (no fetcher yet) stored context that the worker's later first fetcher then received instead of `undefined` | accepted | Fixed in 2ebb106: without a fetcher configured `updateAuth` is a no-op, as §4.9 states. Test |

## Round 7 — reviewer verdict: merge after fixes

R1–R6 fixes confirmed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R7-1 | P1 | `updateAuth` while the first fetcher import was still pending ran before `#fetcher` existed, skipping the hook (R5-3 covered joins, not direct calls) | accepted | Fixed in e26db5e: the serialized update awaits the pending load before the hook; `get` does not wait. Test with a slow module |
| R7-2 | P1 | A failed first load reset the module slot but kept its context, which the next successful first load then delivered | accepted | Fixed in e26db5e: a first load sets the context unconditionally (including `undefined`). Test |

## Round 8 — reviewer verdict: merge after fixes

R1–R7 fixes confirmed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R8-1 | P1 | The Playwright cross-tab dedup spec passed without in-flight dedup: the fixture answered within a microtask, so the second page's get was served from cache | accepted | Fixed in dfbb4dc: the fixture holds its answer for `context.delayMs` (400 ms) so both gets overlap, and the spec asserts the overlap |

## Round 9 — reviewer verdict: merge

No findings; R8-1 confirmed fixed. The scheduled adversarial pass, cut off twice earlier (usage limit, then the 2-hour background limit), runs after this round.

## Adversarial round — focus: dedup keying, flank coalescing, authInvalid/updateAuth races, get never blocking on auth — reviewer verdict: block

Completed on the third attempt (usage limit, then the 2-hour background limit, then the 21:23 reset).

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| A1-1 | P0 | The fetcher received the orchestrator's own range object; a fetcher mutating `req.range` widened the authoritative write (deleting cached points) | accepted | Reproduced. Fixed in 81422d1: the fetcher gets a copy. Test with a mutating fetcher |
| A1-2 | P0 | A get waiting on several fetches stayed pending after one of them invalidated auth, until the others returned (design y) | accepted | Reproduced. Fixed in 81422d1: `AuthState.whenInvalid` releases the wait; ranges still out are reported `auth-pending` while their fetches finish. Test |
| A1-3 | P1 | A fetch starting while the fetcher's hook was mid-swap could use the new token but carry the old generation, so its 401 was ignored and auth never flipped (R3-2 beyond the context-only case) | accepted | Fixed in 81422d1: during a hook transition no fetch starts; uncached ranges answer `auth-pending` at once. Two earlier tests rewritten to the new rule; §4.9 updated |
| A1-4 | P1 | Elapsed time in the Playwright dedup spec did not prove the two gets overlapped (R8-1 incomplete) | accepted | Fixed in 81422d1: page B records when it issued its get and page A when its get completed (same machine clock); the spec asserts B issued before A's fetch ended |

## Round 10 — reviewer verdict: merge after fixes

Adversarial fixes confirmed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R10-1 | P1 | Every get that waited on fetches raced a shared long-lived "auth invalid" promise, leaving a reaction behind per successful get (≈37 MB after 100 000 gets) | accepted | Fixed in 588cbda: a removable `onInvalid` subscription, unsubscribed when the fetches finish. Test in 2378535 |
| R10-2 | P1 | The browser dedup spec stamped page B before awaiting `cache()`, so a slow handle could still let B read cached data (A1-4 incomplete) | accepted | Fixed in 2378535: handle first, stamp right before the get, fetch held 1.5 s, B must have posted at least a second before A's fetch ended |

Round 10 is the cap (docs/workflow.md, review loop step 8) and it raised P1s, so the loop was escalated. The user authorized one more round (2026-10-08), after which the pull request opens regardless.

## Round 11 — reviewer verdict: block

R10 fixes confirmed. The round the user authorized beyond the cap.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R11-1 | P0 | A fetcher throwing synchronously with the auth marker invalidated auth before the get's `onInvalid` subscription existed, so a get also waiting on a slow fetch stayed pending until that fetch returned (A1-2 re-raised for the synchronous path) | accepted | Reproduced. Fixed in 2e15f20: `onInvalid` notifies a subscriber at once when auth is already invalid. Test with a fetcher that throws synchronously for one range and stalls on another |
| R11-2 | P1 | The R10-1 regression test only counted releases, which the original leak also produced; it did not prove the subscription was removed | accepted | Fixed in 2e15f20: `AuthState` exposes its waiter count and the test asserts it is zero after fifty successful gets |

The user decided (2026-10-08): one more round, then open the pull request regardless. Round 11 was that round, so its two fixes are verified by their regression tests and `bun run ci` but have not been through a further Codex round. The pull request records this.

## Contract-test changes

None (no contract tests for this step).

## Decision concerns

None.

## Merge request

**Scope.** Step ⑪ of the commit plan: fetcher orchestration in the worker (`orchestrator/orchestrator.ts`, `orchestrator/auth.ts`), wired through `RpcServer` so `get` fetches misses and `updateAuth` reaches the fetcher. Architecture §4.9 (new), N29–N31, §2.5 fetcher obligations; the `./fetcher` subpath types. Fetcher loading at `createClient` (N30), slot-based coalescing with a one-slot flank extension clamped to safe grid points, exact-range in-flight dedup keyed by cache and range under the auth and cache generations (N31), a version fence with one retry by subtraction (N29), per-piece miss annotation, and auth state with `authInvalid` broadcast and `onInvalid` subscriptions.

**Decisions taken on this branch** (user-confirmed 2026-10-08). N29: a version mismatch mid-fetch refetches once. N30: the fetcher module loads at `createClient`; a load failure is a startup error. N31: dedup is exact-range only; subtracting in-flight ranges from new requests is on the roadmap. Settled by the implementer and recorded in §4.9: a `get` never blocks on auth (uncached ranges answer `auth-pending` while auth is invalid or a hook transition is running); a stale-generation 401 is ignored; a tab joining with an equal-by-value context runs the fetcher's hook again; the fetcher receives a copy of the range.

**Review outcome.** Eleven rounds plus the scheduled adversarial pass, one round past the cap by the user's decision. Rounds 1–5 circled the auth transition until 94dd109 removed the waiting mechanism (convergence rule); rounds 6–8 fixed `updateAuth` ordering against the first load and the cross-tab dedup spec; round 9 was clean. The adversarial pass raised two P0s (fetcher mutating the orchestrator's range; a get stranded after one of its fetches invalidated auth) and two P1s, all fixed in 81422d1. Round 10 found the per-get subscription leak and a timing gap in the browser spec; round 11 found the synchronous-throw variant of the stranded get and a weak leak test. Both round 11 fixes are covered by regression tests and the full gate but have not been reviewed by Codex, as the user decided.

**Confidence: high on the Node path, medium on the auth edge cases.** 35 orchestrator tests drive a data-URL fetcher through every mode (success, failure, auth marker as rejection and as synchronous throw, slow, malformed): coalescing, flank clamping, dedup across clients, version fence and retry, per-piece misses, `updateAuth` serialization against a pending load, generation fencing of stale 401s, waiter release and cleanup. One Playwright spec proves cross-tab dedup in a real SharedWorker by timing. The auth area drew findings in ten of twelve rounds, which is why the last two fixes are flagged rather than hidden.

**Blast radius: the worker's `get` and `updateAuth` now reach the fetcher.** `RpcServer` constructs the orchestrator; `init` loads the fetcher before `init-ok`. Engine, RPC wire and client surfaces are unchanged beyond the new `authInvalid` client event. 1047 Node tests and 5 browser specs pass under `bun run ci`.

**Known limits, by design.** Exact-range dedup only (N31); a tab that dies mid-fetch leaves its request to finish in the worker (N28 heartbeat on the roadmap); auth events are verified in Node, the multi-tab `authInvalid` broadcast is step ⑫'s Playwright work.
