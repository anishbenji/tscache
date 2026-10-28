# Chore 21 — Performance measurement and gate

Branch: `chore/21-perf-gate` · Reviewer: GPT-6.1 Sol (high) · Rounds: 5 · Status: in review · Verdict after triage: —

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
| D5 | `Perf-Accepted: <case>[@runtime] <ratio> <reason>` trailer, which stands while the head's `packages/tscache/src` equals git's own merge of the trailer's commit with the base the head contains (redesigned in round 2) | Two designers wanted a trailer, one a file bound to code hashes with an expiry, so that an old acceptance cannot excuse a later change; voiding on a later source change gives that without hashes that every rebase breaks | Trailer alone; `acceptances.json` with hashes and expiry |
| D6 | Growth allocations gate as a tripwire with a lower bound (at least one mask allocation seen, at most 12) | A constructor proxy cannot see every growth strategy; with the lower bound a redesign it cannot see fails loudly instead of passing on zero. Two designers wanted it, the third accepted it | No allocation check (memory and append timing only) |
| D7 | Memory per bar gates per fixture between the fields' bytes and the measured value plus about 1.5 %, under Node | Exact across runs once the engine is held alive; the lower bound catches a collected engine | Report-only memory |
| D8 | The `bench` job runs beside `ci`, not inside `bun run ci` | Timing needs a quiet process and about four minutes; `bun run ci` keeps the exact budgets and a one-second smoke run of every case | Timing inside `bun run ci` |

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | A merge that resolves a source conflict by hand leaves an earlier `Perf-Accepted` trailer active (`--no-merges` skips it) | accepted | Validated by reading. A later merge now voids the trailer when its source differs from `git merge-tree --write-tree` of its parents (or the merge had conflicts); merging the base, as GitHub's merge ref does, still does not. Test on a scratch repository: merging `main` with a clean change to the same file keeps the trailer, a hand-resolved conflict voids it; fails with the merge check disabled. 1c3db89 |
| R1-2 | P1 | A checkout path with a space breaks `scripts/bench.ts` and `scripts/size.ts` (URL `pathname` keeps `%20`) | accepted | Validated by reading. Both resolve their paths with `fileURLToPath`, as `vitest.config.ts` does. 1c3db89 |
| R1-3 | P1 | Noisy runs count in the calibration's denominator, so 17 detections in 17 quiet runs read as 17 of 20 | accepted | Validated by reading. The tally (`tallyCalibration` in `bench/gate.ts`) leaves noisy runs out of both counts and lists them apart; unit test with mixed runs. 1c3db89 |
| R1-4 | P1 | A large `--rounds` underflows `0.5 ** n` and hangs `medianRanks` | accepted | Validated by reading. Rounds are bounded to 10–1000 in the driver and in `medianRanks`, which throws outside them; test at both bounds and at 1000 rounds (ranks 469 and 532). 1c3db89 |

## Round 2 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P1 | A later merge whose only conflict is outside the source voids a valid trailer (`merge-tree` fails on any conflict) | accepted; area redesigned | Validated by reading. **Convergence check:** the trailer rule drew findings in rounds 1 and 2, so it was redesigned rather than patched. The history inspection (later commits, then each later merge) is replaced by one comparison: merge the trailer's commit with `merge-base(base, HEAD)` as git would (`merge-tree --write-tree`, its tree taken even with conflicts), and keep the trailer only if the head's source equals that tree's. A hand-resolved source conflict differs (git's merge leaves markers), a README-only conflict does not, a merge ref equals it, a branch behind its base equals it. Tests on scratch repositories for each; the old rule fails two of them, accepting everything fails two others. f263036 |

## Round 3 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | Trailers are checked against the committed head, but the driver benchmarks the working tree, so an uncommitted source edit runs under an acceptance that never covered it | accepted | Validated by reading: `compare` bundles `packages/tscache/src` from the working tree, `stillAccepted` diffs against `HEAD`. Any staged, unstaged or untracked change under the source now voids every trailer (one `git status` before the loop); CI checks out a clean tree, so only local runs are affected. Test on a scratch repository for each kind of change, failing without the check; `docs/benchmarking.md` lists the case. **Convergence check:** the trailer area drew a finding a third round running, but not in the comparison redesigned in round 2: this one is about which source is compared, a precondition outside it. cef0e15 |

## Round 4 — reviewer verdict: merge

No findings; the reviewer confirmed the six accepted findings of rounds 1–3 fixed. The review is settled.

## After settling: the first push

The first push ran the scratch-repository trailer tests inside the pre-push hook, where git exports `GIT_DIR` for the repository being pushed. Inherited, it sent the tests' git commands to the real repository: they rewrote its `.git/config` (`core.bare`, a `user` and `commit.gpgsign`), moved `main` and the branch, and created a branch `pr`. Nothing was pushed (the hook failed), and every change was local and restored from the reflog. The tests now run git without any `GIT_*` variable, and a regression test points `GIT_DIR` at a decoy repository and checks that the scratch commands stay in their own, failing without the fix. Round CI had not caught it because `bun run ci` runs outside a hook.

## Round 5 — reviewer verdict: merge after fixes

Reviewed after the push fix above.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R5-1 | P1 | Both artifact uploads omit `include-hidden-files`, so `.bench-results/` is never uploaded and the calibration summary has nothing to tally | accepted | Validated against the pinned `upload-artifact` source: `include-hidden-files` defaults to false and sets the glob's `excludeHiddenFiles`. Both uploads include hidden files; a calibration run with no report fails (`if-no-files-found: error`). Verified on GitHub only: the `bench` job's artifact on this pull request; the calibration runs when the user dispatches it. db65f6c |

## Verification

- `bunx vitest run packages/tscache/test/perf`: 21 passed, also with `GIT_DIR` set (memory, counts, transfer, extents, growth, the gate's decisions, trailers on a scratch repository with a merge ref).
- Mutation checks, each failing its test: no transfer list in the RPC server; a linear scan in `collect`; linear mask growth in `DenseSegment`; trailers voided by commits the base brings in.
- `bun scripts/bench.ts smoke`: nine cases, each result checked against the fixture.
- Local calibration in `docs/benchmarking.md` ("Calibration log").
- Not verified: the `bench` job and `bench-calibrate.yml` on GitHub (they run once the branch is pushed; the calibration is dispatched by the user); Playwright's Chromium driven from Bun on the Linux runner.
