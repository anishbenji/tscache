# Step 109 — split the last long functions

Branch: `chore/109-long-functions` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: in review

## Scope

User decision 66 B (2026-11-15): after step 106 the Fallow health score was 96.4 with three functions over 60 lines, `fetcherUrl` (`packages/tscache/src/vite/fetcher-url.ts`, 103 lines), and `main` (81 lines) and `record` (68 lines) of the demo recorder (`scripts/demo/record.ts`). This step splits all three into named helpers without changing behaviour, as step 93 did for seven others (`docs/reviews/step-93.md`). `vite/fetcher-url.ts` is a protected path, so the user merges this pull request.

| Commit (by subject)                                                      | What                                                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `test(vite): pin each hook of fetcherUrl before it is split`             | `vite-fetcher-url-hooks.test.ts`: each hook called directly, the guards no real build reaches included.    |
| `refactor(vite): split fetcherUrl's hooks into module functions`         | `fileNumber`, `buildsIifeWorker`, `chunkModule`, `devModule`, `fetcherChunks` and `rejectPreloadHelper`.   |
| `refactor(scripts): split the demo recorder's record and main`           | `recordingOn` out of `record`; `chosenScenarios`, `startDemo`, `launchBrowser` and `report` out of `main`. |
| `docs(review): step 109, the last long functions`                        | This file.                                                                                                 |
| `docs(review): step 109, the ci result`                                  | The CI row of the verification table.                                                                      |
| `test(vite): pin fetcherUrl's messages, name, resolve call and fetchers` | The pre-review's four test gaps (below).                                                                   |
| `docs(review): step 109, the fable pre-review`                           | The pre-review section and its verification.                                                               |

### `fetcherUrl`

`fetcherUrl` is public API (the `@anishbenji/tscache/vite` entry). Its signature, the exported `FetcherUrlPlugin` interface, the hooks' guards and their order, the IIFE warning and the preload-helper error message are unchanged; only module-private functions are added, so the declaration output is unchanged too. The hooks now read:

- `buildStart`: `warned`, then `buildsIifeWorker(environment)` (mode `build`, consumer `client`, worker format `iife`), then the warning, as before.
- `resolveId`: the file's number comes from `fileNumber(files, id)`, which appends a new file as before.
- `load`: the dev branch calls `devModule(consumer, base, file)`; the build branch calls `chunkModule(context, file, chunks)`, which emits the chunk and records its reference.
- `generateBundle`: for each name from `fetcherChunks(bundle, files)`, `rejectPreloadHelper(this, bundle, name)` walks the chunk's static and dynamic imports and calls the context's `error` on the first chunk carrying the helper. The plugin context is passed whole, so `error` is still called as its method.

Before the split, `vite-fetcher-url-hooks.test.ts` was added and passed on the unchanged code (12 tests). It covers the paths the real builds of `vite-fetcher-url.test.ts` do not: a `?fetcher` import whose module does not resolve, one virtual id per file whichever specifier reaches it, `load` of another id or of a virtual id never given, the dev module for the browser and for server code, `resolveFileUrl` for a browser environment and for a reference the plugin did not emit, and the bundle check through `imports` and `dynamicImports`, through a cycle, past a missing chunk, past a non-fetcher chunk carrying the helper, and past an asset of the fetcher's file.

### The recorder

`record` keeps its order of steps; the `Recording` object it builds moves to `recordingOn(page, scenario, minute, notes, mark)`, where `mark` sets the clip's start as `start()` did. `main` keeps its order of steps and checks: `chosenScenarios()` (the `--only` filter and its error), `startDemo()` (the `--reuse-builds` argument, the cancellation check, the launcher with its stderr watch, its ownership, its exit handler, the wait for the hub and `backend.accept()`), `launchBrowser()` (the cancellation check, the launch with Playwright's signal handlers off, its ownership from the launch on) and `report(results)` (the summary printed at the end). The stage still starts between the demo and Chromium, after a cancellation check.

### Function lengths

From `bunx fallow health --complexity --max-cyclomatic 0 --max-cognitive 0 --format json`:

| Function              | Before | After |
| --------------------- | -----: | ----: |
| `fetcherUrl`          |    103 |    59 |
| `rejectPreloadHelper` |      — |    19 |
| `fetcherChunks`       |      — |    13 |
| `chunkModule`         |      — |    13 |
| `devModule`           |      — |     9 |
| `buildsIifeWorker`    |      — |     7 |
| `fileNumber`          |      — |     4 |
| recorder `main`       |     81 |    26 |
| `startDemo`           |      — |    30 |
| `report`              |      — |    16 |
| `chosenScenarios`     |      — |    11 |
| `launchBrowser`       |      — |    11 |
| recorder `record`     |     68 |    42 |
| `recordingOn`         |      — |    37 |

No function over 60 lines remains in the analysed files.

## Score

Measured with `bunx fallow health --score --format json` (Fallow rounds each penalty to one decimal and subtracts the rounded penalties; see `docs/reviews/step-93.md`).

| Tree                                | Score | Grade | Unit size | Coupling | Functions analysed | Over 60 lines |
| ----------------------------------- | ----: | ----- | --------: | -------: | -----------------: | ------------: |
| `main` at a7f01ba, before this step |  96.4 | A     |      −1.5 |     −2.1 |              1,017 |             3 |
| This branch                         |  97.9 | A     |       0.0 |     −2.1 |              1,029 |             0 |

On this branch `--min-score 97.9` exits 0 and `--min-score 97.901` exits 1. The CI floor stays `--min-score 90`. The remaining deduction is coupling, which step 106 left as it is.

