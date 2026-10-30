# Chore 24 — Calibration log for the GitHub runner

Branch: `chore/24-calibration-log` · Reviewer: Codex (high) · Rounds: in progress · Status: under review

Records the two calibrations of the timing gate on GitHub's runner (`bench-calibrate.yml`, dispatched three times each with slowdowns 0, 0.15 and 0.25) in `docs/benchmarking.md`, "Calibration log". Dispatched and judged by Claude while the user was away, under the user's grant of 2026-10-30 (runner minutes are free on a public repository). Documentation only: no code or workflow change.

## Scope

| Commit | What |
|---|---|
| 22bbb8e | First calibration, main at `0797cb5`: Bun passes except `read-year` at 25 % (84 %); Chromium too noisy to judge. Verdict: the gate stays report-only, with the three steps before it can block |
| 7b67216 | Recalibration on main at `f2a6020`, after step 22: no false alarm in either runtime; Bun catches every 25 % slowdown in six cases, `append-bars` and `snapshot-roundtrip` 89 %, `read-year` 17 %; Chromium catches four cases fully. Verdict: still report-only; next, why the injected slowdown in `read-year` measures smaller than injected |

## Evidence

Tallies from `bun scripts/bench-calibration.ts <artifacts> <slowdown>` over the downloaded `calibration-*` artifacts of each run (run ids in the log).
