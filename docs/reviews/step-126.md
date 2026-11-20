# Step 126 — a test timeout for the mutation run only

Branch: `chore/126-mutation-test-timeout` · Reviewers: none yet (the director reviews) · Status: built, awaiting review

## Scope

- `vitest.mutation.config.ts`, the Vitest configuration Stryker runs, sets `testTimeout` and `hookTimeout` to 60 s, with a comment giving the reason.
- `docs/benchmarks/mutation.md`, "How to re-run": one paragraph saying the mutation configuration raises the per-test and per-hook timeouts, and why. Its `docs/INDEX.md` row is re-measured (31.3 KB to 31.8 KB).
- **Not changed.** `vitest.config.ts`, CI, the git hooks, `bun run test`, `stryker.config.json` and every test file. No History row is added to `docs/benchmarks/mutation.md`; step 124 adds it on `main` after this step merges.

## Reason

Step 124 found that Stryker's initial test run failed on `main`. The test "a month of each of 50 series through an 8 MB budget stays at or under it once each read is done" (`packages/tscache/test/perf/memory-budget.test.ts`, step 121) takes about 300 ms under plain Vitest. Under Stryker's per-test coverage instrumentation (`coverageAnalysis: "perTest"`) it takes 4.5 s or more, over Vitest's default 5 s `testTimeout` once six runners share the machine.

A Vitest timeout fails the test, so during a mutant run Stryker counts that mutant as killed. Stryker has its own per-mutant timeout, set from the measured initial run (`timeoutMS`, default 5000, and `timeoutFactor`, default 1.5), and reports a mutant that exceeds it as `Timeout`. So the Vitest timeout should not be the limit under Stryker. Both timeouts are raised because some of the suite's hooks run mutated code: the `afterEach` hook of `client-lazy-hosting.test.ts` disposes the test's clients, which runs client, orchestrator and engine teardown, so a mutant could make a hook time out the same way. The other hooks only install fakes or create and remove temporary directories.

**Decision applied.** User decision 90 (2026-11-20) confirmed option A of the step 124 report: raise the timeout in `vitest.mutation.config.ts` only. This is the user's exception to the rule against raising a timeout (child rule 6), scoped to that file: `vitest.config.ts`, CI and the hooks keep the 5 s default, and no test changes. It is not a flake fix.

## Runner check

`@stryker-mutator/vitest-runner` 10.1.1 (`dist/src/vitest-test-runner.js`, `init()`) calls `createVitest('test', { config: <vitest.configFile>, … })`. It overrides only the pool settings, `coverage`, `includeTaskLocation`, `maxConcurrency`, `watch`, `dir`, `bail` and `onConsoleLog`. It never sets `testTimeout` or `hookTimeout`, and no other runner source mentions either. So the values in `vitest.mutation.config.ts` apply to the dry run and to every mutant run. The package ships no README; the source is the documentation checked.

## Run evidence

`~/code/tscache-reports/bin/heavy-run.sh "126 child: stryker" bun run mutation`, on the commit that adds the configuration (`ebb7172`, `main` at `4507d6a` plus this step). The lock was taken at 2026-11-20T18:28:24Z, after a wait for another job.

- **Initial test run: passed.** "Initial test run succeeded. Ran 2586 tests in 1 minute and 51 seconds (net 97586 ms, overhead 13430 ms)." 29 files were instrumented with 5,027 mutants (4,559 in the step 119 run; step 121 added the rest).
- **Mutant runs: not finished.** The Bash tool stops a background command after two hours, its maximum, and it stopped this run at 1 h 53 m of mutation testing. The last progress line was "Mutation testing 63% (elapsed: ~1h 53m, remaining: ~1h 4m) 4077/5027 tested (403 survived, 325 timed out)". Stryker had written no report yet, so there are no final totals (killed, no coverage, score) to record. The run was not restarted, because a restart would hit the same limit.
- **Observation for the director.** At 81 % of the mutants tested, the run had already recorded 325 timeouts, against 193 for the whole step 119 run, and Stryker projected about 3 hours in total, against 81 minutes then. The load average was about 7 at the end. A likely cause, not verified, is that mutants that hang asynchronously used to be stopped by Vitest's 5 s timeout and reported as killed; they now run until Stryker's per-mutant timeout, and each Stryker timeout also restarts a test runner process. Such a mutant counts toward the score either way, so the score should change little, but the run time grows. A full run now needs to be detached from the agent's shell (or run one area at a time with `--mutate`) to finish.

## Verification

- `bunx vitest run --config vitest.mutation.config.ts packages/tscache/test/perf/memory-budget.test.ts`: 4 tests passed (light check that the configuration loads).
- `bunx tsc --noEmit -p .`: no errors. `bunx biome check vitest.mutation.config.ts`: no fixes.
- The Stryker run above: the initial test run passed; the mutant runs did not finish.
- `~/code/tscache-reports/bin/heavy-run.sh "126 child: ci" bun run ci` on the final head: see the child's report.
- `git diff main -- vitest.config.ts` is empty.
