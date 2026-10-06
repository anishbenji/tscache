# Step 07 — Invalidation suite (watermark, invalidate, clear, version)

Branch: `feat/07-invalidation` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 2 · Status: in review · Verdict after triage: blocked

## Round 1 — reviewer verdict: merge after fixes

Both implementation paths behaved correctly in the reviewer's probes; the findings concern missing regression tests.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | No test covers the coverage withdrawal when the store write fails | accepted | Added in 9c228e3: the write is made to throw for a ranged replacement and an unranged upsert; the claim becomes a miss, the flanks stay covered, watermark and version are unchanged, the error is rethrown, and the retry succeeds. A version mismatch whose write then fails is also pinned (cleared, consistent) |
| R1-2 | P1 | No test covers warnings when the same put advances the watermark | accepted | Added in 9c228e3: warnings reach through the newly finalized slots; an ignored lower `meta.finalizedUntil` leaves the filter where it was |

## Adversarial round 1 — focus: volatile region never gaining authority; watermark moving backwards; version-mismatch clear racing a put — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| A1-1 | P1 | Partial-write coverage withdrawal lacks a regression test (same as R1-1) | accepted | fixed in 9c228e3 |
| A1-2 | P1 | Warning tests do not cover metadata advancing the watermark (same as R1-2) | accepted | fixed in 9c228e3 |

## Round 2 — reviewer verdict: merge after fixes

R1-1 and R1-2 confirmed fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P1 | No test rejects a `meta` that is not an object (`null`, a primitive) | accepted | Added in 0381f10: `null`, `42`, `"v2"`, `true` reject as `'field-mismatch'` with state unchanged |
| R2-2 | P1 | No test covers the constructor turning an unsafe `config.finalizedUntil` into `ConfigError` | accepted | Added in 0381f10: interval 2, `finalizedUntil: MAX_SAFE_INTEGER` throws `ConfigError` naming `finalizedUntil` |

Also in 0381f10, from the decision concerns below: N19 (a response's authority is bounded by its own watermark), with four tests.

## Contract-test changes

`cache-version.test.ts`, "a mismatch keeps the dataset watermark and ignores a lower meta watermark": the expected coverage changed from `[13, 13]` to none. The test encoded the rule before N19; under N19 a response that reports `finalizedUntil: 13` calls `t >= 13` provisional and so covers nothing. Recorded here per AGENTS.md; no other contract test changed.

## Decision concerns

Raised by the adversarial reviewer; both follow §4.5 and the locked decisions, so they are not implementation findings. Escalated to the user 2026-10-06 and decided the same day (architecture N19):

1. **Late response with an old version.** Responses arriving `v1 → v2 → late v1` clear the fresh dataset and restore the old version. **Decision:** the orchestrator stamps requests with the cache's version generation and drops responses from before the last version change (step ⑪).
2. **Late empty response with an old watermark.** With the watermark at 43, a late empty ranged response reporting watermark 13 is applied: it removes point 23 and records its slot as a confirmed gap, although that response itself considered the point provisional. **Decision (N19):** a put carrying `meta.finalizedUntil` is authoritative only below it; points at or beyond are upserted. Implemented on this branch in 0381f10.
