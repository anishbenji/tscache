# Step 84 — Measure mutation testing of the engine

Branch: `chore/84-mutation-measure` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: settled · Verdict after triage: merge (one P2 fixed)

## Scope

A measurement, at the user's request of 2026-11-13: how well the engine's tests catch injected defects. Stryker mutated the folders the test-first rule names (`grid.ts`, `coverage.ts`, `segment/`, `engine/`, `orchestrator/`, `persist/`) and ran the package's Vitest suite against each mutant. The results, the twenty most telling survivors and how to re-run are in [`docs/benchmarks/mutation.md`](../benchmarks/mutation.md): 4,459 mutants, mutation score 89.17 overall, from 98.08 (`coverage.ts`) down to 82.87 (`persist/`).

Nothing in CI, the hooks or a workflow runs Stryker, and no test changes: the survivors are the input for later steps. Nothing under `packages/tscache/src` changes.

| Commit (by subject)                                       | What                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chore: configure stryker mutation testing of the engine` | `stryker.config.json`, `vitest.mutation.config.ts` (the root Vitest configuration narrowed to `packages/tscache/test`), `.gitignore`, `.fallowrc.json` |
| `docs: report the engine's mutation scores`               | `docs/benchmarks/mutation.md`, its `docs/INDEX.md` row, this file                                                                                      |
| `docs: correct the mutation report after the pre-review`  | The pre-review's seven findings (below), re-running before and after the dependencies, the index sizes                                                 |
| `docs: keep only the in-repo stryker recipe`              | Security lane S1.1: the throwaway-copy recipe removed                                                                                                  |
| `docs(review): step 84 security lane`                     | This file                                                                                                                                              |

**The two Stryker dev dependencies are not in this branch.** The brief pre-approved `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` (10.1.1, the current stable release, pinned exactly), but the unattended session's dependency guard refused `bun add` with "Adding, removing or upgrading a dependency needs Anish's OK". The step did not work around it: `package.json` and `bun.lock` are unchanged. The measurement ran in a throwaway copy of the worktree in the session's scratch directory, where the guard allows installs, with the same configuration files. The director parked adding them for the user's decision. "How to re-run" in the mutation report records that the numbers were measured in that copy, pending user decision 60, and gives the run from the repository root once the dependencies are added. Until then `stryker.config.json` is inert, and Knip and Fallow see no Stryker dependency to check.

