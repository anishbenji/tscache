# Benchmarking and the performance gate

tscache is meant to be fast at what a chart does: read the screen it shows, take new bars as they arrive, and scroll back through history, in several tabs that share one worker. This document says what is measured, how, and what fails a pull request. The design came from three independent proposals that critiqued each other over three rounds ("How this setup was chosen", below).

## Summary

- **Exact budgets gate every pull request**, in `bun run ci` (and, except the entry sizes, pre-push, which runs Vitest), because they count rather than time and cannot be noisy:
  - the compressed size of each package entry;
  - the memory a cached bar keeps;
  - what a chart scrolling back costs the backend;
  - what a read costs the port between page and worker;
  - how many segments a read looks at;
  - how often a growing segment reallocates.
- **Timings compare the pull request with its base** in one job, case by case. Both revisions sit in one bundle, which is timed in **Chromium** (V8, which most users run) and **Bun** (JSC, the engine of Safari). The rounds alternate their order, so a busy runner slows both sides alike.
- **When a timing fails:** a case fails when its median slowdown is 10 % or more and the 95 % confidence interval lies above 3 %, and a second run in a fresh process confirms it. A same-revision control, timed just before in a process of its own, must stay quiet, or the run is called noisy and nothing fails.
- **Timing reports only until it is calibrated on GitHub's runner** (`bench-calibrate.yml`): it must fire in none of 20 same-revision runs and catch at least 90 % of runs with a 25 % slowdown injected. Then `--gate` goes on and the `bench` check becomes required.
- **No new dependency.** The sampler is about 140 lines (`packages/tscache/bench/sample.ts`).

## What is measured

### Exact budgets (`packages/tscache/test/perf/`, `scripts/size.ts`)

| Budget | Measured (2026-10-26) | Fails when | Where |
|---|---|---|---|
| Brotli bytes per package entry (each entry bundled with its shared chunks, minified) | `index` 13.74 kB, `worker` 11.12, `engine` 8.76, `fetcher` 0.14, `vite` 0.95 | over `packages/tscache/bench/budgets.json` (measured + max(512 B, 3 %)) | `bun scripts/size.ts`, in `bun run ci` |
| ArrayBuffer bytes per cached bar, a year put day by day (Node, after a full collection, engine held alive) | 24/7: 36.233 B, sessions: 36.000, with dropouts: 36.745, against 36 B of fields | below 36 B (the engine was collected: the reading is wrong) or above 36.75 / 36.75 / 37.25 | `memory.test.ts` |
| Fetches for a chart's opening read and twelve screens back, then forward again | 13 fetches; what they cover is at most 0.2 % more than what was read; none on the way forward | another count, more overfetch, or any repeat | `counters.test.ts` |
| A cached read of 1,500 bars through the port | one message each way; 66,000 bytes moved (8 B timestamp and 36 B of fields per bar); no buffer copied; the sender keeps none | anything else | `counters.test.ts` |
| Segment extents a read looks at among 8,192 single-point segments | 14 | more than 24 (a scan would read 8,192) | `counters.test.ts` |
| Mask allocations while a segment grows by 16,384 single-point appends | doubling | none observed (the counting no longer sees the growth: a redesign must update the test), more than 12, or more than 12,288 bytes | `counters.test.ts` |

These are exact on any machine, so the gate is the number. A deliberate change edits the budget in the pull request that needs it, with the reason in the commit message.

### Timings (`packages/tscache/bench/cases.ts`)

Every case drives the public engine (`tscache/engine`), the one engine all three hostings run, so the base and the head of a pull request expose the same API to it. Fixtures are seeded one-minute OHLCV candles (`bench/fixtures.ts`): a year of 24/7 bars (525,600), a year of weekday sessions (101,790 bars across about 260 segments), and a year with dropouts.

| Case | What a chart does | Base, Chromium | Base, Bun |
|---|---|---:|---:|
| `read-viewport` | `get` 1,500 bars (the screen and one each side) from a year of 24/7 bars | 30 µs | 90 µs |
| `read-viewport-sessions` | the same across trading sessions, several segments | 11 µs | 24 µs |
| `read-year` | `get` the whole year | 8.9 ms | 30 ms |
| `put-page` | put a 5,000-bar authoritative page over cached history, and read its last bar | 210 µs | 740 µs |
| `put-live-bar` | put the newest bar again, as a pushed update, and read it back | 3 µs | 2 µs |
| `append-bars` | append 32,768 bars one put at a time, as a live feed does | 78 ms | 53 ms |
| `fill-month` | put 30 day pages into an empty cache | 2.4 ms | 9.1 ms |
| `snapshot-roundtrip` | snapshot a month, encode, decode, hydrate a fresh cache | 28.5 ms | 36 ms |
| `read-transfer` | `get` 1,500 bars and move them to another realm | 29 µs | 99 µs |

Times are from an Apple Silicon Mac, as an example of scale; the gate compares ratios, never these. Each case returns a number derived from its result (the put cases read back the bar they wrote), which `bench:smoke` checks against the fixture, so a case cannot quietly stop doing its work.

