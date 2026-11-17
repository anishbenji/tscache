# Step 119 — mutation History row after step 114 (M7)

Branch: `docs/119-mutation-after-m7` · Status: awaiting review

## Scope

User decision 62 item 4 (2026-11-16): run Stryker after each merged step that touches engine logic, under the heavy-job lock, with no gate, and add one dated row to the History table in `docs/benchmarks/mutation.md`. Step 114 (M7 change events, PR #146) touched `engine/` and `persist/` and merged as `8cbb162`. This step adds the row for that commit and three lines of notes under the table. It changes no source or test, and leaves the step 84 analysis alone.

## The run

`~/code/tscache-reports/bin/heavy-run.sh "119 child: stryker" bun run mutation` from the worktree root on 2026-11-17 (lock taken 13:25:41Z), with the repository's `stryker.config.json`, in this worktree and not a scratch copy. `main` at `8cbb162`, Stryker 10.1.1 (`bunx stryker --version`), six test-runner processes. The wrapper exited 0.

| Mutants | Killed | Timed out | Survived | No coverage | Errors | Score | Covered score | Run time           |
| ------: | -----: | --------: | -------: | ----------: | -----: | ----: | ------------: | ------------------ |
|   4,559 |  4,026 |       193 |      306 |          34 |      0 | 92.54 |         93.24 | 81 m 4 s (Stryker) |

| Area            | Mutants | Killed | Timed out | Survived | No coverage | Score |
| --------------- | ------: | -----: | --------: | -------: | ----------: | ----: |
| `grid.ts`       |     116 |     92 |        17 |        7 |           0 | 93.97 |
| `coverage.ts`   |     104 |    100 |         2 |        2 |           0 | 98.08 |
| `segment/`      |     636 |    555 |        60 |       21 |           0 | 96.70 |
| `engine/`       |   1,879 |  1,713 |        73 |       86 |           7 | 95.05 |
| `orchestrator/` |     503 |    452 |         3 |       45 |           3 | 90.46 |
| `persist/`      |   1,321 |  1,114 |        38 |      145 |          24 | 87.21 |

The per-area scores come from `reports/mutation/mutation.json`, grouping each file by its path under `packages/tscache/src` as step 113 did. The same grouping reproduces Stryker's overall 92.54 and covered 93.24 from that JSON, and every mutant landed in one of the six areas. `reports/mutation/` is in `.gitignore` and is not committed.

## Changes against the step 113 row

- No area fell by more than a point (`engine/` 95.06 to 95.05).
- Step 114 added no file under `engine/` or `persist/`. Survivors on lines it added or changed: `engine/cache.ts:370`, `engine/cache.ts:517` and `engine/engine.ts:149`. These are in the History notes.

## Not done

Machine load was not sampled during the run, so the 81-minute run time (68 minutes in step 113) is not explained. The survivor-to-line mapping for step 114 uses the line ranges of `git diff 7acab39 8cbb162`, so a survivor on an untouched line that step 114 changed the meaning of would not show.

## Contract-test changes

None.
