# Step 36 — One engine read per orchestrated `get`

Branch: `feat/36-orchestrator-one-read` · Reviewer: Codex (high) · Rounds: 1 · Status: round 1 fixed, re-review pending · Verdict after triage: merge after fixes

Item 3 of the performance plan (`~/code/tscache-reports/perf-plan.md` §6), built by a child agent while the user was away. `Orchestrator.get` read the engine, computed the misses from that result, fetched, then read again, so every `get` that fetched read its range twice and threw the first read's columns away. A live chart's every `get` fetches, since its provisional newest bar is never covered (architecture §2.4, the volatile region), so a polling chart paid two full reads per tick.

## Scope

| Commit | What |
|---|---|
| a4bfaca | `perf(orchestrator)`: `get` plans its fetches from `engine.coverage` (the request's uncovered slots, which a read reports as `'uncached'`, from one coverage query that also serves the flank extension) and reads the engine once: after the fetches, or at once when nothing is missing. New exact budget in `test/perf/counters.test.ts`: one `Engine.get` call per orchestrated `get`, counted with a spy, for an opening fetch, a live-tail fetch with `snapshot: true`, a cache hit and a `cacheOnly` get. Docs: architecture §4.9 (orchestrated get) and the budgets table in `docs/benchmarking.md` |
| 09f1b03 | `test(bench)`: the `live-tail-get` end-to-end scenario |
| 41a7fd4 | `docs`: the scenario in `docs/benchmarking.md`, and this file |
| b68b0c6 | `fix(orchestrator)`: R1-1 |
| b0c2657 | `test(bench)`: R1-2 |
| (the round 1 commit) | `docs(review)`: round 1 triage |

## Decisions

- **Behaviour unchanged, by construction.** The read's misses are `CoverageIndex.gaps(request)` (§4.4); the plan now takes the same gaps as the request minus `covered(probe)`, from the same index, at the same moment (no await between). The second pass after a fence drop plans from coverage after the first fetches, as it planned from the read after them before. The final read follows the last fetch with no await in between, so the result, the miss annotation and the snapshot (N36) come from the state they came from before. Unknown caches and malformed ranges throw the same errors from the same functions (`Engine.configOf`, `snapOut`), now before any coverage query rather than from the first read. `cacheOnly` and the no-fetcher path read once, as before.
- **A cache hit costs one coverage query more.** It used to be one read; it is now one coverage query (a binary search over tens of ranges) and one read. A fetching `get` saves a full read and pays the query.
- **The scenario's fetcher answers from memory**, served by the driver as `/tail-fetcher.js`, not through the mock backend. A loopback HTTP fetch takes hundreds of microseconds and would bury a saving of about ten. The plan asks for "a backend that answers at once"; this is the strictest reading. So that the scenario cannot stop fetching unnoticed, the fetcher counts the fetches made for the cache in the volume field, the setup's included, every operation checks that its newest bar carries the next count (R1-2), and the driver checks that the mock backend served nothing.
- **No architecture decision changes.** N2, N29, N31 and N36 hold as written; §4.9 now describes the mechanism (plan from coverage, read once) and names the budget.

## Evidence

- Test first: the budget failed on `origin/main`'s orchestrator (`expected 2 to be 1` at the opening read) and passes after.
- `bunx vitest run packages/tscache/test/orchestrator.test.ts packages/tscache/test/perf/counters.test.ts`: 43 passed, unmodified orchestrator tests included.
- `bunx vitest run` (all): 1,521 of 1,522 passed; the one failure was the sampler's synthetic-loop check in `perf/gate.test.ts` (0.671 against `> 0.7`) at a load average of about 20, which touches no orchestrator code and passed 2 of 3 runs alone. `bun run ci` on the final commit is the gate.
- `bunx tsc -p packages/tscache --noEmit`, `bunx tsc -p . --noEmit`: clean. `FALLOW_AUDIT_BASE=origin/main bun run fallow`: no issues.

Paired end-to-end runs, Chromium, under the heavy-job lock (`bun scripts/bench.ts e2e …`, head `f5ea16a` against `origin/main` `59b8da5`, 30 rounds):

| Scenario | Base | Head | Head/base | 95 % CI |
|---|---:|---:|---:|---|
| `live-tail-get` | 39.2 µs | 30.0 µs | 0.768 | 0.755–0.800 |
| `live-tail-get` (second run) | 38.5 µs | 29.9 µs | 0.777 | 0.755–0.803 |
| `handshake-first-read` | 7.10 ms | 7.10 ms | 0.993 | 0.986–1.000 |
| `read-viewport-shared` | 24.0 µs | 24.1 µs | 1.012 | 1.000–1.039 |
| `two-tabs-one-fetch` | 425.8 µs | 427.0 µs | 1.007 | 0.991–1.020 |

A/A control (`--base HEAD --only live-tail-get --rounds 30`): 30.4 against 30.9 µs, 1.039 [0.991, 1.046]; the interval holds 1. The saving, about 9 µs, is one 1,500-bar read in Chromium, as estimated in the plan. `e2e --smoke` passed for all four scenarios.

The Scope SHAs are after the director's rebase onto `main` at `459556a` (#49, #51, #52); the measurements above were taken before it, against `59b8da5`.

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | Planning subtracts every coverage fragment from every piece left so far: with `[0, 8191]` covered and every odd slot invalidated (4,096 fragments) the change adds synchronous worker latency although it saves a read | accepted | Reproduced, Bun, the synchronous part of one `get` up to its first await (`/tmp/perf36r1/frag.ts`, median of 15): `main` 23.9 ms, round 1 88.9 ms. `coalesce`, unchanged from `main`, was quadratic as well (`coverage.some` per miss). Fixed in b68b0c6: `planFetches` removes coverage and blocked ranges with one cursor sweep each, and `coalesce` finds each miss's neighbours with one cursor. New budget in `test/perf/counters.test.ts`: at most 8 coverage-element reads per range over the 4,096 fragments, without and with 2,048 blocked ranges; measured 28,671 and 26,622, and the round-1 algorithm read 16,789,503 and 20,979,711 (run against it before the fix). New `test/orchestrator-plan.test.ts` checks the plan against a slot-by-slot model of the §4.9 rules on 2,000 random cases; two mutations of the sweeps fail it. After the fix: 0.49 ms and 0.47 ms in two runs, against `main`'s 24.1 and round 1's 89.2 and 92.2 |
| R1-2 | P1 | The setup writes volume 1 and the first operation expects 1, so the e2e smoke, which runs one operation, passes when the get fetches nothing | accepted | Reproduced: with the operation's get made `cacheOnly`, the round-1 page passed `e2e --smoke --only live-tail-get`. Fixed in b0c2657: the tail fetcher counts fetches per cache, the setup's included, so the first operation must see 2. The same `cacheOnly` mutation now fails the smoke (`newest bar fetched 1 times (expected 2)`); unmutated, the smoke passes for all four scenarios |

Measurements after the fixes, under the heavy-job lock (`bun scripts/bench.ts e2e --only live-tail-get --rounds 30`, Chromium, head `b0c2657`):

| Base | Base time | Head time | Head/base | 95 % CI |
|---|---:|---:|---:|---|
| `origin/main` `459556a` | 32.5 µs | 26.3 µs | 0.819 | 0.798–0.835 |
| round 1 `41a7fd4` | 26.4 µs | 26.1 µs | 0.986 | 0.955–0.993 |
| `HEAD` (A/A) | 26.2 µs | 26.2 µs | 0.999 | 0.982–1.008 |

The saving against `main` is smaller than before the rebase (6 µs against 9 µs) because #51 made the read it saves cheaper. The sweeps cost nothing measurable on the live tail: against round 1, 0.986.

Verification: `bunx vitest run` (all) 77 files, 1,598 tests passed; `bunx tsc -p packages/tscache --noEmit` and `bunx tsc -p . --noEmit` clean; `FALLOW_AUDIT_BASE=origin/main bun run fallow` clean (a first version of `coalesce` exceeded the cognitive-complexity threshold and was split before commit b68b0c6).

## Not verified

- Bun and Firefox/Safari timings: the end-to-end scenarios run in Chromium only.
- The GitHub runner's timings (the `bench` job reports them on the pull request).

## Contract-test changes

None.

## Decision concerns

None.
