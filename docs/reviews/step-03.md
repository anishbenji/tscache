# Step 03 — Coverage index

Branch: `feat/03-coverage-index` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: in review · Verdict after triage: pending

The internal contract for this step (`grid.ts`, `coverage.ts`) was approved by the user as N9 and recorded in architecture §4.1 before the contract tests were written (fce08d7).

## Round 1 — reviewer verdict: block

Host `bun run ci` passed (199 tests).

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | `msOf` rounds for negative slots near -2^53, so `toMs(snapOut(t))` excludes `t` | accepted | Reproduced: interval 3, offset 2, t = -(2^53 − 1) round-tripped to t + 1. The product `slot * interval` left exact range before the offset was added. The negative case is regrouped so no intermediate exceeds the result. Fixed in df5827e with round-trip tests against BigInt. |
| R1-2 | P0 | `gaps` reports a covered slot at 2^53 as missing (`end + 1` rounds) | accepted | Reproduced. The user chose safe integers as the supported domain rather than patching each `± 1` site: `isAligned` is false outside it, `snapOut` rejects endpoints or outward snaps beyond ±(2^53 − 1), and `CoverageIndex` rejects unsafe slots. Architecture §4.1 records the domain. Fixed in 64fd28a with boundary tests at both extremes. |

## Contract-test changes

None. Codex's `grid.test.ts` and `coverage.test.ts` are unchanged. Implementer tests were added alongside: `grid.precision.test.ts` (exactness near ±2^53) and `bounds.test.ts` (safe-integer domain).

Spec ambiguities Codex reported while writing the tests, and their resolution:

- Numeric precision of the alignment formula near ±2^53, and behaviour for unsafe values: resolved by the safe-integer domain above (user-confirmed 2026-10-03).
- Ownership of ranges passed to and returned from `CoverageIndex`: open, with the user.

## Decision concerns

None.
