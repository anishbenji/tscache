# Step 11 — Fetcher orchestration, dedup and auth events

Branch: `feat/11-orchestrator` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 2 · Status: in review · Verdict after triage: blocked

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

## Contract-test changes

None (no contract tests for this step).

## Decision concerns

None.
