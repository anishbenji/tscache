# Step 03 — Coverage index

Branch: `feat/03-coverage-index` · Reviewer: GPT-6.1 Sol (high; xhigh adversarial) · Rounds: 3 + 1 adversarial · Status: settled · Verdict after triage: merge

The internal contract for this step (`grid.ts`, `coverage.ts`) was approved by the user as N9 and recorded in architecture §4.1 before the contract tests were written (fce08d7).

## Merge request

### Summary

Step ③ of the commit plan: `grid.ts`, the single site for ms↔slot conversion, and `coverage.ts`, the coverage index on integer slot ranges. Both are internal modules with no consumers yet; the write, read and invalidation paths (steps ⑤–⑦) build on them. Nothing is exported from a package entry, so the public API and the built package are unchanged.

### Commits

| Group | Commits |
|---|---|
| Contract | fce08d7 N9 and architecture §4.1 · 6fe0d2e exact alignment and range ownership |
| Code with contract tests | d361ff0 grid · b580165 coverage index |
| Review fixes | df5827e exact `msOf` · 64fd28a safe-integer domain · 4be7fa2 non-number endpoints |
| Triage | fab5cac, d75f623, 92acf06, this file |

### Decisions taken with the user (2026-10-03)

- N9: `grid.ts` holds every ms↔slot conversion; `coverage.ts` sees slot ranges only.
- `isAligned` added to `grid.ts` so step ⑤'s alignment check stays inside the conversion site.
- Supported domain is safe integers; values outside it are rejected at the boundary.
- §4.1 states that alignment is exact for every safe-integer timestamp, and that `CoverageIndex` never shares range objects with callers.

### Review outcome

Three review rounds and one adversarial round raised three findings (two P0, one P1), all reproduced, accepted and fixed with regression tests. Rounds 2 and 3 had no findings. No rejections and no decision concerns.

### Confidence

High. The contract tests were written by Codex from §4.1 before the code and are unchanged (148 cases, including seeded property checks of merge, subtraction and covered/gaps tiling against a slot-set model). Both P0s were arithmetic at the edge of the number range; the fix made that edge a stated rule rather than patching sites, and grid arithmetic is now checked against BigInt at both extremes. The adversarial reviewer's own probes (540,322 arithmetic comparisons, 6,000 coverage operations near the limits) found nothing further. `bun run ci` passes on 4be7fa2 with 223 tests.

### Blast radius

- **Package consumers and the built package:** none. Neither module is reachable from an entry point, so `dist/` is unchanged.
- **Later steps:** ⑤–⑦ depend on this contract. Changing §4.1 after they land would ripple; the safe-integer rule and the ownership rule are the parts they will lean on.
- **Behaviour visible later:** once `get` and `invalidate` are wired, a range with non-number endpoints, endpoints beyond ±(2^53 − 1), or an outward snap past that bound rejects with `InvalidRangeError`. Real timestamps are about 1.7e12, far inside the bound.
- **Architecture document:** §4 gains `grid.ts`, §4.1 is new, §8 gains N9.

### Test coverage

No coverage tool is installed. By inspection:

| Module | Covered | Not covered |
|---|---|---|
| `grid.ts` | Alignment and conversion on epoch and offset grids, negative slots, snap-outward fenceposts just below and above grid points, `start === end`, every rejection (non-finite, non-number, non-object, inverted, out of domain, snap past the bound), exactness against BigInt near ±2^53 | `toMs`/`msOf` do not validate their input (internal; callers pass slots produced by this module) |
| `coverage.ts` | Merge of adjacent, touching, overlapping, nested and bridging ranges; one-slot gaps preserved; subtraction that splits, clips and removes; clipped covered/gaps partitions; malformed ranges on all four methods; snapshot copying and ownership; the safe-integer extremes; seeded property checks | Performance is unmeasured (bench files start at step ⑥ per `scripts/ci.sh`) |

The "one conversion site" rule holds by inspection: `coverage.ts` has no interval arithmetic. `engine/validate.ts` uses `% interval` only to normalize `alignmentOffset` in the config, which is not a ms↔slot conversion.

### Before merging

```sh
bun run ci
git switch main && git merge --no-ff feat/03-coverage-index
```

## Round 1 — reviewer verdict: block

Host `bun run ci` passed (199 tests).

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | `msOf` rounds for negative slots near -2^53, so `toMs(snapOut(t))` excludes `t` | accepted | Reproduced: interval 3, offset 2, t = -(2^53 − 1) round-tripped to t + 1. The product `slot * interval` left exact range before the offset was added. The negative case is regrouped so no intermediate exceeds the result. Fixed in df5827e with round-trip tests against BigInt. |
| R1-2 | P0 | `gaps` reports a covered slot at 2^53 as missing (`end + 1` rounds) | accepted | Reproduced. The user chose safe integers as the supported domain rather than patching each `± 1` site: `isAligned` is false outside it, `snapOut` rejects endpoints or outward snaps beyond ±(2^53 − 1), and `CoverageIndex` rejects unsafe slots. Architecture §4.1 records the domain. Fixed in 64fd28a with boundary tests at both extremes. |

## Round 2 — reviewer verdict: merge

Host `bun run ci` passed. No findings. The reviewer confirmed R1-1 and R1-2 fixed with regression tests and the contract tests unchanged. The round started before 6fe0d2e (contract wording and ownership tests, no source change); the adversarial pass below reviews the branch including it.

## Adversarial round A1 — reviewer verdict: merge after fixes

Focus from the workflow schedule (fenceposts and snap-outward, single conversion site, adjacent/touching/nested ranges) plus arithmetic exactness in the safe-integer domain. Host `bun run ci` passed. The reviewer found nothing in range operations, conversion placement or domain arithmetic, and reported 540,322 exact arithmetic comparisons and 6,000 coverage operations near the integer limits passing in its own probes.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| A1-1 | P1 | `snapOut` coerces non-number endpoints (`"10"`, `null`, booleans) instead of rejecting | accepted | Reproduced: `Math.abs` coerced them, so `{start: "10", end: "10"}` snapped to real slots. Endpoints are now checked with `Number.isFinite`, which does not coerce, and a non-object range is rejected too (found while fixing). Fixed in 4be7fa2 with rejection tests. |

## Round 3 — reviewer verdict: merge

Host `bun run ci` passed (223 tests). No findings. The reviewer confirmed R1-1, R1-2 and A1-1 fixed with regression tests and the contract tests unchanged.

## Contract-test changes

None. Codex's `grid.test.ts` and `coverage.test.ts` are unchanged. Implementer tests were added alongside: `grid.precision.test.ts` (exactness near ±2^53) and `bounds.test.ts` (safe-integer domain).

Spec ambiguities Codex reported while writing the tests, and their resolution:

- Numeric precision of the alignment formula near ±2^53, and behaviour for unsafe values: resolved by the safe-integer domain above (user-confirmed 2026-10-03).
- Ownership of ranges passed to and returned from `CoverageIndex`: the index never shares range objects with callers. Written into §4.1 with tests in `coverage.ownership.test.ts` (user-confirmed 2026-10-03), together with the statement that alignment is exact for every safe-integer timestamp.

## Decision concerns

None.
