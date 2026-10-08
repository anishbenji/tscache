# Step 11 — Fetcher orchestration, dedup and auth events

Branch: `feat/11-orchestrator` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 1 · Status: in review · Verdict after triage: blocked

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

## Contract-test changes

None (no contract tests for this step).

## Decision concerns

None.