Toolchain notes (the first two are also in the configuration's comments):

- Bun installs each package in isolation, so Stryker's default plugin search finds no runner next to its core; `plugins` names the Vitest runner.
- Stryker's tsconfig rewrite calls the TypeScript JS API, which TypeScript 7 does not ship, and fails at startup. `tsconfigFile` names a file that does not exist, which turns the rewrite off; it only adjusts paths that leave the sandbox, and none do.
- The Vitest runner passes Vitest only a configuration file and a directory. `vitest.dir` rebases the root configuration's include globs and finds no test, and without a narrower configuration Stryker's related-file selection also ran the examples', reference clients', integrations' and scripts' tests (128 test files in a trial run on `grid.ts`, against 101 of the package). `vitest.mutation.config.ts` narrows the include to the package's suite; Fallow takes it as an entry, since only Stryker reads it.

## Verification

| Check                                                                                                          | Result                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `heavy-run.sh "84 child: stryker <area>" bunx stryker run stryker.<area>.json`, six areas, in the scratch copy | All six exit 0, no compile or runtime error; numbers in the mutation report                                                                                  |
| Stryker's initial test run                                                                                     | Green in every area (2,301 tests where the whole suite is related; 254 for `orchestrator/`, 352 for `persist/`)                                              |
| `bunx tsc -p .` (covers `vitest.mutation.config.ts`)                                                           | No errors                                                                                                                                                    |
| `bunx biome check` on the new and changed files                                                                | Clean                                                                                                                                                        |
| `bun run fallow` (base `main`)                                                                                 | No issues in the changed files, after the Fallow entry                                                                                                       |
| `bunx knip`                                                                                                    | Only the findings a worktree shows before the package is built (child rules, rule 4)                                                                         |
| `heavy-run.sh "84 child: ci" bun run ci` on the final head                                                     | Exit 0 on `10a9a716c88c61ebbe5ce88533f1d80349fc3938` (Vitest 2,674 of 2,674, Playwright 175 passed, bench smokes ok); the later commits change Markdown only |

Each survivor in the report's list was checked by reading its code and the tests that reach it; the per-test data comes from Stryker's JSON reports, which stay in the scratch copy (`reports/<area>.json`) and are not committed.

Not verified: a Stryker run from inside the repository, which needs the dependencies first, and the run times on an idle machine (the load average was 4 to 12 during the runs).

## Pre-review (Fable), not the gate

A Fable pre-review checked every number and file:line in the mutation report against the Stryker reports and raised seven accuracy findings, each validated against the code and tests before it was fixed. This is not the review gate; the director runs that.

| #    | Sev | Finding                                                                                                              | Decision | Resolution                                                                                                                                                                    |
| ---- | --- | -------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-1 | P2  | Row 17: the `:339` mutant is OptionalChaining and still closes the store, which `persister-flush.test.ts:138` checks | accepted | Row 17 now says no test closes a persister that has no store; the `:337` and `:338` parts stay                                                                                |
| PR-2 | P2  | Row 6: the six bad page numbers of `cache-restore-rejections.test.ts:162–169` are skipped under the mutant too       | accepted | Confirmed: `pageSnapshotOf` requires `pageOf(range) === page` (`engine/restore.ts:253–254`). Row 6 is split into a redundant guard (bad numbers) and the gap (order, repeats) |
| PR-3 | P2  | "75 unasserted error messages" counts every surviving string literal, about 18 of them logic literals                | accepted | Recounted from the reports: 57 messages (54 survived, 3 without coverage) and 18 logic literals (12 and 6), listed under real gaps                                            |
| PR-4 | P2  | Row 10: `overlaps` also decides the invalidate fence at `orchestrator.ts:474` (§4.9.1 rule 9, N64)                   | accepted | Row 10 names both call sites, what each mutant does (an unfenced fetch stays joinable, `:546`) and a one-slot test at each                                                    |
| PR-5 | P2  | Row 5: `cache-restore-rejections.test.ts:31` changes one dtype, but the fixture has a single field                   | accepted | Confirmed (`persist-test-helpers.ts:31`); row 5 says the kill needs a schema of two or more fields                                                                            |
| PR-6 | nit | Row 9: 8 mutants at `merge.ts:272–275`, not 9 at `:272–274`                                                          | accepted | Fixed; the ninth, at `:283`, is named with the two of `span`                                                                                                                  |
| PR-7 | nit | This file's CI row had no result or head                                                                             | accepted | The CI row records exit 0 and the head it ran on                                                                                                                              |

## Security lane (Claude), not the gate

- run 1, head 40cd12d: P0 0, P1 0, P2 1
- S1.1 P2: fixed in 4a18ee8

## Contract-test changes

None.

## Decision concerns

- Whether to add the two Stryker dev dependencies (and a `mutation` script) to the repository. The brief pre-approved them; the unattended guard needs the user's own OK. Parked as user decision 60.
- Whether measuring in a throwaway copy, the route taken because the unattended guard refused the install in the worktree, is acceptable. Raised by the security lane; parked as user decision 60.

## Round 1 — reviewer verdict: merge after fixes

One P2 (2026-11-14): row 20 of `docs/benchmarks/mutation.md` gave the wrong reason why the `clear-disk.ts:87` deadline-timer mutant survives (two tests do call `clearDisk` at a later clock, but settle through `run()` before the timer matters). Valid; the finding check reproduced both shapes against the real code. Fixed in `docs: the deadline-timer survivor's diagnosis`: the row names the missing case (a call after advancing the clock whose open or clear stays pending through the deadline).

## Finding check (claude-fable-5-2), round 1

V 1, P 0, I 0, D 0
