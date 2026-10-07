# Step 07 — Invalidation suite (watermark, invalidate, clear, version)

Branch: `feat/07-invalidation` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 5 (cap of four passed with the user's authorization; the cap is ten from chore/07-review-cap on) · Status: settled · Verdict after triage: merge

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

## Round 3 — reviewer verdict: merge after fixes

R2-1 and R2-2 confirmed fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | `warnings.push(...more)` overflows the argument limit when a put yields a warning per point, after the data has changed | accepted | Reproduced with 150 000 warnings. Fixed in 36635e9 with `concat`; regression test added. Same defect class as step ⑤ R1-1 (spread into a call); the other spreads in `cache.ts` are over schema field names, which are bounded |

## Round 4 — reviewer verdict: block

R3-1 confirmed fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R4-1 | P0 | After a failed write the coverage withdrawal used the watermark-clipped claim, which is empty when the put's own watermark precedes its points, so a provisional upsert failing after a first write left half-written covered data authoritative | accepted | Reproduced (cap 2, watermark 20, `meta.finalizedUntil: 0`, second segment write fails: values half new, coverage intact). Fixed in 88d6b74: the withdrawal covers everything the put touched (its authority or batch span); regression test added. Introduced by N19 in 0381f10, so the convergence rule does not fire: the area had not drawn a finding before |
| R4-2 | P2 | The version documentation lacks the required note that restatements without a version signal are undetectable (starter §3.3, §8) | accepted | Added to architecture §2.4 and §4.5 in 88d6b74 |

Round 4 is the cap (docs/workflow.md, review loop step 8) and it raised a P0, so the loop was escalated. The user authorized further rounds until settled (2026-10-06).

## Round 5 — reviewer verdict: merge

No findings. R4-1 and R4-2 confirmed fixed.

## Contract-test changes

`cache-version.test.ts`, "a mismatch keeps the dataset watermark and ignores a lower meta watermark": the expected coverage changed from `[13, 13]` to none. The test encoded the rule before N19; under N19 a response that reports `finalizedUntil: 13` calls `t >= 13` provisional and so covers nothing. Recorded here per AGENTS.md; no other contract test changed.

## Decision concerns

Raised by the adversarial reviewer; both follow §4.5 and the locked decisions, so they are not implementation findings. Escalated to the user 2026-10-06 and decided the same day (architecture N19):

1. **Late response with an old version.** Responses arriving `v1 → v2 → late v1` clear the fresh dataset and restore the old version. **Decision:** the orchestrator stamps requests with the cache's version generation and drops responses from before the last version change (step ⑪).
2. **Late empty response with an old watermark.** With the watermark at 43, a late empty ranged response reporting watermark 13 is applied: it removes point 23 and records its slot as a confirmed gap, although that response itself considered the point provisional. **Decision (N19):** a put carrying `meta.finalizedUntil` is authoritative only below it; points at or beyond are upserted. Implemented on this branch in 0381f10.

## Merge request

**Scope.** Step ⑦ of the commit plan: the invalidation suite. `CacheState` in `engine/cache.ts` (one cache: store, coverage, watermark, version; `put`/`get`/`invalidate`/`clear`/`setFinalizedUntil` in ms) and `slotAtOrAfter` in `grid.ts`. Architecture §4.5 (new), N17–N19, the version-signal honesty note (starter §8 debt) in §2.4. Nothing is exported from a package entry yet; step ⑧ wraps these in `Engine`.

**Decisions taken on this branch** (all user-confirmed 2026-10-06). N17: `meta.finalizedUntil` only advances the watermark. N18: an unversioned cache adopts the first version it sees without clearing. N19: a put carrying `meta.finalizedUntil` is authoritative only below it (raised by the adversarial review as a late-response hazard). Companion decision for step ⑪: the orchestrator drops responses from before the last version change. Settled by the implementer and recorded in §4.5: the volatile region is excluded when coverage is recorded, not when it is read; moving the watermark back forgets coverage from the new volatile slot on; out-of-domain `meta.finalizedUntil` is `'field-mismatch'`; warnings are judged against the watermark after the put's own advance; a clipped warning keeps its fields.

**Review outcome.** Five rounds plus the scheduled adversarial pass. Rounds 1–2: no implementation defects, four P1 test gaps closed. Round 3: one P1 (spread into `push` overflowing with 150 000 warnings). Round 4: one P0 introduced by N19 in round 2's fix (a failed write after a first chunk left half-written covered data authoritative because the withdrawal used the watermark-clipped claim) and the P2 doc note. Round 5: no findings. One contract test's expectation changed because it encoded the pre-N19 rule (recorded above).

**Confidence: high.** Every finding was reproduced by a test before the fix, and the reviewer confirmed each fix the following round. The property test drives random put/invalidate/setFinalizedUntil/clear sequences against a per-slot reference model and checks `get()` after each step. Fault-injection tests cover a failed write for ranged, unranged and provisional puts, and a version mismatch whose write fails.

**Blast radius: small.** New module plus `slotAtOrAfter` (grid) and a `show()` use; no existing module's behaviour changed. 883 tests pass under `bun run ci`; 140 of them are the step's contract tests (eight files).

**Known limits, by design.** `CacheState` is synchronous and single-writer; ordering hazards between concurrent fetch responses are the orchestrator's (step ⑪: version-generation fence, N19 handles the watermark case). Restatements without a version signal remain undetectable (§2.4).

## Follow-up: review-loop cap (`chore/07-review-cap`)

User request 2026-10-06: alert only when a loop has run more than ten rounds. `docs/workflow.md` step 8 and `CLAUDE.md` raised from four to ten; the per-area convergence check is unchanged.

### Round 1 — reviewer verdict: merge

No findings; the reviewer checked both documents agree.

## Merge request: `chore/07-review-cap` → `main`

Documentation only; CI unaffected. Confidence high.
