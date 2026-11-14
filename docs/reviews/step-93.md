# Step 93 — Fallow health toward 95, off protected paths

Branch: `refactor/93-health-toward-95` · Reviewer: not yet run · Rounds: 0 · Status: built, awaiting review

## Scope

Step 83 gated `fallow health --min-score 90` at a score of 92 (A), with deductions unit size −5.5 and coupling −2.5, and planned 95 for later (`docs/reviews/step-83.md`, "The plan for 95"). This step shortens every long function the score counts that is neither a test nor on a protected path. It is a behaviour-preserving refactor: functions are extracted or split, with no API change and no logic change, and no test is changed.

| Commit (by subject)                                                             | What                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `refactor(rpc): split the handshake of PortClient.connect`                      | `protocolMismatch`, `initReply` and `handshakeStep` move out of `connect`'s executor. |
| `refactor(client): create the SharedWorker in its own function`                 | `createSharedWorker` moves out of `openShared`.                                       |
| `refactor(integrations): build the seeding of a connection in its own function` | `seeder(seeds)` moves out of the shared core's `connect`.                             |
| `refactor(scripts): split the demo benchmark's document and main`               | `latencySection`, `limits` and `runLatency` move out of `document` and `main`.        |
| `refactor(bench): build the benchmark cases in groups`                          | `scene` and four case groups replace the single `cases` body; the case order is kept. |
| `docs(review): step 93, fallow health toward 95`                                | This file and its `docs/INDEX.md` row.                                                |

### How the score is computed

Fallow's documentation (fallow.tools, "Code complexity and hotspot metrics explained") gives `score = 100 − sum(penalties)`, with:

- **Unit size:** `min(functions over 60 lines per 1,000 analysed functions × 0.5, 10)`. On `main` that is 17 of 1,556 functions: 17 / 1,556 × 500 = 5.46.
- **Coupling:** `min(coupling_high_pct × 0.5, 5)`, where `coupling_high_pct` is the share of analysed files whose fan-in exceeds `max(p95 fan-in, 10)`. On `main` the p95 fan-in is 25 and 5 of 103 files exceed it: 4.85 % × 0.5 = 2.43.

The gate compares the unrounded score; the printed score is rounded.

### The functions behind the unit-size deduction (`main`, 98b7bbf)

From `bunx fallow health --complexity --max-cyclomatic 0 --max-cognitive 0 --format json`, filtered to `line_count > 60`:

| Lines | Function                                                                     | Kind                | This step             |
| ----: | ---------------------------------------------------------------------------- | ------------------- | --------------------- |
|   575 | `e2e/reference/clients.spec.ts:209` (arrow)                                  | test                | left                  |
|   169 | `integrations/test/connection.test.ts:53` `describe("connect")`              | test                | left                  |
|   142 | `packages/tscache/bench/cases.ts:90` `cases`                                 | bench               | 4 (largest helper 41) |
|   129 | `integrations/test/vanilla.test.ts:38` `describe("series")`                  | test                | left                  |
|   103 | `packages/tscache/src/vite/fetcher-url.ts:120` `fetcherUrl`                  | src, protected path | left                  |
|    87 | `packages/tscache/src/rpc/port-client.ts:78` `PortClient.connect`            | src                 | 60                    |
|    80 | `packages/tscache/src/rpc/port-client.ts:84` its promise executor            | src                 | 53                    |
|    80 | `scripts/demo/processes.test.ts:78` `describe("Processes")`                  | test                | left                  |
|    77 | `integrations/shared/connection.ts:67` `connect`                             | integration core    | 52                    |
|    74 | `scripts/demo-bench.ts:218` `document`                                       | script              | 47                    |
|    74 | `integrations/test/hydration.test.ts:126` `describe("hydrateRead")`          | test                | left                  |
|    68 | `e2e/examples/benchmark.spec.ts:43` (test)                                   | test                | left                  |
|    67 | `scripts/demo-bench.ts:293` `main`                                           | script              | 44                    |
|    66 | `integrations/test/hydration.test.ts:59` `describe("dehydrate / rehydrate")` | test                | left                  |
|    64 | `packages/tscache/src/client/hosting.ts:108` `openShared`                    | src                 | 50                    |
|    61 | `e2e/pages/refresh-harness.js:12` `harness`                                  | test harness        | left                  |
|    61 | `scripts/test-clocks.test.ts:6` `describe("test-clocks")`                    | test                | left                  |

Seven of the seventeen are shortened here. Of the ten left, eight are test files and one is a test harness page, which the brief excludes ("do not change any test"), and one, `fetcherUrl`, is on a protected path. Every extracted function is at most 41 lines.

### The files behind the coupling deduction

From `bunx fallow health --file-scores`; the five files above the threshold of 25:

| Fan-in | File                                      | Notes                                                   |
| -----: | ----------------------------------------- | ------------------------------------------------------- |
|     52 | `packages/tscache/src/errors.ts`          | Protected path                                          |
|     41 | `packages/tscache/src/engine/engine.ts`   | About 33 of its importers are tests                     |
|     34 | `packages/tscache/src/grid.ts`            | About 20 of its importers are tests                     |
|     29 | `integrations/shared/hydration.ts`        | The integration snippets, the examples and their tests  |
|     26 | `packages/tscache/src/engine/validate.ts` | One importer in `src` (`engine.ts`); the rest are tests |

