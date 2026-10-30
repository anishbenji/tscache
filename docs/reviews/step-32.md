# Fix 32 — The sampler's tests measure no time

Branch: `fix/32-gate-sampler-flake` · Reviewer: Codex (high) · Rounds: 1 · Status: round 1 fixed · Verdict after triage: merge

`packages/tscache/test/perf/gate.test.ts` checked the bench sampler by timing a synthetic loop and asserting that the same operation against itself measured a median ratio between 0.7 and 1.4. It failed at 1.655 in step 22 (R3-1) and again in fix 26's pre-push, both times while other jobs ran on the machine. Done by a child agent while the user was away, under the user's grant of 2026-10-30.

## Root cause

Two causes, one in the test and one in the sampler.

1. **A timing assertion in the correctness suite.** The test timed real work with `performance.now()` in batches of 5 ms over 10 rounds. Whatever else the machine runs lands in some batches and not others, so the ratio of two identical operations depends on load. No bound makes such a check both meaningful and reliable on a shared machine or runner.
2. **Calibration trusted one timing.** `calibrate` grew the batch until the slower side's single timing reached `batchMs`. A pause of the process during that one timing (another job, a collection) ended calibration early, and every batch of the run was then far shorter than intended, so the rounds were noisier still. This affected the bench as well as the test. A test on a virtual clock shows it: with a 100 ms stall on the head's first call, the old sampler chose a batch of one call (0.5 ms against a 5 ms target).

## Scope

| Commit | What |
|---|---|
| 7b7f5d2 | `fix(bench)`: the sampler takes an optional `clock` (default `performance.now`; its type stays internal), and calibration takes the fastest of three timings per side at each batch size. The two timing tests are replaced by six tests on a virtual clock that the operations advance: exact ratios of 1 and 2 and the batch size, the A B, B A order of the rounds, a stall during calibration, a stalled round leaving the median and its interval unchanged, and, for `sampleAsync`, the same plus resets that take far longer than a batch moving no timing. `docs/benchmarking.md` describes the calibration and where the sampler's real-hardware behaviour is measured (rebased onto 15fa506; the documentation conflict with #50 kept #50's batches and rounds and added the calibration sentence) |
| d0f05e4 | `test(bench)`: R1-1 |

## Where the timing check went

The removed assertions asked two things of real hardware: that identical code measures a ratio near 1, and that a clearly slower operation is detected. The bench already measures both, where timing belongs and without failing on load:

- **Identical code near 1:** the A/A control. Every `bench` run times the head against a second copy of itself in a fresh process, in each runtime, reports its interval in the job summary, and calls the run noisy when the interval leaves [0.95, 1.05].
- **A slower operation detected:** the calibration dispatches (`bench-calibrate.yml`, `--slowdown 0.15` and `0.25`), which must catch at least 90 % of runs with a 25 % slowdown before the gate goes on.

So no new report was added. The correctness suite now checks the sampler's logic exactly, on any machine.

## Evidence

| Run | Command (each Vitest run a fresh process) | Before (old sampler and test) | After |
|---|---|---|---|
| New tests against the old sampler | `bunx vitest run packages/tscache/test/perf/gate.test.ts` | 5 of the new tests failed (no clock option; batch of 1 after a stall) | 20 of 20 pass |
| Sequential, every core busy (a `yes` per core) | 40 runs of the test file | 0 of 40 failed | 0 of 40 failed |
| Parallel, every core busy | 15 rounds of 8 concurrent runs of the test file, with a `yes` per core | **48 of 120 failed** (ratios 1.478 and 2.054 against `< 1.4`, 0.629 against `> 0.7`) | **0 of 120 failed** |

The before runs used the old `sample.ts` and the old test from a3926ca, copied beside the new ones for the stress run and deleted afterwards. Plain CPU load alone did not reproduce the flake, consistent with step 22's 28 clean runs; it needs contention like the failing rounds had, several processes competing at once. The stress scripts ran under the machine's heavy-job lock.

A real-clock sanity run of the new sampler (`bun` on the old test's loop, 20 rounds, 40 ms batches, idle machine): same operation 0.999, doubled operation 1.819.

`tsc -p packages/tscache`, `tsc -p .`, Knip and Biome clean. The first `bun run ci` failed at Knip on an exported `Clock` type nothing imported; it is module-local now, folded into the fix commit so every commit stays green. `bun run ci` on this file's commit: see the report.

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | The calibration-stall tests never inject their stall: the virtual clock counts calls across both operations, calibration times base three times before head, so a stall on call 2 never fires, and calibrating from the slowest timing passes too | accepted | Validated: with calibration taking the slowest of three timings, all 20 tests passed. Fixed in d0f05e4: each operation counts its own calls, the stall is on the head's first call, and every stall test asserts `stalls() === 1`. The stalled-round test counted globally too and now counts the head's own calls (its stall did fire before, as its ratio check showed). The alternation test reads the global call log on purpose. Now both the slowest-of-three and the one-timing mutations fail the two calibration-stall tests (sync and async); 20 of 20 pass unmutated |

## Contract-test changes

None. The replaced tests were implementer tests of the bench, not contract tests.

## Decision concerns

None. The sampler's API gains an optional `clock`; the bench is internal and not part of the published package.
