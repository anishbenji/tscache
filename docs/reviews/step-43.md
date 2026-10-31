# Chore 43 — Per-case timing gate in Bun

Branch: `chore/43-bench-gate-bun` · Reviewer: Codex (high) · Rounds: 1 · Status: settled

Turns the paired timing gate on for the Bun cases that calibration on GitHub's runner shows reliable, as the performance plan recommends (§7.3, the Bun-only per-case gate). The user approved it after items 1–4 of the plan landed (#51, #52, #56, #57). Built and calibrated by a child agent while the user was away; calibration dispatches ran on standard runners only (public repository, no cost).

## Scope

| Commit | What |
|---|---|
| 719c75c | `feat(bench)`: `gatedCases()` reads and validates `packages/tscache/bench/gated.json` (bun and chromium only, string case names, no duplicates); `failing()` picks the confirmed regressions of gated cases in a quiet run. `bench.ts compare --gate` fails only on those; the summary marks each case `gates` or `reports`, and each runtime's record carries `gated` and `failing`. New `test/perf/gated.test.ts`. The lists start empty |
| df37955, 2b38ca9 | The `read-year` injection experiment: a case could ask calibration to slow it by repetition, and `read-year` did (reverted below) |
| 37f6266 | `ci(bench)`: `gated.json` lists the eight Bun cases that passed; the `bench` job runs `compare --gate`; its end-to-end step runs after a gated failure too |
| 254d2a4 | `revert(bench)`: withdraws the experiment, which did not support its hypothesis |
| (this commit) | Calibration log, gate rules and verdict in `docs/benchmarking.md`, and this file |

## Decisions

- **The gated cases are data.** `packages/tscache/bench/gated.json` maps a runtime to the cases that gate there; `bench.ts` reads it, and a test checks it names only cases the bench runs. A sibling of `budgets.json` rather than part of it, because `bun scripts/size.ts --update` rewrites `budgets.json`.
- **Node cannot be listed**, so the rule that Node only reports stays enforced; a runtime listed with no case reports, as Chromium does.
- **Eight Bun cases gate, `read-year` does not.** The bar was no false alarm in 20 runs (at least 19 quiet) and at least 90 % detection at 25 %. Eight cases met it with 20 of 20; `read-year` caught 17 of 20 (85 %).
- **The injection is unchanged.** The repetition experiment measured the same slowdown as the wait (median ratio about 1.26 against 1.28 at 25 %) and the same detection at 15 % (5 of 18 against 4 of 19). Its 20 of 20 at 25 % is within the case's noise, so it does not show that the wait absorbed the slowdown, and gating `read-year` on it would rest on one lucky dispatch. The option and its test were withdrawn with the experiment. They had only existed on this branch, so no test on `main` was removed.
- **Chromium stays report-only**, though it met the bar in this calibration (below): one dispatch per slowdown, against two earlier calibrations it failed. The task said to report it as an option, not to gate it.
- **The `bench` check stays non-required.** It fails loudly on a gated regression; making it required is a branch-protection setting for the user.
- **The end-to-end step runs after a gated failure** (`if: ${{ !cancelled() }}`), so a failing run still reports the scenarios. It still continues on error.

## Evidence

Dispatches of `bench-calibrate.yml` on GitHub's `ubuntu-24.04` runner, setup `default` (100 ms batches, 30 rounds), 20 jobs each. Tallies from `bun scripts/bench-calibration.ts <artifacts> <slowdown>` over the downloaded `calibration-*` artifacts; `read-year`'s per-run samples read from each job's `bun.json`.

| Run | Commit | Slowdown | Bun | Chromium |
|---|---|---|---|---|
| 41077561504 | 89efd15 (main) | 0 | 20 quiet; no case fired | 19 quiet (1 noisy); no case fired |
| 41077575673 | 89efd15 | 0.15 | 19 quiet: 17–19 in eight cases, 4 in `read-year` | 19 quiet: 19 in seven cases, 17 `put-live-bar`, 13 `read-viewport-sessions` |
| 41077588416 | 89efd15 | 0.25 | 20 quiet: 20 in eight cases, 17 in `read-year` | 20 quiet: 20 in every case |
| 41078306816 | 2b38ca9 (`read-year` by repetition) | 0.15 | 18 quiet: 5 in `read-year` | — |
| 41078312567 | 2b38ca9 | 0.25 | 20 quiet: 20 in every case, `read-year` included | 20 in every case |

`read-year` in Bun at 25 %: median measured ratio 1.28 with the wait (range 1.16–1.39), 1.26 with repetition (1.15–1.34). Its time per call ranged 3.4–11.6 ms across jobs, in two clusters near 4 and 8 ms, with 16 or 32 calls per batch. The three misses with the wait were two flagged runs whose confirmation fell short and one interval whose low end was below 1.03 (1.026).

Local checks (Apple Silicon Mac):
- `bunx vitest run packages/tscache/test/perf/gated.test.ts`: 8 passed. Before `gatedCases` existed, the file failed to load.
- Under the heavy-job lock, `bun scripts/bench.ts compare --base HEAD --runtime bun --only <case> --slowdown 0.25 --gate`: `put-live-bar` (gated) 1.270 [1.263, 1.274], `regression`, `gates`, exit 1, with "Confirmed regression of a gated case: put-live-bar@bun"; `read-year` (report-only) 1.296 [1.269, 1.325], `regression`, `reports`, exit 0.
- `bun run typecheck`, `bun run bench:smoke`: clean.
- `~/code/tscache-reports/bin/heavy-run.sh "gate child: ci" bun run ci` is run on the final commit; its result is in the child agent's report.

## Contract-test changes

None. `test/perf/gated.test.ts` is new. `test/perf/slowed.test.ts` was added and removed on this branch with the experiment it tested.

## Decision concerns

- Whether to gate Chromium's cases, which met the bar in this calibration only.
- Whether to make the `bench` check required in branch protection.

## Round 1 — reviewer verdict: merge

No findings; `bun run ci` passed. Settled.
