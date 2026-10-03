# Step 04 — DenseSegment and bitmask

Branch: `feat/04-dense-segment` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: in review · Verdict after triage: pending

The internal contract for this step (`segment/`) was approved by the user as N10 and N11 and recorded in architecture §4.2 before the contract tests were written (4f3c573). N11 (what a put removes) is provisional.

## Round 1 — reviewer verdict: block

Host `bun run ci` passed (404 tests).

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | A schema field named `__proto__` is lost by `lookup`, `slice` and payload decoding | accepted | Reproduced with a failing test: plain assignment to a record hit the inherited `__proto__` setter. Name-keyed records are now written as own data properties (`segment/own.ts`). Fixed in bd92e48. |
| R1-2 | P0 | A batch that only inherits a schema field name (`constructor`) passes validation and overwrites stored values | accepted | Reproduced: `fields.constructor` resolved to `Object`, whose `length` is 1, so the length check passed and the replacement stored NaN. Batch fields are now read only as own properties, so the batch is rejected before any mutation. Fixed in bd92e48. |

## Contract-test changes

None. Codex's `dense-segment.test.ts` and `segment-payload.test.ts` are unchanged. Implementer tests were added alongside: `segment-payload.decode.test.ts` (decoder cases the contract left open) and `segment-field-names.test.ts` (prototype-named fields).

Spec ambiguities Codex reported while writing the tests. Each has an implemented choice and a test, pending the user's confirmation:

- Payload fields in a different order from the schema: accepted; re-encoding restores schema order.
- Non-zero values under absent mask bits: ignored; re-encoding writes zeros.
- A valid start and count whose last slot has no safe-integer timestamp: rejected with `TscacheError`.

## Decision concerns

None.
