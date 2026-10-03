# Step 04 — DenseSegment and bitmask

Branch: `feat/04-dense-segment` · Reviewer: GPT-6.1 Sol (high) · Rounds: 5 · Status: settled · Verdict after triage: merge

The internal contract for this step (`segment/`) was approved by the user as N10 and N11 (N12 added in round 2) and recorded in architecture §4.2 before the contract tests were written (4f3c573). N11 (what a put removes) is provisional.

## Merge request

### Summary

Step ④ of the commit plan: the `Segment` interface, `DenseSegment` (consecutive slots, one typed array per field, a one-bit-per-slot presence mask) and the payload codec (`transferPayload`, `segmentFromPayload`). The modules are internal and have no consumers yet; the put, read and invalidation paths (steps ⑤–⑦) build on them. No package entry exports them, so the built package is unchanged.

One public behaviour changes: `segmentSlotCap` above 2^31 − 1 is now rejected with `ConfigError` (N12).

### Commits

| Group | Commits |
|---|---|
| Contract | 4f3c573 N10, N11 and architecture §4.2 · 70d1a6c decoder cases |
| Code with contract tests | fa5b906 |
| Review fixes | bd92e48 prototype-named fields · 27ace69, 768115a allocation before mutation · 621dbd8 slot cap bound · 8cc0c57 scan bounds and field-name matching |
| Triage | 0ef1e33, aea7c84, 64baaf7, 6decc7e, 9d6153d, this file |

### Decisions taken with the user (2026-10-04)

- N10: the `Segment` interface in slot terms; an invalid payload throws plain `TscacheError`; field data is little-endian with no byte swapping.
- N11 (provisional, revisit at step ⑤): a write that states its range replaces it; a `put` without a range only adds or overwrites. Recorded with the design intent that the cache exists to avoid refetching data that does not change.
- N12: `segmentSlotCap` is at most 2^31 − 1.
- §4.2 details: a failed `mergeFrom` changes nothing; decoding copies the payload's buffers; payload fields may come in any order; values under absent mask bits are ignored; a span past the last safe-integer timestamp is rejected.

### Review outcome

Five rounds raised seven findings (five P0, two P1), all reproduced or confirmed, accepted and fixed with regression tests. Round 5 had no findings. No rejections and no decision concerns. The loop reached its four-round cap with a P0 in round 4; the user authorized further rounds, and one more settled it.

None of the findings was in ordinary behaviour (storing, reading, replacing, encoding, decoding). They were field names colliding with `Object.prototype` members, failures injected during buffer growth, slot caps above 2^31, and an authority range far outside the extent.

### Confidence

High for ordinary behaviour: the 178 contract tests were written by Codex from §4.2 before the code and are unchanged, including seeded upsert/replace sequences and payload round trips checked against a row model. High for the fixed edge cases, each pinned by a test that failed before its fix. Medium for failure atomicity in general: it took two fixes (rounds 2 and 4) and is now structured as a build phase followed by an assignment-only commit, which round 5 confirmed, but JavaScript can run out of memory at any allocation and only the reachable paths are tested. `bun run ci` passes on 768115a with 425 tests.

### Blast radius

- **Package consumers:** `segmentSlotCap` above 2^31 − 1 now throws `ConfigError`. The default is 32 768 and a segment that size could not be allocated, so no working configuration is affected. Nothing else public changes; `dist/` is unchanged.
- **Later steps:** ⑤–⑦ depend on the §4.2 contract, in particular upsert versus replace, the slot cap error, and results being copies.
- **Persistence and SSR later:** the payload layout in §4.2 (mask bit order, zeroed absent slots, schema field order, little-endian) becomes the format those features read. Changing it after data is persisted would need a `format` bump.

### Test coverage

No coverage tool is installed. By inspection:

| Module | Covered | Not covered |
|---|---|---|
| `segment/dense.ts` | Empty and single-point segments; lookup, slice clipping and copies; all eight dtypes with assignment conversion; upsert and replace including clearing and extent shrinking; growth in both directions; the slot cap at and past the limit; every malformed-input rejection, each checked to leave the segment unchanged; allocation and copy failures; prototype-named fields; distant authority ranges; safe-integer slot extremes | Performance is unmeasured (bench files start at step ⑥). Slicing and scanning are per-slot loops; fine at the default cap, to be benchmarked |
| `segment/payload.ts` | Mask length and bit order at counts 1, 7, 8, 9, 16, 17; trailing bits; zeroed absent slots; field order; fresh buffers; structured cloning and transfer; little-endian bytes for every dtype; every decode rejection; round trips | Decoding on a big-endian platform (none is supported) |

### Residual notes

- N11 is provisional and should be revisited when step ⑤ wires `put`.
- Buffer growth doubles capacity up to the slot cap; the policy is internal and untuned until benchmarks exist.

### Before merging

```sh
bun run ci
git switch main && git merge --no-ff feat/04-dense-segment
```

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

## Round 4 — reviewer verdict: block

Host `bun run ci` passed (424 tests). The reviewer confirmed the other five findings fixed and the contract tests unchanged.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R4-1 | P0 | A failure while copying a later field into new buffers corrupts earlier fields (re-raises R2-1) | accepted | Reproduced with a failing test that makes the second field's copy throw. Growth installed each field's buffer as it went. All buffers are now built and filled first, then installed in an assignment-only step. Fixed in 768115a. |

Round 4 is the cap in `docs/workflow.md`, and this finding re-raises R2-1, so the loop stopped here and went to the user, who authorized further rounds at the implementer's discretion (2026-10-04).

## Round 5 — reviewer verdict: merge

Host `bun run ci` passed (425 tests). No findings. The reviewer confirmed every finding from rounds 1–4 fixed and the contract tests unchanged, and reported 2,000 in-memory merge checks passing in its own probes.

## Contract-test changes

None. Codex's `dense-segment.test.ts` and `segment-payload.test.ts` are unchanged. Implementer tests were added alongside: `segment-payload.decode.test.ts` (decoder cases the contract left open), `segment-field-names.test.ts` (prototype-named fields) `segment-atomic-alloc.test.ts` (allocation failure and the cap bound) and `segment-merge-edges.test.ts` (distant authority ranges, field-name matching).

Spec ambiguities Codex reported while writing the tests. Each has an implemented choice and a test, and is now part of §4.2 (user-confirmed 2026-10-04):

- Payload fields in a different order from the schema: accepted; re-encoding restores schema order.
- Non-zero values under absent mask bits: ignored; re-encoding writes zeros.
- A valid start and count whose last slot has no safe-integer timestamp: rejected with `TscacheError`.

## Decision concerns

None.