Not measured: the network and the fetcher (the backend's cost, not the library's), chart rendering, GC pauses, Firefox and Safari themselves, the Vite plugin, and the coverage index in isolation (below the timer's resolution at realistic sizes; the extent budget guards its algorithm). Chromium end-to-end scenarios (handshake to first read, a read through a SharedWorker, two tabs sharing a fetch) are the next addition, report-only.

## How a timing is taken

**One bundle, two revisions.** `scripts/bench.ts` extracts the base revision's `packages/tscache/src` with `git archive`, so nothing is checked out. It bundles it with Bun beside the working tree's source and a second copy of the working tree's, and the same bundle runs in every runtime.

**Paired rounds** (`bench/sample.ts`):
1. Each side is warmed up for half a second.
2. A batch is calibrated to last at least 40 ms. Chromium coarsens `performance.now()` to 100 µs without cross-origin isolation; 40 ms keeps that under 0.3 %.
3. Twenty rounds time one batch of each side, in the order A B, B A, A B…, and each round gives a ratio, head over base.
4. The result is the median ratio, with a distribution-free 95 % confidence interval: the 6th and 15th of the 20 sorted ratios, by the binomial distribution of the median. Nothing is assumed about how timings are distributed.

**The A/A control.** Before the comparison, each runtime times the head against the second copy of itself, in a fresh process (or page) of its own. These are two copies of the same code, as base and head are when a pull request leaves the engine alone. If the control's interval leaves [0.95, 1.05], the run is noisy and nothing fails.

The interval treats the rounds as independent. Neighbouring rounds share the machine's state (a frequency change, another job), so the true coverage is somewhat less than 95 %. The confirmation in a fresh process and the A/A control are there for that.

**Runtimes.**
- **Chromium** is the primary signal: it is the engine most users run.
- **Bun** is the only JSC available on a Linux runner. The engines rank the cases differently (on the Mac above, reads are two to three times slower in Bun while appending bars is faster), so a regression can show in one and not the other.
- **Node** can be timed (`--runtime node`) but is never gated. It is a second V8, older than any shipped browser's, so a regression only Node shows is one no user meets.

**Why not mitata or Vitest bench.** Starter §4 named mitata for micro-benches and Vitest bench (tinybench) for regression gating. Both are set aside, a deliberate deviation recorded here for the user to confirm:
- Vitest bench runs under Node only, cannot run in Chromium or Bun, and compares against a stored baseline instead of interleaving two revisions in one process.
- mitata would add a dependency without adding interleaving.

The paired sampler serves all three runtimes. Vitest remains the runner for the exact budgets.

## The gate

| Check | Runs in | Fails a pull request when |
|---|---|---|
| Entry sizes | `bun run ci`, the `ci` job | over budget, always |
| Memory, fetch, port, extent and growth budgets | Vitest: pre-push, `bun run ci`, the `ci` job | over budget, always |
| `bench:smoke`: every case once, its result checked | `bun run ci` | a case returns the wrong result |
| Timing, Chromium and Bun | the `bench` job | report-only now; once calibrated: a confirmed regression no trailer allows |

**A timing regression** must meet all of these:
- a median head/base ratio of at least **1.10**;
- the confidence interval's lower bound at least **1.03**;
- the head slower by at least **0.25 µs** per operation;
- the same in a **confirmation**: the case timed again in a fresh process with 30 rounds;
- an A/A control inside its bounds.

`bench/gate.ts` holds these decisions, and `test/perf/gate.test.ts` tests them.

**Accepting a deliberate regression.** Add a trailer to a commit of the pull request:

```
Perf-Accepted: read-viewport 1.25 reads assemble rows for the new snapshot format
Perf-Accepted: put-page@bun 1.15 JSC only; V8 is unchanged
```

The case may then be up to that ratio slower; beyond it, it fails again. A trailer accepts the package's source as it stood at its commit, together with whatever the base has brought in since. The gate merges the trailer's commit with the newest base revision the head contains, as git would on its own (`git merge-tree`). The trailer stands only while the head's `packages/tscache/src` is exactly that merge's, so these void it:
- a later edit of the source;
- a source conflict resolved by hand, where git's own merge leaves markers;
- another branch merged in;
- any uncommitted change to the source (staged, unstaged or untracked), since the working tree is what gets benchmarked.

GitHub's merge ref, a conflict outside the source, and a branch behind its base keep it. It retires with the merge, since the next pull request's base already contains that code.

**Calibration before the timing gate blocks.** Dispatch `bench-calibrate.yml` three times, with slowdown `0`, `0.15` and `0.25`. Each dispatch runs the head against itself in 20 parallel jobs, with the head made that much slower: an operation of 2 ms or more (judged from warm calls) spins for that fraction of its own time, and a shorter one runs again that often, with no clock read that would slow it on its own. The summary job tallies how often the gate fired per runtime and case, leaving out noisy runs. The gate may block when:
- it fired in none of the 20 same-revision runs;
- it caught at least 90 % of the runs at 25 %, in every gated case whose slowdown clears the floor.

Detection at 15 % is recorded too. Then the `bench` job gets `--gate` and becomes a required check (one line in branch protection). If calibration fails, the thresholds widen, or timing stays report-only with the exact budgets carrying the gate. Each calibration's tally is added below.

## Commands

```sh
bun run size            # entry sizes against their budgets
bun run bench:smoke     # every case once, results checked (about a second)
bun run bench           # the working tree against origin/main, in Chromium and Bun
bun scripts/bench.ts compare --base main --only read-viewport --runtime bun
bun scripts/bench.ts compare --base HEAD --slowdown 0.25   # local calibration run
bunx vitest run packages/tscache/test/perf                 # the exact budgets
bun scripts/size.ts --update                               # reseed the size budgets (review the diff)
```

`compare` writes `.bench-results/<runtime>.json` (schema version, both SHAs, the gate, every round, verdicts) and `summary.md`, and appends the table to the job summary on GitHub. A local run against `origin/main` takes about a minute per runtime.

## Calibration log

| Date | Where | Slowdown | Result |
|---|---|---|---|
| 2026-10-26 | Apple Silicon Mac, Chromium and Bun (head against itself) | 0 | no case flagged in either runtime; median ratios 0.970–1.043; controls 0.996 [0.990, 1.000] and 1.002 [0.999, 1.012] |
| 2026-10-26 | the same | 0.15 | all 18 runtime-case pairs confirmed; measured ratios 1.13–1.22, except Chromium's `read-transfer` at 1.73 (its extra calls move more buffers, and Chromium's cost for that grows faster than the work) |
| 2026-10-26 | the same | 0.25 | all 18 confirmed (run before the injection judged operations by warm calls, so a few Chromium cases overshot to 1.3–1.8) |
| — | GitHub runner | 0, 0.15, 0.25 | pending: dispatch `bench-calibrate.yml` |

