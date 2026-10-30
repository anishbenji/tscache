# Chore 28 — Test reliability

Branch: `chore/28-test-reliability` · Reviewer: Codex (high) · Rounds: 4 · Status: settled · Verdict after triage: merge

The user's priority request of 2026-10-30: fix every flaky test at its root and change how tests are written so flakes cannot come back. Two flakes have branches of their own, kept independent of this one: fix 31 (reads ending mid-bar in the reference clients) and fix 32 (the sampler's timing test). Done by a child agent while the user was away, under the user's grant of 2026-10-30.

## Inventory

Failures not tied to a diff, from `docs/reviews/` and from stress runs of the whole suites at a3926ca, classified by root cause.

| Flake | Seen | Cause | Class | Fixed in |
|---|---|---|---|---|
| Sampler same-operation ratio in `perf/gate.test.ts` (1.655 against `< 1.4`) | step 22 R3-1, fix 26 pre-push; baseline stress 5 + 2 of 20 | timing measured in the correctness suite, batches undersized after one stalled calibration timing | timing ratio | fix 32 |
| Polling fetch of 180 000 ms in the reference spec | step 22 R2-1 | poll ends at `Date.now()`, snapped outward | wall clock (minute) | fix 26 (#45) |
| Server-rendered and catch-up fetches of 180 000 ms in the reference spec | fix 26 follow-up | `readRange` and the catch-up end at `Date.now()` | wall clock (minute) | fix 31 |
| Reference server-rendered test: a fetch of almost 12 h | baseline stress: 3 of 3 clients on repeats after the first; fix 31 stress 6 of 15 | the app server's cache outlives tests; after a test bumps the dataset version, the next render meets it mid-read and serves almost nothing | shared state | this branch |
| R1-2 reads the year from the test's clock | found reading the spec | fails from 00:00 to about 06:00 UTC on 1 January, when the opening range starts in December | wall clock (year) | this branch |
| React SSR spec, midnight UTC between the render's clock and the backend's | step 13 R6-2 | two clocks in two processes | wall clock (day) | already at the root in 8f5d15a: expectations come from the page's seeds, and both days are accepted explicitly. Audited here, unchanged (below) |
| `merge-failures` and `merge-property` past Vitest's 5 s | step 05 (chore 19), step 16 | other heavy jobs on the machine (load 20–28, 20- to 40-fold slowdowns); masked by a 20 s timeout | load-sensitive timeout | this branch: timeout back to 5 s, with evidence |
| Sleeps of 5 to 30 ms standing in for "the event arrived" (38 in `orchestrator.test.ts`, 10 in `client.test.ts`, more in rpc, lifetime and integrations), races against 200–300 ms timers, fixed polling budgets | not yet seen failing; found by the new check | a sleep or a bounded count that a busy machine outlasts | ordering race, load-sensitive timeout | this branch |
| Reads settling for 0.5 to 1.5 s in the reference spec (scrolling, uPlot clearing) | not yet seen failing | as above | load-sensitive timeout | this branch |
| Copies of a serial group running side by side under `--repeat-each`, sharing one backend's clock | fix 31 verification | harness: `advanceMs` of one copy moves the other's backend | shared state | documented; `flake-hunt.sh` repeats with one worker |
| Playwright port collisions across checkouts | chore 25 | fixed ports reused across checkouts | shared state | chore 25 (in review), not here |

## Scope

| Commit | What |
|---|---|
| 907587c | `test`: the unit tests wait for conditions, not time. `vi.waitFor` on the observable effect (a fetch started, an event heard, a retry issued); a round trip on the same port as a barrier, with the fetcher counting settled fetches; a promise gate instead of a 60 ms timer for the slow module import, and an init listener so the joining tab is known to have arrived; a plain `await` instead of racing a get against a timer (a get that waited fails at the test's timeout); fake timers for the mock backend's latency instead of `performance.now()`. Absence checks and zero-delay turns stay, marked |
| 80a8a33 | `chore(test)`: `scripts/flake-hunt.sh` and `.github/workflows/flake-hunt.yml` (manual on a branch's changed or named files, weekly over every test under load; not a required check) |
| 6996ddf | `test(e2e)`: the year nearest the backend's clock, with a test across New Year; the server-rendered test has the server render once first and checks at least the forming bar's fetch; the scrolling and uPlot tests wait for the answer (the bar count moving) instead of sleeping; R3-1 sets the page's clock from the backend's; `retries: 0` explicit; the remaining pauses marked with their reasons |
| b6e0eb4 | `chore(test)`: `scripts/test-clocks.ts` in `bun run ci`: no `Date.now()`, `new Date()`, `performance.now()`, `setTimeout` or `waitForTimeout` in test files without `// clock-ok: <reason>`, and Playwright retries at 0. Its tests run under Vitest |
| 1186866 | `docs`: `docs/testing.md` (clocks, timing, waiting, shared state, retries, finding flakes), four review-checklist items under Tests, pointers in `AGENTS.md` and `docs/workflow.md` |
| ecfa841 | `test`: Vitest back to its default 5 s timeout (below) |
| a260053, 64d5e61, 89eb6cb | Round 1 fixes (R1-1, R1-2, R1-3). The branch was rebased onto 15fa506; R1-1's fix sits before b6e0eb4 so that every commit passes the check |
| ace8183, 312b698 | Round 2 fixes (R2-1, R2-2, and the clock-ok sweep). The branch was rebased onto 86122d1 |
| 2a2d99d, 94887db | Round 3 fixes (R3-1; R3-2 and the restructured flake-hunt input handling) |

## Decisions

- **Absence checks keep a short pause.** A test that shows something does not happen has no condition to wait for. Where a later, ordered event exists, the check relies on it (exact payload checks, port barriers, `clearAll` as a round trip); elsewhere a pause stays, marked `clock-ok`. A slow machine can make such a check pass wrongly, never fail.
- **The 20 s Vitest timeout is removed.** Chore 19's 20 s was the user's decision of 2026-10-23, taken while the cause was unknown. The brief for this chore asked to remove it once the slowness was fixed or shown gone. With every core busy, the slowest test took 1.59 s at a3926ca and 1.55 s on this branch over 20 runs of the whole suite, a third of 5 s, so CPU contention does not produce the 20- to 40-fold slowdowns; those came with other heavy jobs on the machine, which now run one at a time under the shared lock. Recorded for the user to confirm.
- **R6-2 unchanged.** The React SSR spec's day boundary lies between the server render's clock, which no test controls, and the backend's. A test that moved the backend past midnight would leave the app server's shared cache holding a day as final that the real clock still treats as provisional, breaking later tests. The spec already derives the provisional day from the seeds and accepts either day explicitly, so it cannot flake on that boundary.
- **The check is textual.** It reads source lines, not syntax; a clock read hidden in a helper outside the test globs is not seen. The review checklist covers what it misses.
- **Not needed from fix 31 or 32.** Nothing in this branch depends on them, but its stress runs still show the sampler flake until fix 32 merges.

## Evidence

All runs on the shared machine under the heavy-job lock; "load" is a `yes` per core (ten cores) for the whole run. Vitest runs are each a fresh process.

| Run | Command | Before (a3926ca) | After (this branch) |
|---|---|---|---|
| Vitest, whole suite, 20 runs, load | `scripts/flake-hunt.sh -n 20 --load $(git ls-files '*.test.ts')` | sampler 5/20 and 2/20; nothing else | sampler 7/20 and 3/20 (fix 32); nothing else |
| Same, with the default 5 s timeout | same | — | sampler 4/20 and 5/20 (fix 32); no timeout, nothing else; slowest test 1412 ms |
| Playwright, every spec, 3 runs each, load | `bun run build && scripts/flake-hunt.sh -n 3 --load $(git ls-files '*.spec.ts')` | 265 passed, 3 failed (the server-rendered test, each client), 35 did not run (serial mode after a failure) | 306 of 306 passed |
| Playwright, the changed specs, 5 runs each, load | `scripts/flake-hunt.sh -n 5 --load e2e/reference/clients.spec.ts e2e/examples/vanilla-uplot.spec.ts e2e/auth.spec.ts e2e/client.spec.ts` | — | 355 of 355 passed, the server-rendered test on every repeat |
| Playwright, full suite once | `bunx playwright test` | — | 102 passed |
| `bun run ci` | `~/code/tscache-reports/bin/heavy-run.sh … bun run ci` | — | the first run failed in the new check: it read its own test file, whose fixtures hold the patterns (the file was untracked when the check was tried by hand, so `git ls-files` did not list it). The check now skips that one file, folded into the check's commit so every commit stays green; passed on this file's commit (see the report) |
| Slowest Vitest test over 20 loaded runs | from the JSON reports | 1589 ms (`merge-failures`, "keeps the points outside the authority") | 1553 ms |

Mutation checks: with the orchestrator's joining-context update removed, five orchestrator tests fail, the gated-import test among them; with its wait for the first import removed, the first-import test fails. With the 20 s timeout gone, a test that never settles fails at 5 s.

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | The clock check fails every CI run: `dev-warnings.test.ts` (#49, merged after this branch was built) sleeps 10 ms for an event | accepted | Reproduced: `bun scripts/test-clocks.ts` exited 1 on the rebased tree with that one finding. Fixed in a260053: the four waits for a `mergeWarning` event wait for the event (`vi.waitFor`), and the production-build fetch test listens for its event too, so "nothing printed" is checked once the warning was reported. The check is clean over all 100 test files. The commit sits before b6e0eb4, which turns the check on, so no commit fails it |
| R1-2 | P1 | The dedup test passes with deduplication broken: nothing kept b's get from arriving after a's released fetch had filled the cache | accepted | Validated: with the orchestrator's in-flight join disabled, the test passed. Fixed in 64d5e61: `barrier(b)` before the release, so the server has taken b's get while a's fetch is stalled, and the test checks that one fetch is out at that point. With the join disabled it now fails ("got 2"); unmutated, the file passes 3 of 3. It was the one sleep replaced by nothing in 907587c; the others became waits on an observable effect |
| R1-3 | P1 | `flake-hunt.sh` with a mistyped base reports "no test files changed" and exits 0 | accepted | Reproduced by the new `scripts/flake-hunt.test.sh` (exit 0, "no test files changed since no-such-branch-x"). Fixed in 89eb6cb: the base is verified with `git rev-parse --verify` and the changed files listed by checked commands before the loop; an unknown base exits 1 naming it. The test covers that and the no-changes case, and runs in `scripts/ci.sh` |

## Round 2 — reviewer verdict: merge after fixes

R1-1 to R1-3 confirmed fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P1 | `flake-hunt.sh` given a mistyped test file selects nothing, and Vitest's `passWithNoTests` passes every run of nothing | accepted | Reproduced by two new cases in `scripts/flake-hunt.test.sh`: a missing file and an existing `.test.ts` outside Vitest's include globs both exited 0 with "0 failures". Fixed in 312b698: files given by hand must exist (exit 1 naming the file), and a Vitest run whose JSON report counts no test fails the hunt ("ran no tests"). Playwright already fails when it finds no test. All four cases of the script's test pass; a real file still hunts normally |
| R2-2 | P1 | The abandoned-handshake test in `client.test.ts` relied on a 60 ms attach timer expiring after a 20 ms handshake timeout; a pause over 40 ms between scheduling them reverses the order, and its `clock-ok` reason said it could not | accepted | Reproduced: a 100 ms busy pause injected in the fake worker's constructor, after scheduling the attach, failed the old test (an init was sent). Fixed in ace8183: the fake worker attaches only when the test calls it, after `make()` has fallen back, so the hello is late by construction. With the same pause injected the new test passes; with the client no longer closing the abandoned port it still fails |
| — | — | Sweep of every `clock-ok` reason for the same class (a reason resting on timer order, not on something the test controls) | done in ace8183 | `e2e/support.ts` `expectWorkerAlive` raced the worker's answer against a 5 s guard, which a slow enough machine could lose: the guard is now three quarters of the test's own time limit, so it fires no sooner than the test's timeout would. The fake worker's zero-delay error timer in `client.test.ts` is queued before the client's longer handshake timer, so no pause can reorder them: sound, its reason now says why. The rest hold: zero-delay turns that only drain microtasks (`lifetime`, `rpc`, `connection`, the refresh harness), equal zero timers that run in the order queued (`e2e/support.ts` mode fallback), absence checks a slow machine can only make pass, and elapsed time used as an upper bound in the polling spec |

## Round 3 — reviewer verdict: merge after fixes

R1-1 to R2-2 confirmed fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | `expectWorkerAlive`'s guard is three quarters of the test's limit measured from the call, so a call at 1 s of a 30 s test gives up at 23.5 s and a worker answering at 24 s fails; round 2's claim that it fires no sooner than the test timeout was wrong | accepted | Validated by the arithmetic: the guard starts at the call, the test's limit at the test's start. Fixed in 2a2d99d: no guard; the cache-only get runs in a named `test.step`, and a dead worker ends at the test's own timeout, which reports the step. Swept every e2e `clock-ok` line for a guard racing a deadline: none left (the rest are absence pauses, a zero-delay turn, equal zero timers in queue order, and an elapsed upper bound) |
| R3-2 | P1 | `flake-hunt.sh -n 0` skips every run, prints "0 failures in 0 runs" and exits 0 | accepted | Reproduced on 312b698: counts of `0`, `-1` and `abc`, and a non-test file (`README.md`), all exited 0. Fixed in 94887db with the restructuring below |
| — | — | **Convergence check (docs/workflow.md, step 7) fired on flake-hunt's input handling**: R1-3 (unknown base), R2-1 (mistyped file) and R3-2 (zero count) | restructured, not patched | 94887db: every input is parsed and validated before anything runs, exiting 1 with a message naming the bad input (run and worker counts are positive integers, every option has its value, unknown options are refused, the base resolves, files, `--base` and `--all` exclude each other, every file exists and is a `.test.ts` or `.spec.ts`), and a final invariant fails any hunt that executed no test, whatever path led there (Vitest reports and Playwright's summary are counted; "no changed test files" now fails too). `scripts/flake-hunt.test.sh` has 15 cases: zero, negative, non-numeric and missing counts; zero and non-numeric worker counts; an unknown base; base with files and with `--all`; a missing file; a non-test file; an unknown option; nothing to hunt in; a file that executes no test; and a real file that passes. All 15 pass |

## Contract-test changes

None weakened. `orchestrator.test.ts` and `client.test.ts` are implementer tests; their sleeps became waits for the same conditions, and every assertion stays.

## Decision concerns

None from a reviewer yet. For the user: the removal of chore 19's 20 s timeout above.

## User decision (2026-10-30)

The user approved returning Vitest to its 5 s default timeout, replacing chore 19's 20 s mask (the user's decision of 2026-10-23).

## Round 4 — reviewer verdict: merge

No findings; all seven accepted findings from rounds 1–3 confirmed fixed; clock check 100 files clean. `bun run ci` passed. Settled.
