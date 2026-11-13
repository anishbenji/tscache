# Step 84 — Measure mutation testing of the engine

Branch: `chore/84-mutation-measure` · Reviewer: not run by the implementer (the director runs the review loop) · Status: built, awaiting review

## Scope

A measurement, at the user's request of 2026-11-13: how well the engine's tests catch injected defects. Stryker mutated the folders the test-first rule names (`grid.ts`, `coverage.ts`, `segment/`, `engine/`, `orchestrator/`, `persist/`) and ran the package's Vitest suite against each mutant. The results, the twenty most telling survivors and how to re-run are in [`docs/benchmarks/mutation.md`](../benchmarks/mutation.md): 4,459 mutants, mutation score 89.17 overall, from 98.08 (`coverage.ts`) down to 82.87 (`persist/`).

Nothing in CI, the hooks or a workflow runs Stryker, and no test changes: the survivors are the input for later steps. Nothing under `packages/tscache/src` changes.

| Commit (by subject)                                       | What                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chore: configure stryker mutation testing of the engine` | `stryker.config.json`, `vitest.mutation.config.ts` (the root Vitest configuration narrowed to `packages/tscache/test`), `.gitignore`, `.fallowrc.json` |
| `docs: report the engine's mutation scores`               | `docs/benchmarks/mutation.md`, its `docs/INDEX.md` row, this file                                                                                      |

**The two Stryker dev dependencies are not in this branch.** The brief pre-approved `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` (10.1.1, the current stable release, pinned exactly), but the unattended session's dependency guard refused `bun add` with "Adding, removing or upgrading a dependency needs Anish's OK". The step did not work around it: `package.json` and `bun.lock` are unchanged. The measurement ran in a throwaway copy of the worktree in the session's scratch directory, where the guard allows installs, with the same configuration files. Adding the dependencies is the one command under "How to re-run" in the mutation report; until then `stryker.config.json` is inert, and Knip and Fallow see no Stryker dependency to check.

Toolchain notes, both recorded in the configuration's comments:

- Bun installs each package in isolation, so Stryker's default plugin search finds no runner next to its core; `plugins` names the Vitest runner.
- Stryker's tsconfig rewrite calls the TypeScript JS API, which TypeScript 7 does not ship, and fails at startup. `tsconfigFile` names a file that does not exist, which turns the rewrite off; it only adjusts paths that leave the sandbox, and none do.
- The Vitest runner passes Vitest only a configuration file and a directory. `vitest.dir` rebases the root configuration's include globs and finds no test, and without a narrower configuration Stryker's related-file selection also ran the examples', reference clients', integrations' and scripts' tests (128 test files in a trial run on `grid.ts`, against 101 of the package). `vitest.mutation.config.ts` narrows the include to the package's suite; Fallow takes it as an entry, since only Stryker reads it.

## Verification

| Check                                                                                                          | Result                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `heavy-run.sh "84 child: stryker <area>" bunx stryker run stryker.<area>.json`, six areas, in the scratch copy | All six exit 0, no compile or runtime error; numbers in the mutation report                                     |
| Stryker's initial test run                                                                                     | Green in every area (2,301 tests where the whole suite is related; 254 for `orchestrator/`, 352 for `persist/`) |
| `bunx tsc -p .` (covers `vitest.mutation.config.ts`)                                                           | No errors                                                                                                       |
| `bunx biome check` on the new and changed files                                                                | Clean                                                                                                           |
| `bun run fallow` (base `main`)                                                                                 | No issues in the changed files, after the Fallow entry                                                          |
| `bunx knip`                                                                                                    | Only the findings a worktree shows before the package is built (child rules, rule 4)                            |
| `heavy-run.sh "84 child: ci" bun run ci` on the final head                                                     | Run on the final head; the exit code is in the child report to the director                                     |

Each survivor in the report's list was checked by reading its code and the tests that reach it; the per-test data comes from Stryker's JSON reports, which stay in the scratch copy (`reports/<area>.json`) and are not committed.

Not verified: a Stryker run from inside the repository, which needs the dependencies first, and the run times on an idle machine (the load average was 4 to 12 during the runs).

## Contract-test changes

None.

## Decision concerns

- Whether to add the two Stryker dev dependencies (and a `mutation` script) to the repository. The brief pre-approved them; the unattended guard needs the user's own OK.
