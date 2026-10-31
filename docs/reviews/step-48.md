# Step 48 — The in-process hosting loaded lazily

Branch: `feat/48-lazy-inprocess` · Status: awaiting review

Before this step the `'.'` entry imported the in-process hosting statically: `client/hosting.ts` imported `Engine` and `RpcServer`, so every page that created a client downloaded and parsed the whole engine, the orchestrator and the RPC server, although a page served by a SharedWorker or a dedicated worker never runs them. The in-process hosting now lives in `client/in-process.ts`, which `openInProcess` loads with `import()` when the fallback chain reaches it or the client is pinned to it. The build emits it as a chunk of its own. Implemented by a child agent of the director while the user was away; tests with the code, as for the other client steps.

## Scope

| Commit | What |
|---|---|
| f57044e | `chore(size)`: `scripts/size.ts` reports what an entry loads with `import()` on a row of its own (`<entry> (lazy)`, budget key `<entry>:lazy`), bundled without what the entry already holds, and fails when a `dist/` file imports an entry file. Cherry-picked unchanged from `3f8b2ba` on `feat/38-persistence`, so both branches carry the same text and merge without a conflict in this file |
| bd953f2 | `feat(client)`: `client/in-process.ts`; `openInProcess` loads it with `import()`; unit tests through a module-load seam; Playwright tests against the built package |
| 1a5b075 | `chore(size)`: budgets for `index` and the new `index:lazy` |
| 2ca97ab | `perf(bench)`: end-to-end bench revisions bundled with splitting, so the head's lazy chunk stays a chunk as tsdown emits it. Cherry-picked unchanged from `4ce659c` on `feat/38-persistence`, for the same reason as f57044e |
| (this commit) | `docs/architecture.md` §2.1 and §4 (module layout, §4.8 signatures), the size row of `docs/benchmarking.md`, `site/performance.md`, and this file |

## Size

`bun run --cwd packages/tscache build && bun scripts/size.ts`, each entry bundled with its shared chunks, minified, Brotli quality 11.

| Entry | Main `7c9c264` (minified / gzip / brotli) | This branch (minified / gzip / brotli) | Budget (brotli) |
|---|---|---|---|
| `index` | 51.49 / 16.43 / **14.74 kB** | 13.70 / 4.87 / **4.39 kB** | 15,156 → 5,008 B |
| `index (lazy)`, the in-process hosting | (part of `index`) | 37.50 / 12.38 / 11.13 kB | 11,920 B (new) |
| `worker` | 40.22 / 13.14 / 11.80 kB | 40.23 / 13.15 / 11.80 kB | 12,576 B, unchanged |
| `engine` | 31.62 / 10.14 / 9.11 kB | 31.62 / 10.12 / 9.09 kB | 9,488 B, unchanged |
| `fetcher` | 0.18 / 0.16 / 0.14 kB | 0.18 / 0.16 / 0.14 kB | 656 B, unchanged |
| `vite` | 1.98 / 1.09 / 0.95 kB | 1.98 / 1.09 / 0.95 kB | 1,488 B, unchanged |

A page served by a worker loads 10.35 kB brotli less of `tscache` (−70 %), more than the 9 kB estimated. A page that ends up in-process loads 4.39 + 11.13 = 15.52 kB in two requests, 0.78 kB more than before: two files compress separately, and the second request is made only once the chain reaches in-process. Budgets follow the documented rule (measured + max(512 B, 3 %), rounded up to 16 B); only `index` and `index:lazy` were reseeded, the other four keep their budgets.

## Decisions

- **The load hides behind `createClient`.** `createClient` was already asynchronous and resolves once a hosting completed the handshake (§2.1); `openInProcess` was already asynchronous too. The `import()` runs inside it, so no public signature changes and no call made before `createClient` resolves exists to wait on it. No API decision was needed.
- **A failed load is a `HostingError`.** `openInProcess` catches a rejected `import()` (a chunk that cannot be fetched or fails to evaluate) and throws `HostingError("the in-process hosting could not be loaded: …")`. In-process is the last hosting of the chain, so `createClient` rejects with it, as §4.8 says it does when the last hosting fails. Errors from the handshake after a successful load are not wrapped, so their meaning does not change. No `cause` is attached: `TscacheError`'s constructor takes a message only, and changing it is outside this step.
- **No promise cache of the import.** Each in-process `createClient` calls `import()`; the module map makes every call after the first a lookup. A failed load is not remembered by the library, so whether a later `createClient` retries the fetch is the browser's module-map behaviour.
- **The import is destructured inside a `try`.** Fallow recognises an export as used through `const { connectInProcess } = await import(...)`, but not through a member access on the awaited module or through `.catch()` on the import; the `try` block keeps the catch to the load alone.
- **SSR.** The SSR examples and integrations create an in-process client with `await createClient({ mode: "in-process" })` on the server; the extra `import()` resolves within that await and no documented guarantee is synchronous there. `./engine` is unchanged and still imports the engine statically.
- **Shared tooling taken from `feat/38-persistence` verbatim** (f57044e, 2ca97ab). The size script there already reports lazy chunks per entry, which this step needs to measure `index` without its lazy chunk; copying its commits unchanged avoids a second implementation and a merge conflict. `budgets.json` conflicts with that branch regardless (both change `index`); the merge re-measures it.

