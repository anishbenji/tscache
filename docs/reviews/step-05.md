# Step 05 — Merge / put path

Branch: `feat/05-merge-put` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 4 (cap reached) · Status: escalated · Verdict after triage: merge, pending the user's call on a further round

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

Round 4 is the cap (docs/workflow.md, review loop step 8) and it raised a P1, so the loop is not settled by its own rule and goes to the user. The fix above has not been seen by the reviewer.

## Contract-test changes

None.

## Decision concerns

None.
