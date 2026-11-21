# Step 124 — mutation History row after step 121 (M3)

Branch: `docs/124-mutation-after-m3` · Status: awaiting review

## Scope

User decision 62 item 4 (2026-11-16): run Stryker after each merged step that touches engine logic, under the heavy-job lock, with no gate, and add one dated row to the History table in `docs/benchmarks/mutation.md`. Step 121 (M3 memory bounds, PR #150) touched `engine/`, `segment/`, `orchestrator/` and `persist/`. By the time the run started, three more merges had changed measured files: step 131 (PR #159, `engine/cache.ts`), step 133 (PR #160, `orchestrator/auth.ts` and `orchestrator/orchestrator.ts`) and step 129 (calendar grids, PR #161, `grid.ts`, `engine/`, `segment/`, `orchestrator/` and `persist/records.ts`). The row is for `main` at `1ab139b` and covers all four. Step 122 (PR #153) also merged since the step 119 row but changed no source file. This step adds the row, the notes under the table and one run-time clause in "How to re-run". It changes no source or test, and leaves the step 84 analysis alone.

## The run

The director ran `~/code/tscache-reports/bin/heavy-run.sh "stryker main 1ab139b4" bun run mutation` in the dedicated worktree `~/.t3/worktrees/tscache/stryker-main`, checked out at `main` `1ab139b4`, with the repository's `stryker.config.json` and `vitest.mutation.config.ts` (60 s Vitest timeouts since step 126). The lock was taken at 05:48:27Z on 2026-11-21; Stryker finished at 08:23:51Z ("Done in 155 minutes and 24 seconds") and the wrapper exited 0. Stryker 10.1.1 (`node_modules/@stryker-mutator/core/package.json` and `bun.lock` in that worktree), six test-runner processes; the initial test run passed 2,876 tests in 1 m 14 s. This step's branch did not run Stryker; it read the reports that run wrote.

| Mutants | Killed | Timed out | Survived | No coverage | Errors | Score | Covered score | Run time             |
| ------: | -----: | --------: | -------: | ----------: | -----: | ----: | ------------: | -------------------- |
|   6,159 |  5,086 |       467 |      567 |          39 |      0 | 90.16 |         90.74 | 155 m 24 s (Stryker) |

| Area            | Mutants | Killed | Timed out | Survived | No coverage | Score |
| --------------- | ------: | -----: | --------: | -------: | ----------: | ----: |
| `grid.ts`       |     961 |    832 |        55 |       70 |           4 | 92.30 |
| `coverage.ts`   |     104 |    100 |         2 |        2 |           0 | 98.08 |
| `segment/`      |     695 |    601 |        42 |       51 |           1 | 92.52 |
| `engine/`       |   2,438 |  2,177 |        58 |      196 |           7 | 91.67 |
| `orchestrator/` |     621 |    532 |        20 |       66 |           3 | 88.89 |
| `persist/`      |   1,340 |    844 |       290 |      182 |          24 | 84.63 |

The per-area scores come from `reports/mutation/mutation.json` in the `stryker-main` worktree, grouping each file by its path under `packages/tscache/src` as step 113 did. The same grouping reproduces Stryker's overall 90.16 (90.1607 unrounded) and covered 90.74 from that JSON, every mutant landed in one of the six areas, and each area matches Stryker's clear-text table. `reports/mutation/` is in `.gitignore` and is not committed.

**Run time.** 155 minutes, against 81 in step 119 and the roughly 40 minutes "How to re-run" quoted before step 126. Other agents' light work shared the machine throughout the run, and the load was not sampled, so how much of the time is load and how much is the 60 s timeouts and the 1,600 added mutants is not known. Step 126's stopped run had projected about 3 hours for 5,027 mutants with the same timeouts.

## Changes against the step 119 row

- Five areas fell by more than a point: `segment/` 4.18, `engine/` 3.38, `persist/` 2.58, `grid.ts` 1.67 and `orchestrator/` 1.57. `coverage.ts` is unchanged.
- Survived or uncovered mutants on lines the merges added or changed: `grid.ts` 66 of 74, `engine/` 84 of 203, `orchestrator/` 22 of 69, `segment/` 14 of 52 and `persist/` 5 of 206. On untouched lines, `persist/`, `segment/` and `engine/` have more such mutants (201, 38, 119) than the whole area had in the step 119 row (169, 21, 93).
- New file in scope from step 121: `engine/memory.ts`, 25 survivors among 131 mutants, none without coverage.

These are in the History notes.

## Not done

Machine load was not sampled. The step 119 run's JSON report is not kept, so the rise in survivors on untouched lines cannot be traced mutant by mutant to the step 126 timeout change, to changed tests or to load. The survivor-to-line split uses the added-line ranges of `git diff -U0 8cbb162 1ab139b4`; a survivor on an untouched line whose meaning a merge changed counts as untouched.

## Contract-test changes

None.

## Decision concerns

None.
