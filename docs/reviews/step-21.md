# Chore 21 — Performance measurement and gate

Branch: `chore/21-perf-gate` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: in review · Verdict after triage: —

The benchmarks and the regression gate the user asked for on 2026-10-26, while away ("Add a performance measurement/benchmark/gate in the roadmap"). The method, the measurements and how the design was chosen are in `docs/benchmarking.md`. Tooling, not a commit-plan step: no engine code changes.

## Scope

| Commit | What |
|---|---|
| c8c38a1 | `chore(bench)`: exact budgets (`scripts/size.ts` with `packages/tscache/bench/budgets.json`; `packages/tscache/test/perf/{memory,counters}.test.ts`); the paired timing harness (`packages/tscache/bench/`: fixtures, cases, sampler, gate, runner, entry) and its driver `scripts/bench.ts`; `bench:smoke` and the size check in `scripts/ci.sh`; a report-only `bench` job in `ci.yml`; `bench-calibrate.yml` with `scripts/bench-calibration.ts`; Knip, Fallow, `.gitignore`; `docs/benchmarking.md` and the roadmap entry |

## Decisions made in the step

The design came from three independent proposals (Claude Opus 5.5, Claude Fable 5.1, GPT-6.1 Sol) over three rounds of cross-critique; `docs/benchmarking.md` ("How this setup was chosen") gives the evidence. These are the points the orchestrator decided where they still differed, and the deviations the user should confirm.

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | Neither mitata nor Vitest bench; a paired sampler of about 140 lines | Starter §4 named both. Vitest bench runs under Node only and compares against a stored baseline; the sampler interleaves two revisions in one process and runs unchanged in Chromium, Bun and Node. **A deviation from starter §4 for the user to confirm** | mitata (a new dependency, no interleaving); Vitest bench under Node |
| D2 | Chromium and Bun gate; Node can be timed and only reports | All three designers ended here or accepted it; Node is a second, older V8 | Node gating too (Fable's first position); Chromium only (Sol's first) |
| D3 | Median ≥ 1.10, interval low ≥ 1.03, 0.25 µs floor, confirmed in a fresh process, A/A control | The rule that caught the injected regressions without false alarms in two designers' experiments; the floor is Opus's, so a 3 µs read still fails at +10 % | 1.15 / 1.05 (missed most +15 %); 1.35 with all rounds > 1.15 (missed all +25 %) |
| D4 | Timing reports only until `bench-calibrate.yml` passes on GitHub's runner (no false alarm in 20 same-revision runs, ≥ 90 % caught at +25 %) | Local evidence cannot stand for a shared runner. The orchestrator does not dispatch the calibration: it spends runner time, so it is the user's to start | Ten report-only pull requests (measures false alarms only) |
| D5 | `Perf-Accepted: <case>[@runtime] <ratio> <reason>` trailer, voided by a later change to `packages/tscache/src` in the pull request | Two designers wanted a trailer, one a file bound to code hashes with an expiry, so that an old acceptance cannot excuse a later change; voiding on a later source change gives that without hashes that every rebase breaks | Trailer alone; `acceptances.json` with hashes and expiry |
| D6 | Growth allocations gate as a tripwire with a lower bound (at least one mask allocation seen, at most 12) | A constructor proxy cannot see every growth strategy; with the lower bound a redesign it cannot see fails loudly instead of passing on zero. Two designers wanted it, the third accepted it | No allocation check (memory and append timing only) |
| D7 | Memory per bar gates per fixture between the fields' bytes and the measured value plus about 1.5 %, under Node | Exact across runs once the engine is held alive; the lower bound catches a collected engine | Report-only memory |
| D8 | The `bench` job runs beside `ci`, not inside `bun run ci` | Timing needs a quiet process and about four minutes; `bun run ci` keeps the exact budgets and a one-second smoke run of every case | Timing inside `bun run ci` |

## Verification

- `bunx vitest run packages/tscache/test/perf`: 15 passed (memory, counts, transfer, extents, growth, the gate's decisions, trailers on a scratch repository with a merge ref).
- Mutation checks, each failing its test: no transfer list in the RPC server; a linear scan in `collect`; linear mask growth in `DenseSegment`; trailers voided by commits the base brings in.
- `bun scripts/bench.ts smoke`: nine cases, each result checked against the fixture.
- Local calibration in `docs/benchmarking.md` ("Calibration log").
- Not verified: the `bench` job and `bench-calibrate.yml` on GitHub (they run once the branch is pushed; the calibration is dispatched by the user); Playwright's Chromium driven from Bun on the Linux runner.
