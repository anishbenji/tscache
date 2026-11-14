# Step 107 — the e2e bench keeps the passing timings when a scenario fails

Branch: `chore/107-bench-partial-e2e` · Reviewer: GPT-6.1 Sol · Rounds: 0 · Status: awaiting review

## Scope

User decision 69 A (2026-11-15). Since step 97 every end-to-end scenario runs when one fails, and the run then fails: `runEach` in `scripts/bench-e2e.ts` threw an `AggregateError` once all had run. `scripts/bench.ts` wrote `e2e.json` and the summary only after `runE2e` returned, so a failed scenario cost the `bench-results` artifact the timings of every scenario that passed; they survived only in the log.

This step makes `runE2e` return `{ results, failures }` instead of throwing. A paired run writes `e2e.json` and `e2e-summary.md` with the passing scenarios and a `failed` list (scenario and message), then exits 1. The smoke (`bun scripts/bench.ts e2e --smoke`, part of `bun run ci`) checks every result that came back and exits 1 on a wrong result or on any failed scenario, so a failure can never be lost. A failure before the scenarios start (a bundle that does not build, a browser that does not launch) still throws, as before.

`scripts/bench.ts` is a protected path: the user merges this pull request. `scripts/bench-e2e.ts` is on the Notify list.

| Commit (by subject)                                           | What                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `chore(bench): keep the passing e2e timings when one fails`   | `runEach`/`runE2e` return the outcome; `bench.ts` writes it and exits 1; tests; `docs/benchmarking.md`. |
| `docs(review): step 107, the e2e bench keeps passing timings` | This file and its `docs/INDEX.md` row.                                                                  |

## The change

- `scripts/bench-e2e.ts`: `runEach` returns `{ results, failures }`, each failure `{ scenario, message }` (a thrown non-`Error` keeps `String(error)` as its message, as before). `failureSummary` renders the line the `AggregateError` carried, `2 of 5 e2e scenarios failed: b: b broke; d: d broke`. The progress callbacks are unchanged: each failure is still logged with its full error as it happens.
- `scripts/bench.ts`: `writeE2e(dir, run)` writes both files and returns the summary and the exit code (1 when any scenario failed); `checkE2e(outcome)` is the smoke's check. The summary gains a `#### Failed` section, only when a scenario failed. `e2e.json` keeps `schema: 1` and gains `failed`, always present (empty when none failed): the change only adds a field, and nothing in the repository reads the file. The command dispatch now runs under `if (import.meta.main)`, as in `scripts/test-clocks.ts`, so the tests can import the two functions; `publish` is split into `announce` (console and GitHub job summary) and the write, so the test never touches `GITHUB_STEP_SUMMARY`.
- `docs/benchmarking.md`: the sentence step 97 added ("A run with a failure still writes no `e2e.json` …") now describes the new behaviour, and the `e2e` command's paragraph mentions the `failed` list.

## Tests

Written first and seen failing (`bunx vitest run scripts/bench.test.ts scripts/bench-e2e.test.ts`: `bench.test.ts` failed on import, since `bench.ts` then ran its command dispatch on import and rejected Vitest's arguments, and three `runEach` tests failed), then passing (8 of 8).

- `scripts/bench-e2e.test.ts`: the three `runEach` tests move from the rejected `AggregateError` to the returned outcome. Each keeps its assertions: every scenario runs after one fails, the `done` and `failed` callbacks see the same calls, each failure's message (`b broke`, `d broke`, `not an error`) and the summary line, word for word, are asserted on the outcome and `failureSummary` instead of on the error; the no-failure test also asserts an empty failure list and no summary.
- `scripts/bench.test.ts` (new): `writeE2e` with one passing and one failed scenario writes `e2e.json` holding the passing result and the failure, and `e2e-summary.md` holding the passing row and the failure, and returns exit code 1; with no failure it writes an empty `failed` list and returns 0. `checkE2e` returns 1 when a scenario failed though every returned result checks, 1 on a wrong result, and 0 when all check.

## Verification

Each behaviour was shown on the real scenarios with a temporary edit to `runScenario` in `scripts/bench-e2e.ts` that rejected `reload-first-read` with `TEMPORARY forced failure`, undone before the commit:

| Command (through the heavy-job lock)                                                             | Exit | What it showed                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun scripts/bench.ts e2e --smoke`                                                               | 1    | All six scenarios ran; the five others printed `ok`; the last line was `1 of 6 e2e scenarios failed: reload-first-read: TEMPORARY forced failure`.                                                        |
| `bun scripts/bench.ts e2e --base HEAD --rounds 10 --only handshake-first-read,reload-first-read` | 1    | `.bench-results/e2e.json` held the `handshake-first-read` result and `failed: [{ scenario: "reload-first-read", message: "TEMPORARY forced failure" }]`; the summary its row and a `#### Failed` section. |

Without the edit, `bunx vitest run scripts/bench.test.ts scripts/bench-e2e.test.ts` passes 8 of 8 and `bunx tsc --noEmit -p tsconfig.json` is clean. `bun run ci` runs on the branch head before it is handed to the director.

## Contract-test changes

None: the changed tests are scripts tests, not Codex-authored contract tests.

## Decision concerns

None.