Fan-in counts test files as importers, so lowering it means editing tests' imports, which this step does not do. The threshold is the 95th percentile of the same distribution, so about 5 % of files sit above it whatever their fan-in, unless several tie at the threshold; the deduction cannot fall far below its present 2.4 by moving imports around. This step leaves coupling unchanged.

### Bundle sizes

`bun run size` passes every budget. Brotli bytes, measured with a copy of `scripts/size.ts` that prints bytes instead of kB:

| Entry                  | Before |  After | Change | Budget |
| ---------------------- | -----: | -----: | -----: | -----: |
| `index`                |  4,683 |  4,732 |    +49 |  5,008 |
| `index (lazy)`         | 12,453 | 12,454 |     +1 | 12,464 |
| `index (lazy, nested)` |  5,505 |  5,505 |      0 |  6,000 |
| `worker`               | 13,665 | 13,665 |      0 | 13,728 |
| `worker (lazy)`        |  5,505 |  5,505 |      0 |  5,824 |
| `engine`               | 10,099 | 10,099 |      0 | 10,272 |
| `fetcher`              |    178 |    178 |      0 |    656 |
| `vite`                 |  1,228 |  1,228 |      0 |  1,488 |

`index` holds `port-client.ts` and `hosting.ts`; its growth is the three extracted handshake functions and the object that hands them the handshake's callbacks. `index (lazy)` does not contain either file: its one byte is the changed chunk file name it imports, which brotli compresses one byte differently. That entry was already 11 bytes under its budget on `main` and is now 10; any later change to the in-process chunk needs that headroom or a reviewed budget edit. `budgets.json` is not changed.

### Score

| Revision         | Score (`--score`, unrounded) | Unit size | Coupling |
| ---------------- | ---------------------------: | --------: | -------: |
| `main` (98b7bbf) |                         92.0 |     −5.46 |    −2.43 |
| This branch      |                         94.3 |     −3.19 |    −2.43 |

Ten functions above 60 lines remain, of 1,569 analysed.

### What is left to reach 95

At 10 long functions the score is 94.3. Each long function removed is worth about 0.32 points, so 95 needs at least three more of the ten gone, or the coupling deduction lowered. The options, each the user's call:

1. **Shorten `fetcherUrl` (protected path, `vite/fetcher-url.ts`).** Alone it gives 94.7, not 95: nine long functions, 2.87 + 2.43.
2. **Also shorten the test harness and test functions.** With `fetcherUrl` and `e2e/pages/refresh-harness.js` both shortened the score is 95.0 (eight long functions, 2.55 + 2.43), which passes by a few hundredths; the eight test functions would give the rest. This changes test files, which the brief for this step forbade.
3. **Exclude the remaining test files from the health measure.** `.fallowrc.json` already excludes `packages/*/test/**`, with the reason "Test tables run long by design; size thresholds gate src only", but not `e2e/**`, `integrations/test/**` or `scripts/**/*.test.ts`. Adding those three globs (measured with a scratch copy of the config, not committed) gives 97.2 (A): unit size −0.6, coupling −2.2, over 920 analysed functions. It also takes those files out of every other health measure (complexity, CRAP), as for `packages/*/test/**`. This is a change to what the gate measures, so it is not made here.

The recommendation is option 3, which matches the documented intent of the existing exclusion, followed by option 1 when a protected-path change is next merged.

## Verification

| Check                                                                                                                                                              | Result                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `bunx fallow health --score` on `main`                                                                                                                             | 92 A; unit size −5.5, coupling −2.5                                                                    |
| `bunx fallow health --score` on the final head                                                                                                                     | 94 A; unit size −3.2, coupling −2.5 (94.3 unrounded)                                                   |
| `bunx tsc -p packages/tscache`, `bunx tsc -p .`, `bun run check:integrations`                                                                                      | No errors                                                                                              |
| `bunx vitest run packages/tscache` after the `src` commits                                                                                                         | 101 files, 2,301 tests passed                                                                          |
| `bunx vitest run` on the RPC and hosting files (`rpc`, `rpc-persist`, `hosting`, `hosting-handshake`, `client`, `client-lazy-hosting`)                             | 6 files, 94 tests passed                                                                               |
| `bunx vitest run integrations`                                                                                                                                     | 3 files, 32 tests passed                                                                               |
| `bunx vitest run packages/tscache/test/perf` (includes `gated.test.ts`, which reads `cases()`)                                                                     | 6 files, 58 tests passed                                                                               |
| `document` of `scripts/demo-bench.ts`, old against new, on stubbed inputs with 0, 1 and 3 latencies                                                                | Byte-identical (timestamp line masked)                                                                 |
| `bun run size`                                                                                                                                                     | Every entry within budget (table above)                                                                |
| `heavy-run.sh "93 child: ci" bun run ci` on the final head (includes `bun scripts/bench.ts smoke`, which checks every case's expected value, and the health floor) | Run on the commit that adds this file; its exit code and counts are in the step report to the director |

Not verified: `scripts/demo-bench.ts` was not run end to end (it builds the demo and runs a Chromium benchmark for many minutes and rewrites `docs/benchmarks/demo-comparison.md`); its `document` output was compared as above, and `runLatency` keeps `main`'s checks and log lines in the same order.

## Contract-test changes

None.

## Decision concerns

- Whether the health measure should exclude `e2e/**`, `integrations/test/**` and `scripts/**/*.test.ts`, as it already excludes `packages/*/test/**` (option 3 above).
- Whether `vite/fetcher-url.ts` (`fetcherUrl`, 103 lines) may be split in a step that touches that protected path.