## Tests

| Where | Test | Checks |
|---|---|---|
| `test/client-lazy-hosting.test.ts` | a SharedWorker client never loads it | `mode` `'shared'`, a put and get work, zero loads of `client/in-process` |
| | a dedicated-worker client never loads it | the same for `'dedicated'` |
| | the in-process pin loads it and works | one load, a put and get work |
| | falling back to in-process loads it and works | one load, `modeFallback` to `'dedicated'` then `'in-process'` |
| | a second in-process client reuses the loaded module | one load for two clients |
| | the in-process pin rejects with a TscacheError naming the load | a failing load rejects `createClient` with a `TscacheError` whose message starts "the in-process hosting could not be loaded:" |
| | at the end of the chain it rejects createClient the same way | the same after shared and dedicated stepped down |
| `e2e/client.spec.ts` (built package, Chromium) | a SharedWorker page never requests the in-process chunk | `/dist/index.js` requested, no `/dist/in-process-*.js` |
| | the in-process pin requests the in-process chunk | exactly one request for it |
| | an in-process chunk that fails to load rejects createClient | the request aborted with `context.route`; `createClient` rejects with the message above |

The module-load seam is `vi.doMock` of `client/in-process`, registered afresh after `vi.resetModules()` in each test, whose factory counts loads and can throw as a failed fetch would. Vitest wraps a factory's error in its own, so the unit test checks the message prefix; the Playwright test checks a real failed fetch. The existing `client.test.ts` tests of the pin and the fallback chain run unchanged against the lazy path.

## Contract-test changes

None.

## Bench

Paired, under the heavy-job lock: `bun scripts/bench.ts e2e --base origin/main --only handshake-first-read,read-viewport-shared,two-tabs-one-fetch,live-tail-get --rounds 20`, head `2ca97ab` against `7c9c264`. Report-only.

| Scenario | Base | Head | Head/base | 95 % CI |
|---|---:|---:|---:|---:|
| `handshake-first-read` | 8.20 ms | 8.25 ms | 1.000 | 0.988–1.025 |
| `read-viewport-shared` | 21.6 µs | 20.8 µs | 0.999 | 0.965–1.069 |
| `two-tabs-one-fetch` | 352.7 µs | 348.8 µs | 0.997 | 0.968–1.015 |
| `live-tail-get` | 26.0 µs | 25.7 µs | 0.985 | 0.954–1.012 |

Every interval contains 1: no change, as expected. The scenarios run over the loopback interface with the page already loaded, so they do not see the download and parse this step saves; the saving is the size table above. `bun scripts/bench.ts smoke` passed (nine micro-benchmarks, each result as expected).

## Verification

| Command | Result |
|---|---|
| `bun run test` | 87 files, 1,770 tests passed |
| `bun run typecheck` | exit 0 |
| `bun run fallow` | no issues in the changed files |
| `E2E_EXAMPLES= bunx playwright test e2e/client.spec.ts --project chromium` | 7 passed |
| `bun scripts/size.ts` | every entry within budget (table above) |
| `bun run ci` (heavy-job lock, on `0350e63`) | exit 0: Vitest 1,770 passed, Playwright 153 passed (chromium, examples with the SSR apps, demo), sizes within budget, bench and e2e smokes ok |

## Not verified

- Browsers other than Chromium (the e2e suites run Chromium only).
- A client created inside an application's own Web Worker bundled by Vite: Vite's module-preload helper, which reads `document`, would wrap the `import()` if Vite bundled that worker as part of the page graph. Creating a client inside a worker is not a documented use; the documented hostings create the worker themselves.
- The time saved on a real network or a slow device: the bench runs over loopback after the page loaded.

## Decision concerns

None.
