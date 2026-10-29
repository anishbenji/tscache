# Step 22 — Fast path in `DenseSegment.slice`

Branch: `feat/22-slice-fast-path` · Reviewer: Codex (high) · Rounds: 4 · Status: settled · Verdict after triage: merge

The first optimisation the benchmarks pointed at (`docs/benchmarking.md`, "Next" item 2; roadmap, "Performance measurement and gate"). Chosen by Claude while the user was away, under the user's grant of 2026-10-30 to pick tasks by priority. No API or contract change: `Segment.slice` keeps its contract (architecture §4.2), and the new tests pass on the old implementation too.

## Scope

| Commit | What |
|---|---|
| 4e007b1 | `perf(segment)`: `slice` counts the present slots first (free when the segment has no gap: a tight extent holding as many points as it spans has every slot set), allocates each result once, and copies a fully present span with one `TypedArray.prototype.slice` per column; a span with gaps fills the preallocated arrays. Tests: reads over a fully present segment whose buffers start before its extent, runs separated by gaps, a segment made whole again, random runs against a set model, and every result owning a buffer of exactly its size. Docs: benchmarking "Next" item 2 and the roadmap line |
| 0d73d78 | `refactor(segment)`: R1-1 |

## Measurements

`bun scripts/bench.ts compare --base main --runtime bun,chromium`, head/base median (A/A control within 0.98–1.03):

| Case | Bun | Chromium |
|---|---:|---:|
| `read-viewport` | 0.150 | 0.590 |
| `read-viewport-sessions` | 0.151 | 0.716 |
| `read-year` | 0.097 | 0.526 |
| `snapshot-roundtrip` | 0.748 | 0.972 |

Mutation checks: copying with `subarray` instead of `slice` fails 10 tests (the buffer-ownership check); treating every segment as gap-free fails 14.

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | `bun run ci` fails: the rewritten `slice` exceeds Fallow's CRAP threshold (37.1) | Accept. Valid: the pre-commit hook does not run Fallow, and CI was not run before the commit | 0d73d78 splits it into `#copySpan` and `#gather`; `FALLOW_AUDIT_BASE=main bun run fallow` clean, tests and measurements unchanged |

## Round 2 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P1 | `bun run ci` failed in Playwright: a vanilla polling fetch spanned 180 000 ms against the 120 000 ms bound (`e2e/reference/clients.spec.ts:556`); the reviewer notes the evidence does not tie it to this change | Accept that CI must pass; reject a code cause. The step touches no reference or polling code, and the test passed 5 of 5 alone (`--repeat-each 5`). Locally, Playwright's servers use fixed ports with `reuseExistingServer`, and a second checkout ran its own `bun run ci` at the same time, so the two runs could share the e2e servers and the mock backend's state | Round 3 reruns the full CI with no other checkout running it. Recorded as a tooling follow-up: concurrent local CI runs in two worktrees collide on the Playwright ports |

## Round 3 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | `bun run ci` failed in Vitest: the sampler's same-operation check in `perf/gate.test.ts` measured a ratio of 1.655 against `< 1.4`; the reviewer notes it does not establish a regression from this change | Accept that CI must pass; reject a code cause. The test times a synthetic loop, not the engine, and predates this step. It did not fail in 28 local runs: 8 of the package's tests, 8 of the whole suite, and 6 of each with every core saturated by `yes`. The failing round ran while another checkout's agent was building and benchmarking on the same machine; R2-1 had the same cause | Round 4 reruns CI on an idle machine. Both rounds point at one area, concurrent heavy work on one machine, so the durable fix is procedural: no review round runs while another checkout runs CI or benchmarks (backlog item 9 also covers the Playwright ports) |

## Round 4 — reviewer verdict: merge

No findings. `bun run ci` passed on an idle machine.

## Verification

- `bun run ci` passed in round 4 (host run supplied to the reviewer).
- `bunx vitest run packages/tscache/test/dense-segment.test.ts`: 98 passed; the two mutation checks above fail it.
- Benchmarks re-run after R1-1: `read-viewport` 0.145 in Bun and 0.596 in Chromium; `read-viewport-sessions` 0.154 and 0.716.
- Not verified: the timings on GitHub's runner (the `bench` job reports them on this pull request).

## Correction (chore 25, 2026-10-30)

The R2-1 and R3-1 triage blamed a second checkout's concurrent `bun run ci`, through Playwright's shared fixed ports for R2-1. Chore 25 gave each checkout its own ports and then ran the reference suite in three checkouts at once: the same polling assertion failed in two of the three, each on its own ports. The ports were not the cause of R2-1. The test is sensitive to machine load (it passes alone), and its root cause is under investigation on its own branch. The conclusion that this step did not cause it stands: the step changes no reference or polling code, and `main` fails the same way.
