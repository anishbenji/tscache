# Step 06 — Read path and miss descriptors

Branch: `feat/06-read-path` · Reviewer: GPT-6.1 Sol (high) · Rounds: 2 · Status: settled · Verdict after triage: merge

## Round 1 — reviewer verdict: merge after fixes

No functional defect found.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | No test covers a confirmed gap: a covered stretch with no points must come back as coverage, not as a miss | accepted | Confirmed by reading the tests (the property test puts a point in every request). Added in 0a31a4a: fully and partly covered empty stretches, with and without other data |
| R1-2 | P1 | The no-segment tests accept any field record, so `fields: {}` would pass | accepted | Confirmed: the loop over `Object.values` runs zero times. Both tests now assert the schema-shaped empty record (0a31a4a) |

## Round 2 — reviewer verdict: merge

No new findings; R1-1 and R1-2 confirmed fixed.

## Contract-test changes

The contract-test author left two cases open pending the schema ambiguity (see below). After it was resolved by adding the schema argument, the implementer strengthened those two tests (`read-collect.test.ts` "no segments", `read-result.test.ts` "no segments") to assert the complete empty field record, and added the confirmed-gap case to `read-result.test.ts`. No assertion was weakened or removed. Every call site also gained the new `fields` argument (mechanical).

## Decision concerns

None. Two spec ambiguities raised by the contract-test author were settled by the implementer and recorded in architecture §4.4: `collect` and `read` take the schema (so an empty result still has the schema's shape), and coverage/misses are independent of which points are present.

## Merge request

**Scope.** Step ⑥ of the commit plan: the read path. `collect` and `read` in `engine/read.ts`; architecture §4.4 (new) and N16. Nothing is exported from a package entry yet; `get` reaches consumers at step ⑧.

**Decisions taken on this branch.** N16 (user-confirmed 2026-10-06): `get` returns every present point in the request, covered or not, with `coverage` marking the authoritative parts. Settled by the implementer and recorded in §4.4: `collect`/`read` take the schema so an empty result keeps the schema's shape; coverage and misses are independent of which points are present.

**Review outcome.** Two rounds. Round 1 found no functional defect and two P1 test gaps (confirmed gap without points; schema shape of empty results), both pinned with tests. Round 2: no findings.

**Confidence: high.** Small module (two functions, one binary search, one concatenation) over already-reviewed `Segment.slice`, `CoverageIndex.covered/gaps` and `grid.ts`. The property test tiles random requests against a per-slot oracle and checks that every requested slot is in exactly one of coverage and misses.

**Blast radius: minimal.** New module only; no existing `src/` file changed. 711 tests pass under `bun run ci`; 53 of them (five files) are the step's contract tests, strengthened in two places as recorded above.

**Known limits, by design.** `read` trusts the coverage it is handed; excluding the volatile region is step ⑦. Miss reasons other than `'uncached'` are the orchestrator's (step ⑪). The result's timestamps reuse the fresh slots array in place (one allocation fewer per read; no view into cache memory).
