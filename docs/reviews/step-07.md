# Step 07 — Invalidation suite (watermark, invalidate, clear, version)

Branch: `feat/07-invalidation` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 1 · Status: in review · Verdict after triage: blocked

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

## Contract-test changes

None.

## Decision concerns

Raised by the adversarial reviewer; both follow §4.5 and the locked decisions, so they are not implementation findings. Escalated to the user 2026-10-06; to be settled before step ⑪ (orchestration), where responses can arrive out of order.

1. **Late response with an old version.** Responses arriving `v1 → v2 → late v1` clear the fresh dataset and restore the old version. A request-generation fence in the orchestrator (drop responses issued before the last version change) would address it.
2. **Late empty response with an old watermark.** With the watermark at 43, a late empty ranged response reporting watermark 13 is applied: it removes point 23 and records its slot as a confirmed gap, although that response itself considered the point provisional. Needs an explicit authority policy for responses whose reported watermark is below the current one (for example: clip their authority to their own watermark, or discard them).
