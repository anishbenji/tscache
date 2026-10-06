# Step 06 — Read path and miss descriptors

Branch: `feat/06-read-path` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: in review · Verdict after triage: blocked

## Round 1 — reviewer verdict: merge after fixes

No functional defect found.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | No test covers a confirmed gap: a covered stretch with no points must come back as coverage, not as a miss | accepted | Confirmed by reading the tests (the property test puts a point in every request). Added in 0a31a4a: fully and partly covered empty stretches, with and without other data |
| R1-2 | P1 | The no-segment tests accept any field record, so `fields: {}` would pass | accepted | Confirmed: the loop over `Object.values` runs zero times. Both tests now assert the schema-shaped empty record (0a31a4a) |

## Contract-test changes

The contract-test author left two cases open pending the schema ambiguity (see below). After it was resolved by adding the schema argument, the implementer strengthened those two tests (`read-collect.test.ts` "no segments", `read-result.test.ts` "no segments") to assert the complete empty field record, and added the confirmed-gap case to `read-result.test.ts`. No assertion was weakened or removed. Every call site also gained the new `fields` argument (mechanical).

## Decision concerns

None. Two spec ambiguities raised by the contract-test author were settled by the implementer and recorded in architecture §4.4: `collect` and `read` take the schema (so an empty result still has the schema's shape), and coverage/misses are independent of which points are present.
