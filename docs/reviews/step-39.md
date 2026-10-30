# Chore 39 — Chromium bench noise on GitHub's runner

Branch: `chore/39-bench-chromium-noise` · Reviewer: not yet reviewed · Rounds: 0 · Status: awaiting review

Runs the Chromium noise experiment of the performance plan (§7.3): which setup keeps Chromium's A/A control inside [0.95, 1.05] on GitHub's runner. Implemented and dispatched by Claude while the user was away, under the user's grant of 2026-10-30 (standard runner minutes are free on a public repository; no larger or paid runner was used).

## Scope

| Commit | What |
|---|---|
| 364810c | `bench.ts compare --setup <name>` and a `setup` input on `bench-calibrate.yml`; setups in `packages/tscache/bench/setups.ts` (tested); `batchMs` passed from the run options to the sampler; the record names its setup; on Linux the Chromium run logs its binaries and processes |
| b0345b1 | The default setup times `compare` with 100 ms batches and 30 rounds; the earlier timing stays as `short-batches`; the end-to-end scenarios keep 20 rounds; the process log groups by binary and process type |
| (this commit) | Calibration log and verdict in `docs/benchmarking.md`, and this file |

## Decisions

- **One setup per change, plus a combined one.** The plan lists three changes; `combined` (all three) was dispatched as well, at no cost, so a single run would show whether they add up.
- **A same-day control.** `default` was dispatched beside the variants, since Chromium's quiet count on the runner varied from 0 to 16 of 20 between earlier days.
- **The new default is the longer batches alone, not `combined`.** Both reached the bar (19 and 20 of 20). The switches alone did worse than the control (12 and 10 against 15 of 20), the renderer limit had nothing to limit, and 19 against 20 is not a difference one dispatch can show. One change the evidence supports was kept, rather than four of which three had no measured effect.
- **The longer timing applies to Bun as well.** It is one sampler setting; the recalibration covers both runtimes.
- **The gate stays report-only.** Turning it on is the planned separate step (performance plan §8, item 5), and the user's decision on its scope.

## Evidence

All dispatches on GitHub's `ubuntu-24.04` runner, 20 jobs each. Tallies from `bun scripts/bench-calibration.ts <artifacts> <slowdown>` over the downloaded `calibration-*` artifacts, and the Chromium control of each job read from its `chromium.json` (its interval, batch size and the setup it records).

| Run | Commit | Setup | Slowdown | Chromium quiet | Bun quiet | Result |
|---|---|---|---|---:|---:|---|
| 40995973064 | 364810c | default (40 ms, 20 rounds) | 0 | 15 | 19 | no case fired |
| 40995975915 | 364810c | unthrottled | 0 | 12 | 19 | no case fired |
| 40995979086 | 364810c | one-renderer | 0 | 10 | 20 | no case fired |
| 40995981693 | 364810c | long-batches (100 ms, 30 rounds) | 0 | 19 | 20 | no case fired |
| 40995984942 | 364810c | combined | 0 | 20 | 20 | no case fired |
| 40999175509 | b0345b1 | default (100 ms, 30 rounds) | 0.15 | 20 | 20 | see the calibration log |
| 40999178404 | b0345b1 | default (100 ms, 30 rounds) | 0.25 | 19 | 19 | all cases ≥ 95 % except Chromium `put-page` 84 %, Bun `read-year` 47 % |

The process log of runs 40995973064 and 40995979086 shows `chrome-headless-shell` with one browser, two zygote, one GPU, one network and one renderer process, with or without `--renderer-process-limit=1`.

Local checks: `bunx vitest run packages/tscache/test/perf/setups.test.ts` (6 passed); `bun scripts/bench.ts compare --base HEAD --runtime chromium,bun --only read-viewport --setup combined` (30 rounds, batches of 8192 calls of 14 µs, about 115 ms); `bun scripts/bench.ts e2e --base HEAD --only two-tabs-one-fetch` (20 rounds, unchanged).

## Contract-test changes

None.

## Decision concerns

None.
