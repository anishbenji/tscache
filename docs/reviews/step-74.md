# Step 74 — Model-based property tests for the cache

Branch: `chore/74-model-property-tests` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: in review · Verdict after triage: pending

## Scope

The review of 2026-11-10 (`docs/reviews/2026-11-review.md`, Part 2, §2.4) found the storage core correct against an independent model, but several rules had example tests only: the watermark moving forwards only (N17), version adoption and clear (N18), a response clipped to its own watermark (N19), the overlap warning, and the failed-write guarantees of §4.3 and §4.5. The existing `cache-property.test.ts` fixes K = 2 and cap = 8, never passes `meta` and never turns the warning on. This step ports the review's two probes (`probe-cache-model.ts`, `probe-faults.ts`) into the suite as seeded property tests. Tests only: nothing under `packages/tscache/src` changes, and no dependency is added.

| Commit (by subject)                                                   | What                                              |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| `test: seeded model and fault-injection property tests for the cache` | The model, its checks and the two property tests. |
| `docs(review): step 74, model-based property tests`                   | This file.                                        |

| File                                                  | Role                                                                                                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/tscache/test/cache-model.ts`                | An independent slot-by-slot model of one cache, written from architecture §2.3–§2.4, §4.3–§4.5, N1, N3, N11, N13–N19, and the seeded generator. It imports only types from `src`. |
| `packages/tscache/test/cache-model-checks.ts`         | Comparison of a live `CacheState` with the model, shared by both tests: `get`, coverage index, watermark, version, well-formedness, layout.                                       |
| `packages/tscache/test/cache-model-property.test.ts`  | The model test.                                                                                                                                                                   |
| `packages/tscache/test/cache-faults-property.test.ts` | The fault-injection test.                                                                                                                                                         |

## What each test checks

### `cache-model-property.test.ts`

Eight batches of 100 fixed seeds (1, 10 001, 0xc0ffee and 0xdeadbeef onwards, 200 from each), 120 random operations per seed, 96 000 operations in all. Each seed draws its own interval (1, 2, 10 or 60 000), `alignmentOffset`, `gapSplitK` (1–5), `segmentSlotCap` (1 to 32 768), schema (one, two or six fields across all eight dtypes), initial watermark (none, on the grid or between grid points), `config.version` (set or not) and `warnOnOverlapDiff`. Operations: puts without a range and with a range of six shapes (on the grid, inward, outward, one point, no grid point, random fractions), whose `meta` holds nothing, `finalizedUntil`, `version`, or both; `invalidate`; `setFinalizedUntil` (forwards and back); `clear`. Batches come as plain arrays or `Float64Array`s, with values that include NaN, −0, fractions, values past the integer dtypes' ranges and values below `f32` precision.

| Checked after every step                                                                                                                                       | Against                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| The put's `warnings` (ms ranges, fields in schema order) and `cleared`                                                                                         | §4.3 overlap warning, §4.5 warnings, starter §3.3 |
| `onVersionClear` called exactly once per clearing put, never otherwise                                                                                         | §4.5 `CacheStateHooks`                            |
| `get` over the whole universe, a random unaligned range and one point: timestamps, field values, field array types, coverage, misses with `reason: 'uncached'` | §4.4, N1, N16                                     |
| The coverage index: sorted, disjoint, not adjacent, nothing at or after the watermark's slot, equal to the model's covered slots                               | §4.1, §4.5 volatile region, N3, N13, N19          |
| `finalizedUntil` and the volatile slot                                                                                                                         | §4.5, N17                                         |
| `version`                                                                                                                                                      | §4.5 version, N18                                 |
| The store well formed (ascending, disjoint, no empty segment, tight extents, inside one page, sizes right)                                                     | §4.3                                              |
| The segment layout equals the layout of the present points                                                                                                     | N14, N15                                          |

Each batch also asserts that its generator reached every rule it claims to check (a fixed list of 17, from "N17 lower watermark ignored" to "warning clipped at the volatile region"). Over the 800 seeds: 61 858 puts, 16 428 lower watermarks ignored and 8 275 advances (N17), 504 first versions adopted and 7 908 mismatch clears (N18), 8 199 provisional points kept by a replace (N19), 7 093 warnings reported, 336 clipped and 2 732 dropped at the volatile region.

### `cache-faults-property.test.ts`

Eight batches of 80 fixed seeds (1, 0xc0ffee, 10 001 and 0xdeadbeef onwards, 160 from each), 60 operations per seed; four batches retry each failed put, four carry on from the state it left. Two out of three puts are armed: the n-th typed-array allocation of the put (n from 0 to 24) throws a `RangeError`. The allocations wrapped are the field-array constructors in `FIELD_ARRAYS` (segments, store and batch validation) and the global `Float64Array` and `Uint8Array` (slot and mask arrays). Each is wrapped in a `Proxy`, so `instanceof`, static members and species are unchanged; it counts only while a put is armed, and the originals are restored in `afterAll`. Over the 640 seeds 13 675 failures are injected: 10 025 in a field array, 2 112 in a mask, 1 538 in a slot array.

| Checked after every failed put                                                                                                                                                                                                | Against                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| The error that propagates is the injected one; an injected failure is never swallowed                                                                                                                                         | §4.5 order inside `put`                             |
| The store is well formed; it is in the layout of its present points unless the put was a replace                                                                                                                              | §4.3 allocation failure (the one exception)         |
| No point outside the put's range changed; each point inside it is its old value, its new value, or removed by the put's own replace below the put's own watermark                                                             | §4.3 allocation failure, N11, N19                   |
| No coverage was added; coverage outside the put's range is unchanged; after a fault past validation none of the range is covered, whether or not a point changed (round 1, R1-2)                                              | §4.3 allocation failure, §4.5 order inside `put`    |
| The watermark did not move                                                                                                                                                                                                    | §4.5 order inside `put`                             |
| A fault during validation (`validateBatch` on the stack when it fired) changed nothing: points, coverage, watermark, version, hook calls; `onMutate` is not called for it and is called once for a put that passed validation | §4.5 order inside `put`, errors; §4.10.4 `onMutate` |
| The version step stays: the version the model derives from `meta.version` is adopted, a mismatch has cleared the cache, `onVersionClear` was called once for it (round 1, R1-1)                                               | §4.5 version, `CacheStateHooks`, order inside `put` |
| The retried put lands exactly on the model, warnings included; carrying on, every later step matches it                                                                                                                       | §4.3, §4.5                                          |

Each batch asserts that it reached every outcome: a successful put, a failure in validation, a write failure that changed nothing, one that changed points, one that only withdrew coverage, one after a version clear, a failed replace that removed a point, and a fault in each kind of array.

A failure in either test prints the seed, the step, the case's configuration and the operations before it. To replay one, narrow the test's `it.each` table to that seed: `{ first: <seed>, count: 1 }` in the model test, `{ first: <seed>, count: 1, retry: <as printed> }` in the fault test. The rule-reach assertion may then fail as well, since one seed reaches fewer rules.

## Mutation results

Each rule was broken in the model or in the fault test's expectations (never in the library) by a scratch edit, the file was run, and the edit was undone with the Edit tool; `git status` was clean afterwards and the unmodified tests pass. A higher count means the rule is pinned harder; a count below the total is a seed whose generated operations never reach the broken case.

| Rule                                | Scratch edit                                                   | Failing seeds |
| ----------------------------------- | -------------------------------------------------------------- | ------------- |
| N17, forwards only                  | A lower `meta.finalizedUntil` also moves the watermark         | 800 / 800     |
| N18, adopt without clearing         | The first version seen by an unversioned cache clears it       | 504 / 800     |
| §4.5 version clear                  | A version mismatch does not clear                              | 800 / 800     |
| N19, replace clipped                | The replace removes points at or after the put's own watermark | 756 / 800     |
| N19, coverage clipped               | The claim is not clipped at the put's own watermark            | 800 / 800     |
| Watermark exclusion                 | Coverage may include the first provisional slot                | 800 / 800     |
| §4.5 watermark moved back           | `setFinalizedUntil` backwards keeps coverage                   | 799 / 800     |
| N14, K split                        | Split when K − 1 slots are empty                               | 453 / 800     |
| N14, K split                        | Split only when K + 2 slots are empty                          | 384 / 800     |
| N15, fixed pages                    | Segments may cross a page                                      | 732 / 800     |
| Warning, volatile region            | Warnings neither dropped nor clipped at the volatile region    | 575 / 800     |
| Warning, NaN equality               | NaN replacing NaN counts as a difference                       | 20 / 800      |
| Warning, option off                 | Warnings reported with `warnOnOverlapDiff` off                 | 201 / 800     |
| Failure atomicity, range            | The put's range taken one slot shorter at its end              | 458 / 640     |
| Failure atomicity, replace          | A failed replace may not remove a point                        | 634 / 640     |
| Failure atomicity, coverage         | A failed put must leave coverage unchanged (no withdrawal)     | 638 / 640     |
| Failure atomicity, version          | The version clear is undone by the failed write                | 518 / 640     |
| Failure atomicity, watermark        | A failed put advances the watermark as a successful one would  | 505 / 640     |
| Failure atomicity, layout exception | A failed replace must leave the canonical layout               | 20 / 640      |

The six fault-test rows above were measured before the pre-review fix below, which changed that test's checks and the order in which it draws random numbers; the mutation added with the fix is recorded in the pre-review section.

The N18 count equals the number of seeds in which an unversioned cache sees a version (504), and the layout-exception count shows the documented exception is reached (25 failed replaces left it, in 20 seeds) and is the only layout departure.

## Timings

`bunx vitest run <file>` on the development machine, three runs each: `cache-model-property.test.ts` 2.48–2.57 s at normal load and 2.65–3.25 s with a load average of 5.7; `cache-faults-property.test.ts` 2.08–2.19 s. After round 1, with a load average of 13: model test 4.05 s (eight batches, 0.43–0.57 s each), fault test 4.29 s (0.40–0.70 s each); timings at normal load were not taken again. After the pre-review fix, with a load average of 6 to 10: model test 2.43–2.49 s, fault test 2.92 s. The whole package suite (`bunx vitest run packages/tscache/test`): 97 files, 1963 tests, 6.4 s.

## Library defects found

None. Every seed of both tests passes against the library as it stands on `main`.

## Decisions taken

- File names follow the repository's `*-property.test.ts` style: `cache-model-property.test.ts` and `cache-faults-property.test.ts`. The model is a shared helper, `cache-model.ts`, as `inflight-plan-model.ts` is for the orchestrator; the comparisons live in `cache-model-checks.ts` so that the model imports nothing from `src` but types.
- The coverage index and the segment layout are read through `cacheInternals`, the internal accessor the persistence code uses (§4.10.5). The task asks for the index and its invariants, which `get` shows only clipped to a request.
- Faults are injected through `Proxy` wrappers of the typed-array constructors, as the probe wrapped the field arrays, extended to the global `Float64Array` and `Uint8Array`. This reaches the mask and slot arrays the review did not inject (§2.4, "Not verified in this part"). The existing seams (`vi.spyOn` on `DenseSegment.prototype` and `SegmentStore.prototype`, `vi.stubGlobal`) were considered: a spy that throws on entry tests only the step boundaries, not an allocation inside a step, so `vi.stubGlobal` is reused for the globals and the spies are not.
- A fault during batch validation and one during the write are told apart by whether `validateBatch`, the validation step §4.3 names, is on the stack when the fault fires (with `Error.stackTraceLimit` raised to 50 for the file and restored after). A validation fault must change nothing at all; a write fault is judged by the write-failure guarantees, against the state after a version clear when one ran. `onMutate` (§4.10.4) cross-checks the split: it must not fire for the first and must fire once for the second. It is not used alone, since a regression that calls a public mutating method would fire it too.
- After a failed replace that left the documented non-canonical layout, the test checks only well-formedness for the rest of that seed. §4.3 states the layout after a successful put from a canonical store, not from the exception.
- The model test keeps 200 seeds per batch (about 2.5 s at normal load) rather than fewer, so that the mutation counts above stay those of the committed file.

## Pre-review (Claude), not the gate

One round on 2026-11-10, after the branch was rebased onto `main` b3f0b98.

| #    | Sev | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                    | Decision | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-1 | P1  | A put that fails before its version step was not required to change nothing: without a version change, a validation fault was judged by the weaker write-failure rules, so a regression that withdraws coverage or writes points after a validation failure passed (the reviewer's scratch wrapper calling `c.invalidate` after such a fault passed all 640 seeds, with 184 withdrawals accepted). §4.5 makes a validation failure atomic. | accepted | Validation faults are now identified independently, by `validateBatch` on the stack when the fault fires, and must leave points, coverage, watermark, version and hook calls unchanged; `onMutate` must not fire for them and must fire once for a put that passed validation. A new outcome asserts that each batch reaches a validation fault. Proved by scratch mutations, undone with the Edit tool: the reviewer's wrapper (`c.invalidate` over the put's range after a validation fault) now fails 630 of 640 seeds, and a variant that withdraws the coverage directly (`cacheInternals(c).coverage.subtract`, which fires no `onMutate`) fails 573 of 640 on the nothing-changed check alone. |
| PR-2 | P2  | The replay instructions named `runCase(seed)`, which is not exported and takes more arguments.                                                                                                                                                                                                                                                                                                                                             | accepted | Both test headers and this file now say to narrow the `it.each` table to the seed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Round 1 — reviewer verdict: merge after fixes

2026-11-10. Both findings were validated before fixing, by reading `CacheState.put` and by simulating the library regression in a scratch wrapper inside the test (undone with the Edit tool). Every typed-array allocation after validation is inside `store.put`: `#clear` and the meta checks allocate none, so the version step always completes before such a fault, and `#writeOrWithdraw` always withdraws the whole range. Both rules are therefore what the library must do, and the old test could not tell.

