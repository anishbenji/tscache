# Step 97 — The end-to-end bench runs again

Branch: `fix/97-bench-e2e-reload` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: settled · Verdict after triage: merge

## Scope

The `bench` job's end-to-end step (`bun scripts/bench.ts e2e --base "$CI_BASE"`) had failed on every `main` push since 2026-11-02 (97c7ab6), once persistence had merged and became the base. The `reload-first-read` scenario expected the base revision to persist nothing and to fetch the bars a second time on reload. A base from `main` persists, loads the bars from IndexedDB and fetches once, so the driver threw `reload-first-read base: the bars were fetched [1] times, expected 2`. The step is `continue-on-error`, so the job stayed green, but the throw aborted every later scenario and no `e2e.json` reached the `bench-results` artifact.

| Commit (by subject)                                                      | What                                                                                                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fix(bench): judge reload-first-read by each revision's persistence`     | The capability check, the per-scenario failure isolation, `docs/benchmarking.md`, the page comment.                                                        |
| `docs(review): step 97, the end-to-end bench runs again`                 | This file and its `docs/INDEX.md` size row.                                                                                                                |
| `fix(bench): test the e2e failure isolation; a browser context per side` | Pre-review P1-1, P1-2 and P1-4: `runEach` extracted and tested with `persists` (`scripts/bench-e2e.test.ts`); an IndexedDB per side; the log line's units. |
| `docs(bench): describe reload-first-read; step 97 pre-review triage`     | Pre-review P1-3 and P1-5: `docs/benchmarking.md`, this file, the `docs/INDEX.md` rows.                                                                     |

- **The check that was wrong.** `reloadReads` (`scripts/bench-e2e.ts`) keyed its expectation on the side's name: the head one fetch (the setup's), the base two. That encoded "the base is from before persistence", which held only while persistence was the pull request under test. It now keys on what the side's revision does: `persists(src)` is true when the revision's package `src` has `src/persist`, the directory that merged to `main` together with the SharedWorker's persistence wiring (302cd65). A side that persists must fetch once, and the driver waits until IndexedDB holds the setup's pages before the reload; a side from before persistence must fetch twice. The check is stricter than before, not weaker: a base from `main` is now held to one fetch, as the head is, where before no base was ever checked to load from IndexedDB. A base is always a commit of `main` (a pull request's base or a push's `before`), so the persistence branch's intermediate commits, which had the directory before the wiring, never serve as one.
- **One failure no longer aborts the rest.** `runE2e` runs the selected scenarios through `runEach`, which runs each in its own `try`, logs one line per scenario as it finishes (its timings, or its value in the smoke), logs a failed scenario's error, and after the last scenario throws an `AggregateError` with every failure. A wrong result or a fetch too many still fails the run, in the paired run and in the `bun run ci` smoke alike; only the scenarios after it now run too, and their timings are in the log.
- **What needs a protected path.** With a failure, `scripts/bench.ts` still writes no `e2e.json`, since `runE2e` throws before it returns the results. Keeping the passing scenarios' results in the artifact needs `scripts/bench.ts` (a protected path) to take them with the failures, for example from a `{ results, failures }` return value: write `e2e.json` and the summary with the passing scenarios and a "failed" list, then exit 1. That change is not made here.
- Every other scenario's checks are unchanged. `scripts/bench.ts`, the workflows and `packages/tscache/src` are unchanged; no dependency is added.

## Verification

All heavy runs went through `~/code/tscache-reports/bin/heavy-run.sh`, on the Apple Silicon Mac, 2026-11-14, while other children's jobs ran between them.

**Reproduced before the fix** (head 98b7bbf, base `main`): `bun scripts/bench.ts e2e --base main` exited 1 after `fast-scroll` with `error: reload-first-read base: the bars were fetched [1] times, expected 2` at `scripts/bench-e2e.ts:363`; no later scenario ran.

**After the fix, paired against `main`** (`a553b0cb8`, 20 rounds): `bun scripts/bench.ts e2e --base main` exited 0, every scenario reported, and `.bench-results/e2e.json` was written.

| Scenario               |     Base |     Head | Head/base | 95 % CI     |
| ---------------------- | -------: | -------: | --------: | ----------- |
| `fast-scroll`          |  2.45 ms |  2.40 ms |     0.981 | 0.880–1.040 |
| `handshake-first-read` | 34.70 ms | 31.70 ms |     0.968 | 0.759–1.378 |
| `reload-first-read`    | 17.75 ms | 17.70 ms |     0.941 | 0.884–1.023 |
| `read-viewport-shared` |  32.7 µs |  32.4 µs |     0.999 | 0.951–1.086 |
| `two-tabs-one-fetch`   | 598.4 µs | 602.3 µs |     1.023 | 0.967–1.093 |
| `live-tail-get`        |  39.5 µs |  39.1 µs |     1.009 | 0.975–1.031 |

`fast-scroll` served exactly 7,501 bars in its checked run on both sides. The script changes no library code, so head and base run the same engine and every interval holds 1. The first-read times are well above the 7.4–7.5 ms in `docs/benchmarking.md`, which were measured on a quiet machine; here other children's builds and tests ran alongside (report-only, not compared).

**Against a base from before persistence** (`302cd65^1`, `95646960`): `bun scripts/bench.ts e2e --base 302cd65^1 --only reload-first-read` exited 0. The base fetched twice per run and the head once, as the driver checked: base 13.30 ms, head 15.75 ms, 1.202 (1.089–1.275), the IndexedDB load against a loopback fetch, as step 38 measured.

