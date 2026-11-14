# Step 97 — The end-to-end bench runs again

Branch: `fix/97-bench-e2e-reload` · Reviewer: none yet (the director runs the review) · Rounds: 0 · Status: built, awaiting review · Verdict after triage: —

## Scope

The `bench` job's end-to-end step (`bun scripts/bench.ts e2e --base "$CI_BASE"`) had failed on every `main` push since 2026-11-02 (97c7ab6), once persistence had merged and became the base. The `reload-first-read` scenario expected the base revision to persist nothing and to fetch the bars a second time on reload. A base from `main` persists, loads the bars from IndexedDB and fetches once, so the driver threw `reload-first-read base: the bars were fetched [1] times, expected 2`. The step is `continue-on-error`, so the job stayed green, but the throw aborted every later scenario and no `e2e.json` reached the `bench-results` artifact.

| Commit (by subject)                                                  | What                                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `fix(bench): judge reload-first-read by each revision's persistence` | The capability check, the per-scenario failure isolation, `docs/benchmarking.md`, the page comment. |
| `docs(review): step 97, the end-to-end bench runs again`             | This file and its `docs/INDEX.md` size row.                                                         |

- **The check that was wrong.** `reloadReads` (`scripts/bench-e2e.ts`) keyed its expectation on the side's name: the head one fetch (the setup's), the base two. That encoded "the base is from before persistence", which held only while persistence was the pull request under test. It now keys on what the side's revision does: `persists(src)` is true when the revision's package `src` has `src/persist`, the directory that merged to `main` together with the SharedWorker's persistence wiring (302cd65). A side that persists must fetch once, and the driver waits until IndexedDB holds the setup's pages before the reload; a side from before persistence must fetch twice. The check is stricter than before, not weaker: a base from `main` is now held to one fetch, as the head is, where before no base was ever checked to load from IndexedDB. A base is always a commit of `main` (a pull request's base or a push's `before`), so the persistence branch's intermediate commits, which had the directory before the wiring, never serve as one.
- **One failure no longer aborts the rest.** `runE2e` runs each selected scenario in its own `try`, logs one line per scenario as it finishes (its timings, or its value in the smoke), logs a failed scenario's error, and after the last scenario throws an `AggregateError` with every failure. A wrong result or a fetch too many still fails the run, in the paired run and in the `bun run ci` smoke alike; only the scenarios after it now run too, and their timings are in the log.
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

**Final head:** `bun run ci`, which includes the e2e smoke (`bun scripts/bench.ts e2e --smoke`), run under the lock on the branch's final head; its result is in the hand-over report to the director.

Not verified: the `bench` job on GitHub Actions itself (the branch is not pushed by this step), and Firefox or Safari (the scenarios run in Chromium only).

## Contract-test changes

None.

## Decision concerns

None.
