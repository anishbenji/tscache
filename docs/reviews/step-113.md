# Step 113 — a dated history table for mutation runs

Branch: `docs/113-mutation-history` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: settled (round 1: no findings)

## Scope

User decision 62 item 4 (2026-11-16): run Stryker after each merged step that touches engine logic, under the heavy-job lock, with no gate, and record one dated row per run in `docs/benchmarks/mutation.md` (date, commit, Stryker version, overall score and score per area).

This step adds a `## History` section after "Scope" with the table the project dashboard parses (`| Date | Commit | Stryker | All | grid.ts | coverage.ts | segment/ | engine/ | orchestrator/ | persist/ |`), and fills two rows: the step 84 baseline, copied from the Results table (2026-11-13, `main` at `b2e1f06` as `docs/reviews/step-84.md` and the Results section record, Stryker 10.1.1), and a fresh full run on this branch's base, `main` at `7acab39`. The Results table and the survivor analysis are unchanged; they describe the step 84 run. One paragraph under History says which of the twenty listed survivors this run kills. "How to re-run" still matches the command used; its run-time sentence now mentions this slower run. Nothing under `packages/` or the configuration changes. `docs/INDEX.md`: the mutation report's row names the history and its size is re-measured (28.2 KB to 29.7 KB, `wc -c` 29,737 bytes).

## The run

`~/code/tscache-reports/bin/heavy-run.sh "113 child: stryker" bun run mutation` from the worktree root, with the repository's `stryker.config.json`, on 2026-11-16 (lock taken 10:18:53Z). Stryker 10.1.1 (`bunx stryker --version`), Node 26.13.0, Vitest 5.0.5, six test-runner processes; the initial test run passed 2,328 tests in 48 s.

| Mutants | Killed | Timed out | Survived | No coverage | Errors | Score | Covered score | Run time           |
| ------: | -----: | --------: | -------: | ----------: | -----: | ----: | ------------: | ------------------ |
|   4,459 |  3,895 |       222 |      308 |          34 |      0 | 92.33 |         93.04 | 68 m 0 s (Stryker) |

| Area            | Mutants | Killed | Timed out | Survived | No coverage | Score |
| --------------- | ------: | -----: | --------: | -------: | ----------: | ----: |
| `grid.ts`       |     116 |     85 |        24 |        7 |           0 | 93.97 |
| `coverage.ts`   |     104 |    100 |         2 |        2 |           0 | 98.08 |
| `segment/`      |     636 |    549 |        66 |       21 |           0 | 96.70 |
| `engine/`       |   1,783 |  1,606 |        89 |       81 |           7 | 95.06 |
| `orchestrator/` |     501 |    448 |         3 |       47 |           3 | 90.02 |
| `persist/`      |   1,319 |  1,107 |        38 |      150 |          24 | 86.81 |

The per-area scores come from `reports/mutation/mutation.json`, with each file grouped into its area by path under `packages/tscache/src`; the same grouping reproduces Stryker's overall 92.33 (and covered 93.04) from that JSON, and each area matches Stryker's clear-text table. `reports/mutation/` is in `.gitignore` and is not committed.

**Machine load.** Load averages (1, 5 and 15 minutes): 8.62, 4.48, 3.19 at launch; 127.30, 57.57, 35.38 at 11:23:58Z, near the end; 19.00, 41.52, 33.11 as the run ended. The run took 68 minutes against step 84's 37 m 35 s, and timed out 222 mutants against 149 (`grid.ts` 24 against 1). A timeout counts as killed, so a mutant that timed out only because the machine was loaded can raise the score; the History section says so.

**Wrapper.** The Bash tool's background shell that launched the wrapper exited (code 144) while Stryker was at 95%; `heavy-run.sh` and Stryker kept running, Stryker finished ("Done in 68 minutes and 0 seconds") and wrote its HTML and JSON reports, and the wrapper released the lock, which the next queued job took at 11:26:55Z. The wrapper's exit code was not captured, because the shell that would have printed it had exited.

## Contract-test changes

None.

## Round 1 (GPT-6.1 Sol, high) — reviewer verdict: merge

Run on head `1cb51d4`. No findings. The reviewer checked the scores and survivor updates against the Stryker report
and its source commit `7acab39`; the round's `bun run ci` exited 0. Raw output: `.reviews/step-113/round-1.md`. The
review has settled.

## Decision concerns

None.
