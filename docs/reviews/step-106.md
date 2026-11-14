# Step 106 — the health score ignores test files everywhere

Branch: `chore/106-health-ignore` · Reviewer: pending · Rounds: 0 · Status: implementation complete, review pending

## Scope

User decision 66 A (2026-11-15): Fallow's health score counts test files as importers and as long functions, so the coupling deduction cannot move without editing tests. `.fallowrc.json` already excluded `packages/*/test/**` from `health.ignore` for that reason. This step adds the other test trees with the same reason: `e2e/**` (the Playwright specs and their pages), `integrations/test/**` and `scripts/**/*.test.ts`. No threshold changes; the CI floor stays `fallow health --min-score 90`.

| Commit (by subject)                                         | What                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| `chore(fallow): ignore every test tree in the health score` | The three globs in `health.ignore` and the comment.       |
| `docs(review): step 106, the health score ignores tests`    | This file and the `docs/reviews/` row of `docs/INDEX.md`. |

## Score

Measured with `bunx fallow health --score --format json` (Fallow rounds each penalty to one decimal and subtracts the rounded penalties; see `docs/reviews/step-93.md`).

| Tree                                | Score | Grade | Unit size | Coupling | Functions over 60 lines |
| ----------------------------------- | ----: | ----- | --------: | -------: | ----------------------: |
| `main` at 20ec765, before this step |  93.4 | A     |      −4.4 |     −2.2 |                      16 |
| This branch                         |  96.4 | A     |      −1.5 |     −2.1 |                       3 |

On this branch `bunx fallow health --min-score 96.4` exits 0 and `--min-score 96.401` exits 1, so the gated value is 96.4; `--min-score 90` (the CI floor) exits 0.

Step 93 predicted 97.2 for this change, measured on 7577ac4 when the only long functions left outside tests were `fetcherUrl`. The difference is two long functions added since, both in the demo recorder (`scripts/demo/record.ts`), which is not a test and stays counted.

### The long functions left

From `bunx fallow health --complexity --max-cyclomatic 0 --max-cognitive 0 --format json`, filtered to `line_count > 60`:

| Lines | Function                                                    | Notes               |
| ----: | ----------------------------------------------------------- | ------------------- |
|   103 | `packages/tscache/src/vite/fetcher-url.ts:120` `fetcherUrl` | src, protected path |
|    81 | `scripts/demo/record.ts:942` `main`                         | demo recorder       |
|    68 | `scripts/demo/record.ts:630` `record`                       | demo recorder       |

The thirteen now ignored, all in test files or a test harness page: `e2e/reference/clients.spec.ts` (two), `e2e/examples/benchmark.spec.ts`, `e2e/demo/launcher.spec.ts`, `e2e/pages/refresh-harness.js`, `integrations/test/connection.test.ts`, `integrations/test/vanilla.test.ts`, `integrations/test/hydration.test.ts` (two), `scripts/demo/processes.test.ts`, `scripts/demo/owned.test.ts`, `scripts/demo/request.test.ts` and `scripts/test-clocks.test.ts`.

## Documents that state the score

`git grep` for `94.3` and for the health score finds the figure only in earlier review files (`docs/reviews/step-83.md`, `step-93.md`, `2026-11-review.md`), which are historical and kept as written. `docs/workflow.md` names the floor (90) and the command, not a current score, so it is unchanged.

## Verification

| Command                                                                | Result                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `bunx fallow health --score --format json` on `main` (20ec765)         | 93.4 A; unit size −4.4, coupling −2.2                   |
| `bunx fallow health --score --format json` on this branch              | 96.4 A; unit size −1.5, coupling −2.1                   |
| `bunx fallow health --min-score 96.4` / `96.401` / `90` on this branch | exit 0 / 1 / 0                                          |
| `~/code/tscache-reports/bin/heavy-run.sh "106 child: ci" bun run ci`   | run on the final head; the result is in the step report |

## Contract-test changes

None. No test is changed.

## Decision concerns

None.