## How this setup was chosen

Three designers worked from one brief and the repository, each without seeing the others' first proposal: Claude Opus 5.5, Claude Fable 5.1 and GPT-6.1 Sol. Each then critiqued the other two and revised, and a third round settled the remaining disagreements with experiments under `/tmp`:
- noise of same-revision runs in each runtime;
- detection of injected +15 % and +25 % slowdowns under each proposed rule;
- whether memory per point is exact;
- whether constructor counting can be evaded.

They agreed early on exact budgets first, a rebuilt base rather than a stored baseline, and a bundle-and-sampler harness rather than mitata or Vitest bench. The evidence decided the rest:
- **Thresholds.** Of the three rules proposed, 1.10 with a lower bound of 1.03 caught 76–100 % of +15 % slowdowns per runtime in one design's experiment and 29 of 30 in another's, all of +25 % in both, with no false alarm in same-revision runs. A rule of 1.15 caught 7–34 % at +15 %. A rule of 1.35 with all rounds above 1.15 caught none even at +25 %, and its author withdrew it.
- **Runtimes.** Chromium and Bun: Node agrees with Chromium (one engine, twice), and Bun is the only JSC signal.
- **Memory.** Node's `arrayBuffers` after a full collection is exact to the thousandth of a byte across runs, once the cache is held alive. An earlier reading of zero was a collected engine, which the lower bound now catches.
- **Allocation counting.** A constructor proxy cannot see every growth strategy (a resizable buffer, `transfer`), so the count is a tripwire with a lower bound: a redesign it cannot see fails loudly instead of passing on zero.
- **Acceptance.** Two designers proposed a commit trailer, and one a reviewed file bound to code hashes, with an expiry, so that an old acceptance cannot cover a later change. The trailer is kept, voided by any later source change in the pull request, which answers that concern without hashes that every rebase would break.
- **Floor.** 0.25 µs rather than 1 µs, since a 1 µs floor would hide a 30 % regression of a 3 µs read, which the planned fast path in `DenseSegment.slice` would make the viewport read.

Fable then reviewed the implementation against the converged design. It found a trailer voided by commits a merge ref brings in from `main`, a calibration that slowed the head even at 0 %, a tally that counted noisy runs, and too few rounds accepted. Each is fixed. The trailer rule drew findings again in the first two Codex rounds (a merge resolving a conflict by hand, then a conflict outside the source), so it was redesigned as the single comparison above, tested on scratch repositories.

## Next

1. **Calibrate on GitHub's runner** (above) and turn the gate on.
2. **The first optimisation the benches point at.** `DenseSegment.slice` builds each read point by point (a per-slot presence check, a `number[]`, then `Float64Array.from`). Both measuring designs found it the hot spot: a 500-row read costs 7.5 µs against a 2.3 µs raw copy under V8. A fast path for fully present spans should take about a third of the time, judged by `read-viewport` in both runtimes.
3. **Chromium end-to-end scenarios**, report-only: handshake to first read, a read through a SharedWorker, two tabs sharing a fetch.
