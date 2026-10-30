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
- **End-to-end scenarios in Chromium only report:** a new tab's first read, a read through a SharedWorker, and two tabs sharing a fetch, each paired against the base. They fail on a wrong result or an extra fetch (a smoke run in `bun run ci`), never on a timing.
- **No new dependency.** The sampler is about 240 lines, with its variant for operations that complete later (`packages/tscache/bench/sample.ts`).

## What is measured

### Exact budgets (`packages/tscache/test/perf/`, `scripts/size.ts`)

| Budget | Measured (2026-10-26) | Fails when | Where |
|---|---|---|---|
| Brotli bytes per package entry (each entry bundled with its shared chunks, minified) | `index` 14.30 kB, `worker` 11.12, `engine` 8.76, `fetcher` 0.14, `vite` 0.95 | over `packages/tscache/bench/budgets.json` (measured + max(512 B, 3 %)) | `bun scripts/size.ts`, in `bun run ci` |
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

Not measured here: the network and the fetcher (the backend's cost, not the library's), chart rendering, GC pauses, Firefox and Safari themselves, the Vite plugin, and the coverage index in isolation (below the timer's resolution at realistic sizes; the extent budget guards its algorithm). The end-to-end scenarios below add the worker, the port and a fetch over the loopback interface.

### End-to-end scenarios (`packages/tscache/bench/e2e.ts`, `scripts/bench-e2e.ts`)

These time what a page sees: the client, a real SharedWorker and its port, and the fetcher, in Chromium. Every scenario reads 1,500 one-minute bars, the screen and one each side.

| Scenario | What a page does | Timed from, to | Base, Chromium |
|---|---|---|---:|
| `handshake-first-read` | a new tab creates a client, connects to a new SharedWorker and reads bars the worker fetches | `createClient` called, to the first `get` resolving: worker start, handshake, the fetcher module's import, one fetch, the merge and the transfer | 7.4–7.5 ms |
| `read-viewport-shared` | `get` cached bars through a SharedWorker | the request posted, to its result in the page: the port round trip, the engine's read and the transfer | 32–33 µs |
| `two-tabs-one-fetch` | two tabs of one browser ask for the same new range at once | the first tab asking, to both tabs holding the bars: one fetch, its merge, two reads and transfers, and one `BroadcastChannel` message each way between the tabs | 400–450 µs |

**How they run.** The driver bundles the package's client, worker and fetcher entries of each revision with Bun (unminified ESM, as `tsdown` emits) and serves them beside the scenario page, the Playwright suites' mock backend (`scripts/e2e-backend.ts`) and their fixture fetcher (`e2e/pages/fetcher.js`). Each scenario gets a BrowserContext of its own, so its pages share its SharedWorkers and no other scenario's.
- `handshake-first-read` opens a new page for every run, and a worker URL no earlier run used, so each run starts a new SharedWorker. The driver alternates the revisions, base then head, head then base, one run per side per round, after two warm-up runs per side. A run takes milliseconds, far above the clock's 100 µs, so a batch is one run.
- `read-viewport-shared` connects one page to both revisions, each with its own SharedWorker, fills each cache with three screens by one fetch, and reads the middle screen. `sampleAsync` times it as `sample` times a case: warm-up, 40 ms batches, 20 paired rounds, each operation awaited before the next starts.
- `two-tabs-one-fetch` connects two pages to each revision. The first page sends the range to the second over a `BroadcastChannel` and asks for it itself; the operation ends when its own get has resolved and the second page's answer has arrived. Each operation asks for a range no earlier one did, and the cache is cleared between batches, outside the timer.

**What fails them.** Every operation checks what it read (the bar count, the first and last timestamp, the last price, no misses) and throws on a wrong result. After each scenario the driver asks the backend what it served: `handshake-first-read` one fetch per run, `read-viewport-shared` only its fill (every read is a cache hit), `two-tabs-one-fetch` one fetch per operation, of a range asked for once. The second tab's get either joins the fetch in flight or, if that fetch has already landed, reads the cache; either way the tabs share one fetch. `e2e/dedup.spec.ts` proves the join itself, with the backend holding the fetch open.

**Why report-only.** Two scenarios include a fetch over the loopback interface and a server's response time, which the engine does not control, and none has been calibrated. They have no A/A control and no confirmation, and nothing gates on them; their step in the `bench` job continues on error, so that job's result does not depend on them once it is required. A regression shows as a ratio in the job summary, for a reviewer to read.

Times are from the Apple Silicon Mac, in two runs with base and head the same revision (2026-10-30). Their median ratios were 0.973–1.029, and every 95 % interval held 1; a full run takes about 10 s.

## How a timing is taken

**One bundle, two revisions.** `scripts/bench.ts` extracts the base revision's `packages/tscache/src` with `git archive`, so nothing is checked out. It bundles it with Bun beside the working tree's source and a second copy of the working tree's, and the same bundle runs in every runtime.

**Paired rounds** (`bench/sample.ts`):
1. Each side is warmed up for half a second.
2. A batch is calibrated to last at least 100 ms in `compare` (the sampler's own default, used by the end-to-end scenarios, is 40 ms). Chromium coarsens `performance.now()` to 100 µs without cross-origin isolation; 40 ms keeps that under 0.3 %. The longer batch is for the runner, not the timer: with 40 ms batches and 20 rounds, Chromium's A/A control left its bounds in 5 of 20 runs on GitHub's runner, and with 100 ms batches and 30 rounds in 1 of 20 (calibration log, chore 39).
3. Thirty rounds (twenty for the end-to-end scenarios) time one batch of each side, in the order A B, B A, A B…, and each round gives a ratio, head over base.
4. The result is the median ratio, with a distribution-free 95 % confidence interval: for 30 rounds the 10th and 21st of the sorted ratios (for 20, the 6th and 15th), by the binomial distribution of the median. Nothing is assumed about how timings are distributed.

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
| `e2e --smoke`: every end-to-end scenario once, in Chromium, checked | `bun run ci` | a wrong result, or a fetch the scenario should not make |
| Timing, Chromium and Bun | the `bench` job | report-only now; once calibrated: a confirmed regression no trailer allows |
| End-to-end timings, Chromium | the `bench` job | never: report-only, the step continues on error |

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
bun scripts/bench.ts e2e --smoke   # every end-to-end scenario once, checked (about 2 s)
bun run bench:e2e       # the end-to-end scenarios, the working tree against origin/main
bun scripts/bench.ts e2e --base main --only two-tabs-one-fetch --rounds 30
bun run bench           # the working tree against origin/main, in Chromium and Bun
bun scripts/bench.ts compare --base main --only read-viewport --runtime bun
bun scripts/bench.ts compare --base HEAD --slowdown 0.25   # local calibration run
bun scripts/bench.ts compare --base HEAD --setup short-batches   # a setup of the Chromium noise experiment
bunx vitest run packages/tscache/test/perf                 # the exact budgets
bun scripts/size.ts --update                               # reseed the size budgets (review the diff)
```

`compare` writes `.bench-results/<runtime>.json` (schema version, both SHAs, the gate, every round, verdicts) and `summary.md`, and appends the table to the job summary on GitHub. A local run against `origin/main` takes about two and a half minutes per runtime. `e2e` writes `.bench-results/e2e.json` and `e2e-summary.md` the same way, in about 10 s; it takes `--base`, `--only` and `--rounds`, and refuses `--runtime`, `--gate`, `--slowdown` and `--setup`.

`--setup <name>` picks one of the setups in `packages/tscache/bench/setups.ts`, from the Chromium noise experiment: `default` (what every run uses: 100 ms batches and 30 rounds, in every runtime; an explicit `--rounds` wins), `short-batches` (the earlier 40 ms and 20 rounds), `unthrottled` (Chromium switches that stop it deprioritising a background page), `one-renderer` (`--renderer-process-limit=1`), and `combined` (the default's timing with both sets of switches). `unthrottled` and `one-renderer` time with 40 ms batches and 20 rounds, as the experiment ran them. `bench-calibrate.yml` takes the same name as its `setup` input. The record in `.bench-results/<runtime>.json` names the setup it ran, and on Linux the Chromium run logs which browser binaries it started and how many processes each has.

## Calibration log

| Date | Where | Slowdown | Result |
|---|---|---|---|
| 2026-10-26 | Apple Silicon Mac, Chromium and Bun (head against itself) | 0 | no case flagged in either runtime; median ratios 0.970–1.043; controls 0.996 [0.990, 1.000] and 1.002 [0.999, 1.012] |
| 2026-10-26 | the same | 0.15 | all 18 runtime-case pairs confirmed; measured ratios 1.13–1.22, except Chromium's `read-transfer` at 1.73 (its extra calls move more buffers, and Chromium's cost for that grows faster than the work) |
| 2026-10-26 | the same | 0.25 | all 18 confirmed (run before the injection judged operations by warm calls, so a few Chromium cases overshot to 1.3–1.8) |
| 2026-10-30 | GitHub runner (`ubuntu-24.04`), main at `0797cb5`, runs 40970018107, 40970030587, 40970043045 | 0 | Bun: no case fired in the 16 quiet runs (4 noisy). Chromium: all 20 runs noisy, so none counted |
| 2026-10-30 | the same | 0.15 | Bun, 16 quiet runs: from 2 (`read-year`) to 16 (`put-page`, `put-live-bar`) per case. Chromium: 1 quiet run |
| 2026-10-30 | the same | 0.25 | Bun, 19 quiet runs: 19 in six cases, 18 in `append-bars` and `snapshot-roundtrip`, 16 (84 %) in `read-year`. Chromium: 3 quiet runs |
| 2026-10-30 | GitHub runner, main at `f2a6020` (after step 22), runs 40974332908, 40974342113, 40974350981 | 0 | Bun: no case fired in 20 quiet runs. Chromium: no case fired in 16 quiet runs (4 noisy) |
| 2026-10-30 | the same | 0.15 | Bun, 20 quiet runs: 20 in four cases, 18 in `put-live-bar` and `read-transfer`, 12 in `snapshot-roundtrip`, 11 in `append-bars`, 1 in `read-year`. Chromium, 10 quiet runs: 10 in four cases, 8 in `put-page`, 5 in `read-viewport`, `read-viewport-sessions` and `read-transfer`, 0 in `fill-month` |
| 2026-10-30 | the same | 0.25 | Bun, 18 quiet runs (2 noisy): 18 in six cases, 16 (89 %) in `append-bars` and `snapshot-roundtrip`, 3 (17 %) in `read-year`. Chromium, 15 quiet runs: 15 in `read-year`, `put-live-bar`, `append-bars` and `snapshot-roundtrip`, 11 in `put-page`, 9 in `read-transfer`, 7 in `read-viewport` and `read-viewport-sessions`, 3 in `fill-month` |
| 2026-10-30 | GitHub runner, chore 39 at `364810c` (main `59b8da5` plus the `--setup` switch), setup `default` as it then was (40 ms batches, 20 rounds), run 40995973064 | 0 | Chromium control quiet in 15 of 20 runs; Bun in 19. No case fired in either runtime |
| 2026-10-30 | the same, setup `unthrottled` (`--disable-renderer-backgrounding`, `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`), run 40995975915 | 0 | Chromium quiet in 12 of 20; Bun in 19. No case fired |
| 2026-10-30 | the same, setup `one-renderer` (`--renderer-process-limit=1`), run 40995979086 | 0 | Chromium quiet in 10 of 20; Bun in 20. No case fired |
| 2026-10-30 | the same, setup `long-batches` (100 ms batches, 30 rounds; now `default`), run 40995981693 | 0 | Chromium quiet in 19 of 20; Bun in 20. No case fired |
| 2026-10-30 | the same, setup `combined` (both sets of switches, 100 ms batches, 30 rounds), run 40995984942 | 0 | Chromium quiet in 20 of 20; Bun in 20. No case fired |
| 2026-10-30 | GitHub runner, chore 39 at `b0345b1` (100 ms batches and 30 rounds the default), run 40999175509 | 0.15 | Chromium, 20 quiet runs: 20 in six cases, 19 in `fill-month`, 13 in `read-viewport-sessions`, 10 in `put-page`. Bun, 20 quiet runs: 20 in six cases, 19 in `snapshot-roundtrip`, 6 in `append-bars`, 5 in `read-year` |
| 2026-10-30 | the same, run 40999178404 | 0.25 | Chromium, 19 quiet runs (1 noisy): 19 in seven cases, 18 (95 %) in `read-viewport-sessions`, 16 (84 %) in `put-page`. Bun, 19 quiet runs (1 noisy): 19 in eight cases, 9 (47 %) in `read-year` |

**Verdict of the 2026-10-30 calibration: the timing gate stays report-only.** Bun met both conditions except `read-year` at 25 % (84 %, below 90 %). Chromium could not be judged: its A/A control left [0.95, 1.05] in 17 to 20 of the 20 runs per dispatch. The batches were long enough (512 calls of about 0.11 ms, some 56 ms, against the 40 ms the timer needs), and the control's round ratios split into groups near 0.7, 1.0 and 1.4, so the noise comes from the runner (two shared vCPUs for Chromium's processes), not from the timer. Before the gate can block:
1. Done: recalibrate on a main that includes step 22 (#43), which made the reads several times faster and so changes what each case measures.
2. Find a Chromium setup the runner keeps quiet: more rounds, longer batches, fewer Chromium processes, or a larger runner. A larger runner costs money, so it is the user's decision.
3. Decide whether Bun gates alone in the meantime, with `read-year` left out until it reaches 90 %.

**Verdict of the recalibration after step 22: the timing gate still stays report-only.** No false alarm in either runtime, and Chromium's runs were mostly quiet this time (16 of 20 at 0 %, against none before), so its noise is not constant on the runner. Detection fell short in both runtimes:
- Bun caught every 25 % slowdown in six cases (`read-viewport`, `read-viewport-sessions`, `put-page`, `put-live-bar`, `fill-month`, `read-transfer`). `append-bars` and `snapshot-roundtrip` reached 89 %, just below 90 %. `read-year` fell from 84 % to 17 %: since step 22 it is one large copy per column, and an injected extra call no longer costs its full share of time, so the injection, not only the gate, needs a look for this case.
- Chromium caught every 25 % slowdown in four cases and missed the others often, including the viewport reads.

Next: find out why an injected slowdown in `read-year` measures smaller than injected, then decide whether the six Bun cases that pass gate on their own while the rest stay report-only. Item 2 above (a quieter Chromium setup) stands.

**Verdict of the Chromium noise experiment (chore 39): `compare` now times 100 ms batches and 30 rounds, and Chromium can be judged.** Each setup was dispatched once at slowdown 0 on the same branch within a few minutes, with `default` as that day's control. Only the longer batches moved Chromium's quiet count to 19 of 20 or more: 19 alone, 20 with the switches added. The anti-backgrounding switches alone (12 of 20) and the renderer limit alone (10 of 20) did no better than the control (15 of 20). The bench already ran Playwright's headless shell (`chrome-headless-shell`, one renderer process, as the run's process log shows), so the renderer limit had nothing to limit; Playwright already passes `--disable-background-timer-throttling` to the renderer. The default takes the longer batches alone, the one change the evidence supports; 19 and 20 of 20 cannot be told apart in one dispatch. No case fired at slowdown 0 in any setup. Of the 23 noisy runs with 40 ms batches across the three setups that used them, 19 had calibrated half the usual batch (256 calls of `read-viewport` instead of 512, so the operation ran at about half speed while the batch was sized) and an interval as wide as [0.5, 1.9]; every quiet run had 512 calls or more. That points to slow phases of the runner, which a 40 ms batch can fall inside and a 100 ms batch spans; this is an interpretation of these runs, not tested further. The cost is time: a calibration job takes about four minutes instead of two, and the `bench` job of `ci.yml` grows by about as much.

With the new timing, both runtimes meet the gate's conditions except in one case each: at 25 %, Chromium caught `put-page` in 84 % of quiet runs and Bun caught `read-year` in 47 %; every other case reached 95 % or more, and no case fired at 0. The gate stays report-only: turning it on, in either runtime or per case, is the separate step planned for it (the Bun-only per-case gate), which should now consider Chromium too, without `put-page`. Detection at 15 % is uneven (`put-page` 10 and `read-viewport-sessions` 13 of 20 in Chromium; `append-bars` 6 and `read-year` 5 of 20 in Bun). A larger runner was not needed.

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

1. **Calibrate on GitHub's runner** (above) and turn the gate on. First calibration on 2026-10-30: not yet; see the calibration log.
2. **Done (step 22): the first optimisation the benches pointed at.** `DenseSegment.slice` built each read point by point (a per-slot presence check, a `number[]`, then `Float64Array.from`). It now counts the present slots first (free when the segment has no gap), allocates each result once, and copies a fully present span with one `TypedArray.prototype.slice` per column. Measured locally against `main` (`bun scripts/bench.ts compare --base main --runtime bun,chromium`, head/base median): `read-viewport` 0.150 in Bun and 0.590 in Chromium, `read-viewport-sessions` 0.151 and 0.716, `read-year` 0.097 and 0.526, `snapshot-roundtrip` 0.748 and 0.972.
