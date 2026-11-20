# Step 126 — a test timeout for the mutation run only

Branch: `chore/126-mutation-test-timeout` · Reviewers: pre-review 1 (Fable), security lane 1 (Opus); the Codex gate not yet run · Status: pre-review 1 triaged, awaiting the gate

## Scope

- `vitest.mutation.config.ts`, the Vitest configuration Stryker runs, sets `testTimeout` and `hookTimeout` to 60 s, with a comment giving the reason and the one case where Vitest's limit is still the lower one.
- `docs/benchmarks/mutation.md`, "How to re-run": the observed run time and how to start a full run detached, and one paragraph on the raised timeouts, their exception and their effect on the split between killed and timed-out mutants. Its `docs/INDEX.md` row is re-measured.
- `AGENTS.md`, Toolchain hard rules: the mutation run's time (about 3 hours, run detached or one area at a time), and the tsup sentence corrected (a fact fix from step 128, below). `AGENTS.md` is not a protected path, and this is a `chore/` branch.
- **Not changed.** `vitest.config.ts`, CI, the git hooks, `bun run test`, `stryker.config.json` and every test file. No History row is added to `docs/benchmarks/mutation.md`; step 124 adds it on `main` after this step merges.

## Reason

Step 124 found that Stryker's initial test run failed on `main`. The test "a month of each of 50 series through an 8 MB budget stays at or under it once each read is done" (`packages/tscache/test/perf/memory-budget.test.ts`, step 121) takes about 300 ms under plain Vitest. Under Stryker's per-test coverage instrumentation (`coverageAnalysis: "perTest"`) it takes 4.5 s or more, over Vitest's default 5 s `testTimeout` once six runners share the machine.

A Vitest timeout fails the test, so during a mutant run Stryker counts that mutant as killed. Stryker has its own per-mutant timeout, `timeoutFactor × netTime + timeoutMS + overhead` (`@stryker-mutator/core`, `dist/src/mutants/mutant-test-planner.js:124`; defaults 1.5 and 5000 ms), where `netTime` is the covering tests' time in the initial run, and it reports a mutant that exceeds it as `Timeout`. So the Vitest timeout should not be the limit under Stryker. With 60 s it is not, for most mutants. The exception is a mutant whose covering tests took more than about 27.7 s together, because then Stryker's limit exceeds 60 s. A static mutant (`ignoreStatic` is off) runs every test: with this run's 97.6 s net and 13.4 s overhead its limit is about 165 s, so an asynchronous hang there still fails on Vitest's 60 s and is reported as killed.

Both timeouts are raised because many of the suite's hooks run mutated code. At least twelve `afterEach` hooks await `dispose()` or `close()` on the test's clients or orchestrators, which runs client, orchestrator and engine teardown: `orchestrator-misses.test.ts:13`, `orchestrator-subtraction.test.ts:22`, `orchestrator.test.ts:109`, `client.test.ts:125`, `client-lazy-hosting.test.ts:84`, `dev-warnings.test.ts:74`, `snapshot-wiring.test.ts:42`, `m7-change-rpc.test.ts:105`, `m3-memory-client.test.ts:23`, `perf/persist.test.ts:160`, `perf/memory-budget.test.ts:98` and `perf/counters.test.ts:120`. A mutant could make one of these hooks time out just as it makes a test time out. Vitest's defaults are 5 s per test and 10 s per hook.

**Decision applied.** User decision 90 (2026-11-20) confirmed option A of the step 124 report: raise the timeout in `vitest.mutation.config.ts` only. This is the user's exception to the rule against raising a timeout (child rule 6), scoped to that file: `vitest.config.ts`, CI and the hooks keep Vitest's defaults, and no test changes. It is not a flake fix. The decision names `testTimeout`; the brief allows `hookTimeout` too "if the same reasoning applies", and the hooks above are why it does.

## Runner check

`@stryker-mutator/vitest-runner` 10.1.1 (`dist/src/vitest-test-runner.js`, `init()`) calls `createVitest('test', { config: <vitest.configFile>, … })`. It overrides only the pool settings, `coverage`, `includeTaskLocation`, `maxConcurrency`, `watch`, `dir`, `bail` and `onConsoleLog`. It never sets `testTimeout` or `hookTimeout`, and no other runner source mentions either. So the values in `vitest.mutation.config.ts` apply to the dry run and to every mutant run. The package ships no README; the source is the documentation checked.

## Run evidence

`~/code/tscache-reports/bin/heavy-run.sh "126 child: stryker" bun run mutation`, on the commit that adds the configuration (`ebb7172`, `main` at `4507d6a` plus this step). The lock was taken at 2026-11-20T18:28:24Z, after a wait for another job.

