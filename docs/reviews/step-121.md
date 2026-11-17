# Step 121 — M3 memory bounds and reporting

Branch: `feat/121-m3-memory-bounds` · Reviewer: not yet run (the director runs the pre-review, the security lane and the Codex gate) · Rounds: 0 · Status: awaiting review

## Scope

Builds finding M3 of the review of 2026-11-10, as designed in `docs/design/m3-memory.md` (step 98) and decided by the user on 2026-11-16 (decision 67): an engine-wide byte budget enforced by evicting the least recently used unpinned pages, a stats call, and the reporting of eviction to readers and to the disk.

- **Architecture.** The approved text moved into `docs/architecture.md`: §2.1 (`ClientOptions.memoryBudget`, `TscacheClient.memoryStats()`, `WorkerFeature`), a new §2.9 (memory budget and stats), §2.7 (the `evicted` list and the evicted-coverage rule, now unconditional with a budget), §3.1–§3.2 (`hello.features`, the two ops, the event envelope), §4.3 (store accounting), §4.5 (eviction in `CacheState`), §4.6 (the engine's budget), §4.9 (a get's pin) and §4.10 (eviction and the disk; the §4.10.9 eviction row rewritten as E11 (b) says, and §4.10.10's lazy-loading note). Rows E1–E22 are decisions N86–N105 under `docs/decisions/`, indexed in §8 after N84 with a gap at N85, which step 115 (#144, still open) takes. N82's qualification is now stated as built. The design proposal and the roadmap sketch are marked specified.
- **Engine.** `DenseSegment.bytes` (capacity times the row's bytes, plus the mask). `SegmentStore` keeps a running total only once `count()` switches it on (only with a budget): a put sums the bytes of the pages it may change before and after the write, also when it fails; `clear` zeroes it; `evictPage` drops a page's segments and returns the bytes freed; `pageBytes`, `lastSlotOn` and `forEachPage` answer per page. `CacheState` gains `evict(page)` (§2.9's safety rule in one step, reported through `onEvict` and the running reader change), `flushEvicted()`, `holdsProvisional(page)`, `bytes`, `pageBytes` and `forEachPage`, the evicted-coverage index (E21), the use reports and the enforcement at the end of each mutating call and of `restore`. `engine/memory.ts` (`MemoryBudget`) keeps the total, the use order (a `Set` of page entries), the pins and the evicted count, and enforces. `Engine` takes `{ memoryBudget }` and has `memoryStats()`; the internal `applyMemoryBudget`, `pinPages` and `engineMemoryInternals` serve the server, the orchestrator and the tests. `CacheObserver.onEvict` carries evictions to the persister.
- **Orchestrator.** With a budget, an orchestrated `get` pins its probe (the request and one slot each side) before its first round and releases it in the step of its read, under its `requestId`, so the enforcement at the release reports as caused by that get; a `finally` releases it on every other path.
- **Persister.** `onEvict` marks the covered pages dirty as a write does and schedules the debounced flush: relaxed, no removal counted, `durable` waits for nothing.
- **RPC.** Ops `memoryBudget { bytes }` (answers `{ budget? }`, the budget in force) and `memoryStats`; `hello.features` lists `'memoryBudget'`; `cacheChanged` carries `evicted` when the call evicted coverage.
- **Client.** `ClientOptions.memoryBudget` (validated, `ConfigError`), sent once after `init-ok` before `createClient` resolves; a development warning when the budget in force is not the client's or the worker lacks the feature; `client.memoryStats()`. The `.` and `./engine` entries export `MemoryStats`; `./engine` also `EngineOptions`.
- **Bench.** Counted budgets in `packages/tscache/test/perf/memory-budget.test.ts`; report-only timing cases `read-viewport-budget` and `put-page-budget`; four size budgets raised (below).
- **Docs.** `site/guides/patterns.md` (Memory: the budget recommended, E4), `site/usage/client.md` (the option and `memoryStats()`), `site/concepts/events.md` (`evicted`), `site/guides/persistence.md` (an evicted page leaves the disk too), `site/guides/workers.md` (one budget per engine), `docs/benchmarking.md`, the regenerated `site/how-it-works/package-map.md`, and `docs/releases/0.3.0.md` (in preparation).
- **Not changed here.** The known-limits text on the site's home page (`site/index.md`, "What it leaves out" and "Known limits"), in `README.md`, in `packages/tscache/README.md` and in `docs/guides/patterns.md` ("Known limits of 0.1.0") still says memory is neither bounded nor reported: step 120 (0.2.0) edits that text in parallel and had not merged into `origin/main` (still `8cbb162`) when this step finished, so the brief leaves it for after that merge. `docs/releases/0.2.0.md`, the changelog and the package version are untouched.

## Decisions applied

User decision 67 (2026-11-16): every row as recommended: E1 (a), E2 (a), E3 (a), E4 (a) (no default; the guide recommends one), E5 (a), E6 (a), E7 (a) with its decision concern accepted, E8 (a), E9 (a), E11 (b) with the rewrite of the §4.10.9 eviction row, E13 (a), E14 (a), E15 (a), E16 (a), E17 (a), E18 (a), E19 (a), E20 (b), E21 (a), E22 (a) (documented, not bounded). E10 and E12 are moot under E11 (b).

The director's answers to the contract-test author (bind this step too):

- **A1.** The no-budget test uses the internal `engineMemoryInternals(engine)` accessor plus spies on `CacheState.prototype.evict` and `SegmentStore.prototype.evictPage`, and compares every result with an engine built without the option. Built as such: without a budget no `MemoryBudget` exists, no `memory` hook is passed to a `CacheState`, the store keeps no running total, and the orchestrator's pin is a field read that returns undefined.
- **A2.** Test 5 draws its calls from a consistent ground truth per dataset version. The inconsistent-upsert case stays an `it.todo` with no asserted outcome; nothing in the code decides it beyond §2.9 (see Decision concerns).
- **A3.** Without subscribers no reader report or `cacheChanged` is computed: an eviction outside the evicting cache's own reported call waits in a pending list that is dropped unless `hasReaders` answers true at the end of the enforcement. With a budget the evicted-coverage index is kept regardless, and a removal drops its part of the index whether or not anyone listens.

Choices made in this step without a decision row, each the simplest reading of the approved text:

- **Where enforcement runs.** At the end of every mutating call (inside its `#mutating` wrapper, before the reader change is reported, so a call's own evictions join its one event), at the end of `restore`, and at every pin release. The spec names "every call that wrote points" and "whenever a pin is released"; a watermark moved forward releases provisional pins, and running it after `invalidate` or `clear` is a single comparison, since neither raises the bytes nor makes a page evictable.
- **`evicted` is absent when empty**, as architecture §2.7 had promised in step 114 ("an optional field"), so a payload without a budget is byte-for-byte 0.2.0's.
- **The `memoryBudget` op answers `{ budget?: number }`**, an object for later fields; `{}` means no budget in force.
- **The client gates on `hello.features`.** A worker that does not list `'memoryBudget'` is sent neither op: `createClient` warns once in development and resolves, and `memoryStats()` rejects with `TscacheError` without a round trip. Against a worker that lists it, an `unknown op` cannot happen.
- **A failed write's prefix is a use.** A put that fails part-way may have left pages holding points (N70); they enter the use order, so they are evictable, rather than counted and unevictable.
- **The persister marks only the covered ranges an eviction reports.** A page evicted without coverage has no record (§4.10.2), and the change that withdrew its coverage already marked it.
- **A restore's own trimmed pages are not reported** to readers (commit `47cd98d`): no reader has seen them and a load sends nothing (§2.7). Other caches' pages evicted by the same enforcement are reported once.
- **Size budgets.** The four entries that carry the engine grew by about 1.4 kB brotli and had their budgets raised by the repository's rule (measured size plus max(512 B, 3 %)); the other four moved by at most 0.03 kB and keep their budgets, so no unrelated gate loosens.
- **The stress budget is scaled down.** The design's stress case reads a year of each of 50 series through 100 MB; `memory-budget.test.ts` keeps the ratio at a twelfth of the size (a month of each of 50 series through 8 MB), so it runs in under a second instead of about 8.5 s, against the suite's 5 s timeout.

## Contract-test changes

Codex's five files (`packages/tscache/test/m3-memory-helpers.ts`, `m3-memory-engine.test.ts`, `m3-memory-events.test.ts`, `m3-memory-orchestrator.test.ts`, `m3-memory-persistence.test.ts`; 73 cases) landed with the engine commit. Every behavioural assertion is unchanged. One wiring edit, in `m3-memory-helpers.ts`: its local `MemoryStats` interface and `MemoryEngine` type alias were shape adapters for an API that did not exist yet; `MemoryStats` now comes from `src/types.ts`, and `MemoryEngine` is `Engine` itself under the same constructor type. Fallow reported the unused exported type alias, and the local interface duplicated the real one.

No contract test looked wrong against the spec.

## Other test changes

- `packages/tscache/test/rpc.test.ts`, "hello names the server's lifetime lock": the exact expected hello now lists `features: ['cacheChanged', 'memoryBudget']` (N101). Still an exact `toEqual`.
- `packages/tscache/test/m7-change-rpc.test.ts`, "the first listener subscribes…": the exact expected `client.features` gains `'memoryBudget'`. Still an exact `toEqual`.
- `integrations/test/helpers.ts` (`lossy()`) and `integrations/test/react.test.ts` (`losable()`): the client facades gain the new `memoryStats` member, delegating like their other calls (`TscacheClient` requires it). Found by the first `bun run ci`, in `check:integrations`; `bun run typecheck` does not cover the integrations.

## New tests

| Spec test (design §5) | Where                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–15, 18–19           | Codex's contract tests (above)                                                                                                                                                                                                                          |
| 16                    | `packages/tscache/test/m3-memory-client.test.ts`, "M3 client and ops": validation, `createClient` held until the budget's answer, first-wins with the warning, a worker already holding a cache, an older worker, no option                             |
| 17                    | same file, "M3 hostings": two in-process clients and two dedicated workers, each with its own engine, budget and stats                                                                                                                                  |
| 20                    | `e2e/memory.spec.ts`, two tabs of one `BrowserContext` on one SharedWorker                                                                                                                                                                              |
| 21                    | same file, a persisted cache under a budget, reloaded through a second worker URL                                                                                                                                                                       |
| Bench                 | `packages/tscache/test/perf/memory-budget.test.ts` (counted), `read-viewport-budget` and `put-page-budget` (timed, report only)                                                                                                                         |
| Implementer           | `packages/tscache/test/m3-memory-accounting.test.ts`: the running total equals the walked sum through random writes, removals, clears and evictions (three seeds); `applyMemoryBudget` first-wins and refusal; a restore's own trimmed pages unreported |

## Decision concerns

- **A2, the inconsistent upsert after eviction (for the user).** A cache held point 1, its page was evicted, and an implicit-range put over `[0, 2]` then omits point 1 (a backend whose second answer disagrees with its first). An unbudgeted cache still holds point 1, inside the put's new coverage; a budgeted cache cannot recover it, so the two engines' covered points differ there. §2.9 promises only that an evicted range never reads as a confirmed gap, which holds: the budgeted cache's answer is what the backend said last. Options: (a) document that, under a budget, an upsert without a range over an evicted page is answered from that upsert alone (no code change; recommended, since the backend's own answer is the authoritative one and the unbudgeted cache's extra point is an artefact of its history); (b) withhold coverage from an implicit-range put over evicted coverage, so the page is fetched again whole (costs a refetch and a rule for which puts "count"); (c) treat it as the backend's error, as N3 does for a put that omits points of its own range. The test stays an `it.todo` until the user decides.
- **E7 (accepted by the user).** A tab that opens a large persisted cache pushes its unread history ahead of the pages another tab shows, and that tab fetches them again on its next read.

## Verification

At `1ce6b10` unless noted; the final `bun run ci` runs on the head that adds this file and is reported to the director. A first `bun run ci` at `c6e8bc7` passed every Vitest test (156 files, 3,046 passed, 1 todo) and failed in `check:integrations` on the two facades above, fixed in the next commit.

| Command                                                                                                                    | Result                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bunx vitest run packages/tscache/test/m3-memory-*.test.ts packages/tscache/test/perf/memory-budget.test.ts`               | 7 files, 89 passed, 1 todo (the A2 case)                                                                                                                                                                                                                                                                                       |
| Codex's four contract files alone                                                                                          | 72 passed, 1 todo (73)                                                                                                                                                                                                                                                                                                         |
| `bun run test` (full Vitest suite, machine load average about 23)                                                          | 3,032 passed, 1 todo, 1 failed: `cache-reader-ranges.test.ts`, "reads O(log n) list entries per range", timed out at 5 s; it passes alone in 4.2 s on the same machine. The test (`includeRange`, step 114) is unchanged by this step; its control loop makes 8.4 million proxied reads. Flagged for the director, not changed |
| `bun scripts/test-clocks.ts`                                                                                               | `test-clocks: 195 files clean`                                                                                                                                                                                                                                                                                                 |
| `bun run typecheck`                                                                                                        | exit 0                                                                                                                                                                                                                                                                                                                         |
| `bunx biome check .`                                                                                                       | exit 0 (one existing warning in `e2e/examples/react-lwcharts.spec.ts`)                                                                                                                                                                                                                                                         |
| `bun run fallow`, `bun run fallow:health`                                                                                  | no issues in the changed files; health 97 A                                                                                                                                                                                                                                                                                    |
| `bun run docs:check`                                                                                                       | exit 0 (246 anchors resolve; package map regenerated)                                                                                                                                                                                                                                                                          |
| `bun scripts/bench.ts smoke`                                                                                               | every case ok, the two new ones included                                                                                                                                                                                                                                                                                       |
| `heavy-run.sh "121 child: playwright memory" env E2E_EXAMPLES= bunx playwright test e2e/memory.spec.ts --project chromium` | 2 passed (tests 20 and 21)                                                                                                                                                                                                                                                                                                     |
| `heavy-run.sh "121 child: bench" bun run bench`                                                                            | no gated case fails against `main` (below)                                                                                                                                                                                                                                                                                     |
| `bun scripts/size.ts`                                                                                                      | every entry within its budget (below)                                                                                                                                                                                                                                                                                          |

## Sizes

Brotli, measured with `bun scripts/size.ts` on `main` (`8cbb162`) and on this branch:

| Entry                  | `main`   | This branch | Budget before | Budget after |
| ---------------------- | -------- | ----------- | ------------- | ------------ |
| `index`                | 5.00 kB  | 5.31 kB     | 5.52 kB       | 5.81 kB      |
| `index (lazy)`         | 12.72 kB | 14.24 kB    | 13.22 kB      | 14.75 kB     |
| `index (lazy, nested)` | 5.36 kB  | 5.39 kB     | 5.86 kB       | 5.86 kB      |
| `worker`               | 14.04 kB | 15.46 kB    | 14.48 kB      | 15.97 kB     |
| `worker (lazy)`        | 5.36 kB  | 5.39 kB     | 5.69 kB       | 5.69 kB      |
| `engine`               | 10.11 kB | 11.56 kB    | 10.61 kB      | 12.06 kB     |
| `fetcher`              | 0.17 kB  | 0.17 kB     | 0.64 kB       | 0.64 kB      |
| `vite`                 | 1.24 kB  | 1.24 kB     | 1.45 kB       | 1.45 kB      |

(The script's kB are 1,024 bytes.) The `.` entry grew by 0.31 kB (the client's budget handshake, `memoryStats` and the development warning's text); every bundle that carries the engine by about 1.4 kB (`engine/memory.ts` and the eviction paths of `cache.ts` and `merge.ts`). The memory module cannot be loaded lazily: `new Engine({ memoryBudget })` is synchronous.

## Bench

`bun run bench` (`bun scripts/bench.ts compare`), `1ce6b10` against `8cbb162` (origin/main), on the shared development machine. In Bun the same-revision control left its bounds (0.991 [0.946, 1.041]), so that run was called noisy and nothing could fail; in Chromium no case gates. Every case reported ok.

| Case                     | Bun head/base | Chromium head/base |
| ------------------------ | ------------: | -----------------: |
| `read-viewport`          |         1.039 |              0.984 |
| `read-viewport-sessions` |         1.015 |              0.991 |
| `read-viewport-budget`   |         1.053 |              1.016 |
| `read-year`              |         1.003 |              0.998 |
| `put-page`               |         0.996 |              1.007 |
| `put-page-budget`        |         1.017 |              1.010 |
| `put-live-bar`           |         0.993 |              1.006 |
| `append-bars`            |         1.037 |              1.002 |
| `fill-month`             |         1.004 |              1.002 |
| `snapshot-roundtrip`     |         1.007 |              1.015 |
| `read-transfer`          |         0.979 |              0.993 |

The base ignores `memoryBudget`, so the two `-budget` rows measure what a budget costs: about 5 % (Bun) and 2 % (Chromium) on a viewport read, 1–2 % on a 5,000-bar put. The unbudgeted rows are within noise of `main`. The two new cases report only; gating them needs the calibration of `bench-calibrate.yml`.