**Failure isolation:** with the head's expected fetch count changed by hand to 3 (a temporary edit, undone before the commit), `bun scripts/bench.ts e2e --smoke` logged `fast-scroll` and `handshake-first-read` as passing, then `e2e reload-first-read failed: … the bars were fetched [1] times, expected 3`, then still ran and logged `read-viewport-shared`, `two-tabs-one-fetch` and `live-tail-get` (1,500 bars each, as expected), and exited 1.

**`bun run ci`**, which includes the e2e smoke (`bun scripts/bench.ts e2e --smoke`): `~/code/tscache-reports/bin/heavy-run.sh "97 child: ci" bun run ci` exited 0 on `ab8b088` (175 Playwright tests passed; the bench smoke and the six e2e scenarios all `ok`). The same command on the head after the pre-review fixes: see "Pre-review (Fable), not the gate" below.

Not verified: the `bench` job on GitHub Actions itself (the branch is not pushed by this step), and Firefox or Safari (the scenarios run in Chromium only).

## Pre-review (Fable), not the gate

On head `65c7809` (the branch with `origin/main` at `a553b0c` merged in by the director). No P0 or P1; predicted verdict: merge after fixes. Each finding was checked against the code before it was fixed.

| #    | Sev | Finding                                                                                                                                                                                                                                                                          | Decision | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1-1 | P2  | The driver's new branches (failure isolation, `persists() === false`) have no automated run; the CI smoke covers only both sides persisting with no failure, so an edit that swallowed failures would stay green                                                                 | accepted | Validated: the smoke runs one side, the head, which persists, and never fails a scenario. The collect-and-continue loop is now `runEach(names, run, progress)`, and `persists` is exported. `scripts/bench-e2e.test.ts` (written first; it failed with `runEach is not a function` / `persists is not a function` before the extraction) checks that after one scenario fails the later ones still run, that the call rejects with an `AggregateError` naming every failure, that a clean run resolves with every result in order, and `persists` over a temporary directory with and without `persist/`. The test imports the driver module under Vitest; only its functions touch Bun or Playwright. |
| P1-2 | P2  | `reloadReads` shares one BrowserContext, and so one `tscache` IndexedDB, between base and head; a pull request that bumps the database version would upgrade it during the head's first warm-up and lock the base out, failing exactly the pull requests that change persistence | accepted | Validated: both sides' pages are on one origin in one context, so they open the same database, and a lower-version open of an upgraded database is refused (`VersionError`). Each side now has a BrowserContext of its own, so its own IndexedDB; the setup and reload pages of one side still share theirs. Re-run below.                                                                                                                                                                                                                                                                                                                                                                             |
| P1-3 | P2  | `docs/benchmarking.md` names `reload-first-read` under "What fails them" but neither its table nor "How they run" describes it                                                                                                                                                   | accepted | Added the table row (its base time, 10.8–11.4 ms, from the two runs below), a "How they run" bullet (setup page, the wait for IndexedDB, the new worker, the context per side), a note on where its time comes from, and a sentence that a run with a failure still writes no `e2e.json`, which needs `scripts/bench.ts` and is left to the user.                                                                                                                                                                                                                                                                                                                                                      |
| P1-4 | P2  | The per-scenario log line uses `toPrecision(3)`, which prints `1.23e+3 ms` at a second or more                                                                                                                                                                                   | accepted | Validated: `(1234.5).toPrecision(3)` is `"1.23e+3"`. The line now formats with `toFixed` and a unit switch, as `scripts/bench.ts` prints its summaries: `2.45 ms`, `32.7 µs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| P1-5 | nit | Record the `bun run ci` command, exit code and head SHA                                                                                                                                                                                                                          | accepted | Recorded under Verification for `ab8b088`, and below for the final head.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**After the fixes**, on `addbf80` against `main` (`a553b0cb8`), under the lock with no other heavy job running. `bun scripts/bench.ts e2e --base main --only reload-first-read` exited 0: base 10.75 ms, head 11.05 ms, 1.020 (0.962–1.073), every run of each side fetching once. The full run, `bun scripts/bench.ts e2e --base main`, exited 0 with every scenario reporting:

| Scenario               |     Base |     Head | Head/base | 95 % CI     |
| ---------------------- | -------: | -------: | --------: | ----------- |
| `fast-scroll`          |  2.20 ms |  2.30 ms |     0.957 | 0.952–1.038 |
| `handshake-first-read` |  9.40 ms |  9.40 ms |     0.989 | 0.968–1.022 |
| `reload-first-read`    | 11.35 ms | 11.50 ms |     1.005 | 0.959–1.087 |
| `read-viewport-shared` |  23.2 µs |  22.6 µs |     0.993 | 0.978–1.019 |
| `two-tabs-one-fetch`   | 342.6 µs | 343.4 µs |     1.004 | 0.978–1.016 |
| `live-tail-get`        |  26.9 µs |  26.5 µs |     0.996 | 0.976–1.014 |

Every interval holds 1, as it should with no library change. `bunx vitest run scripts/bench-e2e.test.ts`: 4 passed; `bun scripts/test-clocks.ts`: clean. `bun run ci` on the final head (the commit that adds this text, so its SHA is in the hand-over report): `~/code/tscache-reports/bin/heavy-run.sh "97 child: ci" bun run ci`.

## Contract-test changes

None.

## Decision concerns

None.

## Security lane (Claude), not the gate

run 1, head fe5c753: P0 0, P1 0, P2 0

`bun run ci` exit 0 on `fe5c753` (175 Playwright; bench and e2e smoke ok).

## Round 1 (GPT-6.1 Sol, high), head 55af7be

No findings; verdict merge. The pre-review fixes were checked as fixed. `bun run ci` exit 0 on that head (run
by the round). Settled.
