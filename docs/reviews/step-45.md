# Chore 45 — Confirming calibration for a Chromium timing gate

Branch: `chore/45-bench-gate-chromium` · Status: awaiting review

Chore 43's calibration on main `89efd15` found Chromium meeting the gate's bar in every case, against two earlier calibrations it failed. The plan, approved under "widen the gate as calibrations pass", was one more calibration: Chromium cases that meet the bar in both chore 43's and this one join `packages/tscache/bench/gated.json`. Run by a child agent while the user was away; the dispatches ran on GitHub's standard runners only (public repository, no cost).

## Scope

| Commit | What |
|---|---|
| (this commit) | Calibration log rows, verdict and the "Next" item in `docs/benchmarking.md`, and this file |

No code, test or `gated.json` change: no Chromium case qualified.

## Decisions

- **The bar, per runtime and case:** at slowdown 0, at least 19 of 20 runs quiet and no false alarm; at 0.25, detection of at least 90 % of quiet runs. A case must meet it in this calibration and in chore 43's.
- **No Chromium case gates.** Detection was 20 of 20 in all nine cases and no case fired, but the A/A control was noisy in 2 of 20 runs at slowdown 0, leaving 18 quiet runs. The control is per runtime, so every Chromium case falls short together. The two noisy intervals, [0.937, 1.017] and [0.992, 1.055], missed [0.95, 1.05] narrowly.
- **No change to the Bun gate.** The eight gated Bun cases met the bar again (19 quiet runs with no false alarm; 20 of 20 at 25 %). `read-year` caught 14 of 20 (70 %) and stays report-only; nothing contradicts the gated set.
- **Gate rules text unchanged**, since Chromium still only reports.

## Evidence

Dispatches of `bench-calibrate.yml` on GitHub's `ubuntu-24.04` runner, branch at `cd4f892` (main after #61), setup `default` (100 ms batches, 30 rounds), 20 jobs each; both runs concluded `success`. Tallies from `bun scripts/bench-calibration.ts <artifacts> <slowdown>` over the downloaded `calibration-*` artifacts; noisy controls read from each job's `<runtime>.json`.

| Run | Slowdown | Bun | Chromium |
|---|---|---|---|
| 41126635817 | 0 | 19 quiet (1 noisy, job 8: control 1.044 [1.037, 1.055]); no case fired | 18 quiet (2 noisy: job 3, 0.986 [0.937, 1.017]; job 16, 1.013 [0.992, 1.055]); no case fired |
| 41126649937 | 0.25 | 20 quiet: 20 in eight cases, 14 in `read-year` | 20 quiet: 20 in all nine cases |

Chromium's quiet count at slowdown 0 with the current default timing: 19 of 20 (chore 39, run 40995981693), 19 of 20 (chore 43, run 41077561504), 18 of 20 (this run).

## Contract-test changes

None.

## Decision concerns

- Chromium's quiet count sits at the edge of the bar of 19 of 20 (19, 19, 18 in three dispatches). Options: keep the bar and calibrate again later; count quiet runs over more jobs (for example 40) so that one noisy run weighs less; or accept that a noisy run fails nothing (the gate already stands down when its control is noisy) and judge Chromium on false alarms and detection alone. The last would gate all nine Chromium cases on the evidence so far. Recommendation: keep the bar for now; the user decides whether to relax it.
- Whether to make the `bench` check required in branch protection (carried over from chore 43).

## Review rounds

| Round | Verdict | Findings | Triage |
|---|---|---|---|
| 1 | merge | none | Settled after one round. The decision concern above (Chromium's bar of 19 of 20) is taken as recommended: the bar stays, and Chromium is calibrated again later. It is listed for the user with the `bench` required-check question. |
