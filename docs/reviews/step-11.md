# Step 11 — Fetcher orchestration, dedup and auth events

Branch: `feat/11-orchestrator` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 6 · Status: in review · Verdict after triage: blocked

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

## Contract-test changes

None (no contract tests for this step).

## Decision concerns

None.
