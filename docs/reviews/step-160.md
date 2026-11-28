# Step 160 — raise the worker size budget after merging steps 135 and 148

Branch: `fix/160-worker-size-budget` · Reviewer: the director · Pre-review: 1 (Fable 5.2), not the gate · Rounds: 0 · Status: urgent fix, main red

## Scope

The `ci` run on main at `b4ca1ac6` (run 46127751031) failed in the size check: `scripts/size.ts` measured the `worker` entry at 21.42 kB brotli against its budget of 21.31 kB (21,824 bytes, `packages/tscache/bench/budgets.json`). It was the first build to combine #177 (step 148, `segment/payload.ts`) with #180 (step 135, the M5 deploy-skew code); each pull request passed the check on its own. The director decided (full decision authority, 2026-11-28) to raise the budget by the repository's rule rather than shrink the worker in an urgent fix, as `7d875f0c` and `48ca012b` did. Only the `worker` value in `budgets.json` changes.

## Measurements

Brotli bytes from `measureEntry` in `scripts/size-measure.ts`, on a fresh `bun run build` of each commit:

| Commit     | What it is                            | `worker` | `worker (lazy)` |
| ---------- | ------------------------------------- | -------: | --------------: |
| `00740604` | main before #177                      |   20,118 |           5,929 |
| `cafaec4d` | main with #177 (step 148)             |   20,237 |           5,929 |
| `440d968f` | main just before #180 (includes #177) |   20,237 |           5,929 |
| `5e5d0e48` | #180's head (step 135, without #177)  |   21,781 |           6,022 |
| `b4ca1ac6` | main with both                        |   21,936 |           6,022 |

Step 135 alone sits 43 bytes inside the 21,824 budget; the merged build is 112 bytes over it. Every other entry on `b4ca1ac6` is within its budget: `index` 6,458 (budget 6,976), `index (lazy)` 19,094 (19,504), `index (lazy, nested)` 6,090 (6,608), `worker (lazy)` 6,022 (6,448), `engine` 15,755 (16,016), `fetcher` 177 (656), `grid` 3,749 (4,240), `vite` 1,266 (1,488).

## The rule

A budget is the measured size plus max(512 B, 3 %), rounded up to 16 bytes (`budgetFor` in `scripts/size-budget.ts`). For `worker`: 21,936 + 658.08 = 22,594.08, rounded up to 22,608. Budget 21,824 -> 22,608.

## Verification

- `bun scripts/size.ts` on this branch after `bun run build`: every row `ok`, `worker` 21.42 kB against 22.08 kB.
- `~/code/tscache-reports/bin/heavy-run.sh "160 budget ci" bun run ci` on head `58e96340`: exit 0. Vitest 193 files and 3,909 tests passed, Playwright 229 passed, and the bench smoke was `ok`.

## Pre-review 1 (Fable 5.2), not the gate

Run on head `fa644ef0`. Two documentation findings, both validated and accepted by the director.

| #     | Sev | Finding                                                                                                                                                    | Decision | Resolution                                                                                                                                                                       |
| ----- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR1-1 | P2  | The "Exact budgets" row of `docs/benchmarking.md` (line 28) still gives step 135's sizes from before its merge with step 148, `worker` 20.68 kB among them | accepted | Confirmed at line 28; the row gives the `b4ca1ac6` sizes from Measurements and keeps step 135's merged sizes as history, as `34f484af` did. Fixed in the commit after `fa644ef0` |
| PR1-2 | nit | This file left the `bun run ci` result to the director's report instead of recording it                                                                    | accepted | Verification records the command, head, exit code and counts. Fixed in the commit after `fa644ef0`                                                                               |

## Contract-test changes

None.

## Decision concerns

None.