- **Initial test run: passed.** "Initial test run succeeded. Ran 2586 tests in 1 minute and 51 seconds (net 97586 ms, overhead 13430 ms)." 29 files were instrumented with 5,027 mutants (4,559 in the step 119 run; step 121 added the rest).
- **Mutant runs: not finished.** The Bash tool stops a background command after two hours, its maximum, and it stopped this run at 1 h 53 m of mutation testing. The last progress line was "Mutation testing 63% (elapsed: ~1h 53m, remaining: ~1h 4m) 4077/5027 tested (403 survived, 325 timed out)". Stryker had written no report yet, so there are no final totals (killed, no coverage, score) to record. The run was not restarted, because a restart would hit the same limit. The director runs the full run detached after merge.
- **Run time and timeouts.** At 81 % of the mutants tested, the run had already recorded 325 timeouts, against 193 for the whole step 119 run, and Stryker projected about 3 hours in total, against 81 minutes then. The load average was about 7 at the end. A likely cause, not verified, is that mutants that hang asynchronously used to be stopped by Vitest's 5 s timeout and reported as killed; they now run until Stryker's per-mutant timeout, and each Stryker timeout also restarts a test runner process. Such a mutant counts toward the score either way, so the score should change little, but the run time grows and the killed/timed-out split shifts. `docs/benchmarks/mutation.md` now says so, so that step 124's row is not read as a regression.

## Pre-review 1 (Fable), not the gate — no P0 or P1

Run on head `fb1376b`. Report: `tscache-reports/reviews/step-126/pre-review-1.md`.

| #     | Sev | Finding                                                                                                                                       | Decision | Resolution                                                                                                                                                                                                                                                                            |
| ----- | --- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR1-1 | P2  | `docs/benchmarks/mutation.md:114` and `AGENTS.md:34` still say a full run takes about 40 minutes; this step's evidence projects about 3 hours | accepted | Both give the observed figure (4,077 of 5,027 mutants in 1 h 53 m, about 3 hours projected) and say to start a full run detached (`detach.sh` plus `heavy-run.sh`) or one area at a time with `--mutate`. The `AGENTS.md` line keeps its shape                                        |
| PR1-2 | P2  | The review file said only one hook runs mutated code; at least eleven other `afterEach` hooks await `dispose()` or `close()`                  | accepted | Checked each listed line; all twelve hooks are now named under Reason. The conclusion (raise `hookTimeout` too) stands                                                                                                                                                                |
| PR1-3 | P2  | "Only Stryker's own timeout applies" is false for static or widely covered mutants, whose Stryker timeout exceeds 60 s (static about 165 s)   | accepted | Checked against `mutant-test-planner.js:124`. The config comment, `mutation.md` and this file say "for most mutants" and name the exception (covering tests over about 27.7 s, such as a static mutant). `mutation.md` adds that the killed/timed-out split depends on these timeouts |
| PR1-4 | P2  | Vitest's default `hookTimeout` is 10 s, not 5 s                                                                                               | accepted | Checked in Vitest (`hookTimeout ??= 1e4`). The config comment and `mutation.md` give both defaults: 5 s per test, 10 s per hook                                                                                                                                                       |
| note  | —   | Decision 90 names `testTimeout`; the branch also raises `hookTimeout`                                                                         | noted    | The brief allows `hookTimeout` when the same reasoning applies; Reason gives the hooks that make it apply                                                                                                                                                                             |

## Security lane 1 (Opus)

Run on head `fb1376b`. Report: `tscache-reports/reviews/step-126/security-1.md`. No findings: the change is a Stryker-only configuration and documentation; nothing shipped changes, and no dependency or workflow is touched.

## Fact fix from step 128

`AGENTS.md` said "**tsup is EOL — do not use.**". Step 128 found that inaccurate: tsup 9.0.0 is npm's `latest` (2026-10-14) and is not deprecated; its README says "This project is not actively maintained anymore" and points to tsdown. The sentence now reads "**tsup is no longer maintained (its README points to tsdown) — do not use.**" The rule itself (do not use tsup) is unchanged.

## Verification

- `bunx vitest run --config vitest.mutation.config.ts packages/tscache/test/perf/memory-budget.test.ts`: 4 tests passed (light check that the configuration loads).
- `bunx tsc --noEmit -p .`: no errors. `bunx biome check vitest.mutation.config.ts`: no fixes.
- The Stryker run above: the initial test run passed; the mutant runs did not finish.
- `~/code/tscache-reports/bin/heavy-run.sh "126 child: ci" bun run ci` on `fb1376b`: exit 0 (Vitest 156 files, 3,058 tests; Playwright 193 passed; bench smoke ok). The run on the final head is in the child's report.
- `git diff main -- vitest.config.ts` is empty.

## Round 1 (Codex) — reviewer verdict: merge

Head `c5ef24f`. No findings; the reviewer confirmed pre-review 1's four fixes. `bun run ci` exited 0 on `c5ef24f`. The review settles at round 1. The full mutation run is the director's, detached, after merge (step 124).
