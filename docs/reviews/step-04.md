# Step 04 — DenseSegment and bitmask

Branch: `feat/04-dense-segment` · Reviewer: GPT-6.1 Sol (high) · Rounds: 3 · Status: in review · Verdict after triage: pending

The internal contract for this step (`segment/`) was approved by the user as N10 and N11 (N12 added in round 2) and recorded in architecture §4.2 before the contract tests were written (4f3c573). N11 (what a put removes) is provisional.

## Round 1 — reviewer verdict: block

Host `bun run ci` passed (404 tests).

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | A schema field named `__proto__` is lost by `lookup`, `slice` and payload decoding | accepted | Reproduced with a failing test: plain assignment to a record hit the inherited `__proto__` setter. Name-keyed records are now written as own data properties (`segment/own.ts`). Fixed in bd92e48. |
| R1-2 | P0 | A batch that only inherits a schema field name (`constructor`) passes validation and overwrites stored values | accepted | Reproduced: `fields.constructor` resolved to `Object`, whose `length` is 1, so the length check passed and the replacement stored NaN. Batch fields are now read only as own properties, so the batch is rejected before any mutation. Fixed in bd92e48. |

## Round 2 — reviewer verdict: block

Host `bun run ci` passed (407 tests). The reviewer confirmed R1-1 and R1-2 fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P0 | An allocation failure during a replacement deletes existing points | accepted | Reproduced. `mergeFrom` cleared the authority range and then grew the buffers. It now allocates every buffer before the first mutation and moves only the surviving points across, so a merge that cannot allocate changes nothing. Fixed in 27ace69, with a test that makes the allocation fail. |
| R2-2 | P0 | Mask indices use signed 32-bit shifts and lose points past 2^31 slots | accepted | Confirmed by reading: `i >> 3` is negative for i ≥ 2^31. Reachable only with `segmentSlotCap` above 2^31, which validation accepted. The user chose to bound the cap at 2^31 − 1 (N12) rather than change the arithmetic: config validation rejects a larger value with `ConfigError`, and `DenseSegment` rejects it at construction. Fixed in 621dbd8. |

## Round 3 — reviewer verdict: merge after fixes

Host `bun run ci` passed (417 tests). The reviewer confirmed all four earlier findings fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | Clearing an authority range far from the extent throws a false slot-cap error | accepted | Reproduced with a failing test. The surviving-extent scan started at the authority's edge, outside the buffers, where the mask index aliased an existing point. An authority that misses the extent now returns the extent unchanged, which keeps both scans inside it. Fixed in 8cc0c57. |
| R3-2 | P1 | A batch with an extra field and a non-enumerable schema field passes validation | accepted | Reproduced with a failing test. Batch fields are now matched by their enumerable own names, the same set a spread or structured clone would carry. Fixed in 8cc0c57. |

## Contract-test changes

None. Codex's `dense-segment.test.ts` and `segment-payload.test.ts` are unchanged. Implementer tests were added alongside: `segment-payload.decode.test.ts` (decoder cases the contract left open), `segment-field-names.test.ts` (prototype-named fields) `segment-atomic-alloc.test.ts` (allocation failure and the cap bound) and `segment-merge-edges.test.ts` (distant authority ranges, field-name matching).

Spec ambiguities Codex reported while writing the tests. Each has an implemented choice and a test, and is now part of §4.2 (user-confirmed 2026-10-04):

- Payload fields in a different order from the schema: accepted; re-encoding restores schema order.
- Non-zero values under absent mask bits: ignored; re-encoding writes zeros.
- A valid start and count whose last slot has no safe-integer timestamp: rejected with `TscacheError`.

## Decision concerns

None.
