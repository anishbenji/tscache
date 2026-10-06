# Step 05 — Merge / put path

Branch: `feat/05-merge-put` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 5 (cap of four passed with the user's authorization) · Status: settled · Verdict after triage: merge

## Round 1 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | A replace that splits one segment into very many parts overflows the stack in `splice(...parts)` after the segment was cut back, losing the points after the authority | accepted | Reproduced with a regression test (400 002 slots, K = 1). Fixed in dded03f: the new segments and the new list are built before the old segment is cut back, with no argument spread |
| R1-2 | P0 | An allocation failure part-way through a join leaves overlapping, unordered segments | accepted | Reproduced with fault injection on `slice` for a target on the left, in the middle and on the right. Fixed in dded03f: neighbours are absorbed nearest first and leave the list as they are copied |

## Adversarial round 1 — focus: atomic reject, new-wins across boundaries, K-split and slot-cap edges, warning cost when off — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| A1-1 | P0 | Large replacement deletes points outside its authority (same defect as R1-1) | accepted | fixed in dded03f |
| A1-2 | P0 | Allocation failure during a join leaves overlapping, unsorted segments (same defect as R1-2) | accepted | fixed in dded03f |

Found while validating, not raised by the reviewer: a replace whose insert failed skipped the split of the segment it had cleared, leaving a gap wider than K inside one segment. Fixed in dded03f (the split now runs in a `finally`), with a regression test.

## Round 2 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P0 | A failed join leaves a gap wider than K inside one segment (follows R1-2) | accepted | Reproduced. Second round running on the join, so per the convergence rule it was redesigned instead of patched, in 8563e57: the other segments and the chunk are gathered in a scratch segment, the stored segment then changes in one atomic `mergeFrom`, and the list is edited only afterwards. A failed join now changes nothing; the fault-injection test fails every `slice` and `mergeFrom` call in turn and compares the whole store before and after. Architecture §4.3 states the resulting guarantee |
| R2-2 | P1 | `instanceof` checks reject typed arrays from another realm and accept foreign BigInt arrays and DataViews | accepted | Reproduced with `node:vm`. Fixed in 8563e57: array kind is read from the `%TypedArray%` tag getter, which works across realms; regression tests added |

## Round 3 — reviewer verdict: merge after fixes

The reviewer confirmed every accepted finding from rounds 1–2 as fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | A symbol passed as the batch throws `TypeError` from the message interpolation instead of `PutError` `'field-mismatch'` | accepted | Reproduced. Fixed in 4565638 with `String(batch)`; the other messages in `batch.ts` were checked and interpolate only numbers and schema names. Regression tests cover a symbol as the batch, as a field, as `timestamps` and as one timestamp |

## Round 4 — reviewer verdict: merge after fixes

The reviewer confirmed every accepted finding from rounds 1–3 as fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R4-1 | P1 | A timestamp whose string conversion throws (`Object.create(null)`) raises `TypeError` from `String(t)` instead of `PutError` `'misaligned'` (same class as R3-1) | accepted | Reproduced. Second round running on message building, so per the convergence rule the class was removed instead of the instance, in 0bd9ded: every message for an untrusted value in `src/` (batch, grid, config validation, payload decoding) now goes through one `show()` helper that never calls the value's own conversion. `test/hostile-values.test.ts` passes five hostile values through every batch, range and config position. Validating this also found that a field element that cannot be converted to a number threw `TypeError` from the typed-array copy; it now rejects as `'field-mismatch'` (architecture §4.3 updated) |

Round 4 is the cap (docs/workflow.md, review loop step 8) and it raised a P1, so the loop was escalated. The user authorized further rounds until settled (2026-10-06).

## Round 5 — reviewer verdict: merge

No findings. The reviewer confirmed every accepted finding from rounds 1–4 as fixed.

## Contract-test changes

None.

## Decision concerns

None.

## Merge request

**Scope.** Step ⑤ of the commit plan: the put path. `snapIn` in `grid.ts` (N13), `validateBatch` in `engine/batch.ts`, `SegmentStore` in `engine/merge.ts` with the overlap warning in `engine/overlap.ts`, the programming-error checks shared with `DenseSegment` in `segment/assert.ts`, and the `show()` message helper in `errors.ts`. Architecture doc: §4.3 (new), `snapIn` in §4.1, N11 confirmed as final, N13–N15 registered, module layout updated. Nothing is exported from a package entry yet; `put` reaches consumers at step ⑧.

**Decisions taken on this branch.** N11 final; N13 put range snaps inward; N14 K counts absent slots; N15 fixed pages (all user-confirmed 2026-10-05). Settled by the implementer and recorded in §4.3: a non-number timestamp is reported by index without `offenderTimestamp`; `snapIn` has no overflow rejection; a field element that cannot be converted to a number is `'field-mismatch'`; error messages never call an untrusted value's own conversion.

**Review outcome.** Five rounds plus the scheduled adversarial pass. Rounds 1–2 found two real P0 defects in failure handling (a huge split overflowed the stack after the segment was cut back, losing a point outside the authority; a failed join left the list unordered) and a P1 (typed arrays from another realm rejected). The join was redesigned to be atomic after the convergence rule fired. Rounds 3–4 each found one hostile-input P1 in message building; after the second the whole class was removed with `show()`. Round 5: no findings. All contract tests unchanged.

**Confidence: high.** Every finding was reproduced with a test before the fix, and the reviewer confirmed each fix in the following round. The property test compares the store against a `Map` model under random upsert and replace sequences and checks that the layout is independent of arrival order. Fault-injection tests fail every `slice` and `mergeFrom` call of a join in turn and check the store is unchanged.

**Blast radius: small.** New modules plus three edits to existing code: `DenseSegment` now calls the shared assertions (same checks, moved); `grid.ts` gained `snapIn` and a shared range check; `String()` became `show()` in `validate.ts` and `payload.ts` messages (step ② and ④ code, touched because the hostile-value fix applies to them too; primitives print exactly as before, so existing tests were unaffected). No consumer-visible API changes beyond the documented `PutError` details.

**Known limits, by design.** A `put` that cannot allocate may be left half done, in steps that are each atomic; the engine must withdraw coverage for the range when `put` throws (step ⑦, recorded in §4.3). The opt-in overlap warning allocates per batch point; it is off by default and O(overlap) as documented. The large-split regression test takes about three seconds.

**Test coverage.** 658 tests pass (`bun run ci`): 198 contract tests across eight files from Codex, plus implementer tests for allocation failure, cross-realm arrays and hostile values.
