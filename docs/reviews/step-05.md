# Step 05 — Merge / put path

Branch: `feat/05-merge-put` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 1 · Status: in review · Verdict after triage: blocked

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

## Contract-test changes

None.

## Decision concerns

None.