## Bundle sizes

`bun scripts/size.ts` passes every budget before and after. Brotli bytes, measured with a scratch copy of `scripts/size.ts` that prints bytes instead of kB:

| Entry                  | Before |  After | Change | Budget |
| ---------------------- | -----: | -----: | -----: | -----: |
| `index`                |  4,732 |  4,732 |      0 |  5,008 |
| `index (lazy)`         | 12,454 | 12,454 |      0 | 12,976 |
| `index (lazy, nested)` |  5,505 |  5,505 |      0 |  6,000 |
| `worker`               | 13,665 | 13,665 |      0 | 13,728 |
| `worker (lazy)`        |  5,505 |  5,505 |      0 |  5,824 |
| `engine`               | 10,099 | 10,099 |      0 | 10,272 |
| `fetcher`              |    178 |    178 |      0 |    656 |
| `vite`                 |  1,228 |  1,266 |    +38 |  1,488 |

The `vite` entry grows by the six function headers (minified 2,593 to 2,781 bytes, gzip 1,405 to 1,455). `budgets.json` is not changed.

## Verification

| Check                                                                                                                                     | Result                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bunx vitest run packages/tscache/test/vite-fetcher-url-hooks.test.ts` on the unchanged `fetcher-url.ts`                                  | 12 tests passed                                                                                                                                  |
| `bunx vitest run` on `vite-fetcher-url-hooks`, `vite-fetcher-url`, `vite-iife-warning`, `vite-worker` and `bundler-hints` after the split | 5 files, 51 tests passed                                                                                                                         |
| `bunx tsc -p packages/tscache --noEmit`, `bunx tsc -p . --noEmit`                                                                         | No errors                                                                                                                                        |
| `bunx vitest run scripts/demo`                                                                                                            | 5 files, 24 tests passed                                                                                                                         |
| `heavy-run.sh "109 child: launcher spec" bunx playwright test --project=demo e2e/demo/launcher.spec.ts` on 26bee18                        | 16 passed                                                                                                                                        |
| `bunx fallow health --score --format json`                                                                                                | 97.9 A (table above)                                                                                                                             |
| `bun scripts/size.ts`                                                                                                                     | Every entry within budget (table above)                                                                                                          |
| `heavy-run.sh "109 child: ci" bun run ci` on cbffb71                                                                                      | Exit 0; Vitest 137 files, 2,736 tests passed; Playwright 187 passed; health 98 A; every size entry within budget; every bench smoke case matched |

After cbffb71 only this table row changed, so `bun run ci` was not run again.

Not verified: the recorder was not run end to end against a real demo with ffmpeg (it records and re-encodes the committed media for many minutes); the launcher spec drives it with a stand-in ffmpeg, a probe scenario and fake builds.

## Pre-review (Fable), not the gate

Head 0d4c512 (the director's merge of `origin/main` into this branch). No P0 or P1. The reviewer confirmed that the split preserves behaviour: the signature, the hook order, every guard and its order, `IIFE_WARNING`, the 343-byte preload error (compared with `cmp`) and the emitted strings match `main`, and every `stopIfCancelled()` and `own(...)` of the recorder runs in the same order and in the same synchronous run as before. It found test gaps on the protected `fetcherUrl` path that predate the split; the director asked for them to be closed while the file is open.

Each new test was written first and then shown to fail against a temporary mutation of `fetcher-url.ts`, made and undone with the Edit tool (`git diff --quiet HEAD -- packages/tscache/src` afterwards). The mutated runs covered `vite-fetcher-url-hooks.test.ts` and `vite-fetcher-url.test.ts` (and `vite-iife-warning.test.ts` for PR-4); in each, only the new test named failed.

| #    | Sev | Finding                                                                                                                                                                           | Decision | Resolution                                                                                                                                                                                                                                                                                                 |
| ---- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-1 | P2  | The preload-helper error text is pinned only at its ends: rewording "that needs document and window" passes every test                                                            | accepted | Fixed in a380871: "fails with the whole message, naming the fetcher and the chunk" asserts it with `toBe`. Mutation "that needs the DOM": 1 failed, 34 passed.                                                                                                                                             |
| PR-2 | P2  | The bundle check is tested with one fetcher only: `fetcherChunks(...).slice(0, 1)` passes                                                                                         | accepted | Fixed in a380871: a bundle with two fetcher chunks, only the second reaching the helper through a dynamic import; the error must name the second. Mutation `.slice(0, 1)`: 1 failed, 34 passed.                                                                                                            |
| PR-3 | P2  | `resolveId`'s call to `this.resolve` is not pinned (the fake ignored the importer and options): `{ skipSelf: false }` passes, and so does `includes(QUERY)` for `endsWith(QUERY)` | accepted | Fixed in a380871: the fake records each `resolve` call; one test asserts `["./fetcher", "/repo/main.ts", { skipSelf: true }]`, another that `./x?fetcher&y` gives `undefined` without calling `resolve`. Mutation `skipSelf: false`: 1 failed, 34 passed. Mutation `includes(QUERY)`: 1 failed, 34 passed. |
| PR-4 | nit | Assert the plugin's `name` and the whole IIFE warning                                                                                                                             | accepted | Fixed in a380871: `name` is `"tscache:fetcher-url"` (`toBe`), and a browser IIFE build logs exactly the full warning (`toEqual` on the one message). Mutations `name: "tscache:fetcher"` and the warning without "persisting or not", run together: 2 failed (these two tests), 48 passed.                 |

## Contract-test changes

None.

## Decision concerns

None.