| #    | Sev | Finding                                                                                                                                                     | Decision | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1-1 | P1  | The failed put's version transition was taken from the cache's own `version`, so a regression that rolled back the adoption was expected rather than caught | accepted | `test: derive a failed put's version step and require its coverage withdrawn`: the model applies `meta.version` for every fault after validation, and the cache's version and `onVersionClear` count must match. Scratch wrapper restoring the version an unversioned cache had before a failed write (`cacheInternals(c).adoptVersion(undefined)`): the old test passed all 640 seeds, the new one fails 178 of 640. (The same rollback after a mismatch clear was already caught by the hook count: 461 of 640.) |
| R1-2 | P1  | When a failed write changed no point, the test did not require its range to be uncovered, and then adopted the kept coverage into the model                 | accepted | Same commit: after every fault past validation the put's whole range must be uncovered. Scratch wrapper re-adding the range's former coverage when no point changed: the old test passed all 640 seeds, the new one fails 535 of 640.                                                                                                                                                                                                                                                                              |

While re-running the suite under a load average of 19, one 160-seed batch of the fault test timed out at Vitest's 5 s default. Per `docs/testing.md` the timeout was not raised: the same seeds now run in eight batches per file instead of four, which the same commit does; each batch takes 0.4–0.7 s at a load average of 13. Three runs of the whole package suite then passed at load averages 13 to 16.

## Contract-test changes

None. No existing test was changed.

## Not verified

- Failures inside `hydrate` (§4.5 "Hydrate: failure part-way") and `restore`: only `put` is injected.
- Allocations through typed-array methods (`slice`, `subarray`) are not injected: they build through the species constructor, which the wrappers leave alone. `segment-atomic-alloc.test.ts` covers one such case by example.
- Values near ±2^53 and slot caps above 32 768 through the cache (review §2.4); the model's universe spans at most 81 slots per seed.
- The final `bun run ci` result is in the step's report to the director.
