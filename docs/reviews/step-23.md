# Chore 23 — Chromium end-to-end benchmark scenarios

Branch: `chore/23-bench-e2e` · Reviewer: Codex (high) · Status: in review

The third "Next" item of the performance work (`docs/benchmarking.md`; roadmap, "Performance measurement and gate"): Chromium scenarios through a real SharedWorker, report-only. Chosen by Claude while the user was away, under the user's grant of 2026-10-30 to pick tasks by priority; built by a Claude Opus 5.5 subagent, reviewed and triaged by the orchestrator. Tooling, not a commit-plan step: no engine code changes.

## Scope

| Commit | What |
|---|---|
| 39e20e5 | `refactor(bench)`: `summarise()` pulled out of `sample()`, and `sampleAsync()` added, with tests; `publish()` takes a file name; the smoke output printing is shared |
| 2ad46aa | `chore(bench)`: `bun scripts/bench.ts e2e [--smoke]` and `bench:e2e`: three scenarios (`handshake-first-read`, `read-viewport-shared`, `two-tabs-one-fetch`), each checking its result and the backend's fetch count; the smoke run in `bun run ci`; Knip and Fallow entries |
| b86b867 | `ci(bench)`: a report-only step in the `bench` job (`continue-on-error`) |
| 1d88630 | `docs(bench)`: method, measurements and commands in `docs/benchmarking.md`; the roadmap line |
| 65c8823 | `ci(bench)`: R1-1 |

## Decisions made in the step

Taken by the subagent and accepted by the orchestrator under the grant (logged for the user).

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | Paired against the base, like the other cases | Practical after all: one page loads both versions' clients for the in-page scenarios, and the first-read scenario alternates fresh pages between base and head | Head-only timings |
| D2 | A separate `e2e` command with `--smoke`, plus `bench:e2e` | Its options differ (no runtime, slowdown or gate) | `compare --e2e`; an extra runtime name |
| D3 | An in-process Bun server on a random port, reusing `scripts/e2e-backend.ts` and `e2e/pages/fetcher.js` | No fixed port to collide with a concurrent Playwright run | `scripts/e2e-server.ts` (fixed port, serves only the built `dist/`) |
| D4 | Each version bundled by Bun from source | The base comes from `git archive`, like the other cases | Building the base with tsdown |
| D5 | The two tabs start each other with a `BroadcastChannel` message, which the timing includes; the second tab may join the fetch in flight or find the result cached, and either way exactly one fetch is asserted | Holding the fetch open at the backend would put control requests inside the timing; `e2e/dedup.spec.ts` already proves the join | Holding the fetch at the backend |
| D6 | No A/A control and no confirming run | Nothing gates on these timings, and two scenarios include a loopback fetch | The compare gate's controls |
| D7 | `continue-on-error: true` on the CI step; a wrong result fails the `ci` job's smoke run instead | The `bench` job is to become a required check, and these timings never gate | Failing the `bench` job |

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | A revision whose `get()` never resolves leaves `page.evaluate()` waiting until the job's 15-minute limit, so the whole `bench` job fails despite `continue-on-error` | Accept. Valid: a job timeout is not a step failure, so `continue-on-error` does not apply | 65c8823 gives the step `timeout-minutes: 3` (a normal run takes about ten seconds locally; the whole `bench` job took about two minutes on #42) |

Rebased onto `main` after #43 (step 22) merged: the docs' "Next" lists conflicted and keep step 22's lines. The local results table predates step 22, which made reads faster.
