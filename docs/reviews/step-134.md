# Step 134 — integrations and apps docs after M3 and M7

Branch: `docs/134-apps-docs-after-m3` · Reviewer: none yet (the director runs the review) · Status: built, awaiting review

## Scope

Four low-priority reports from the parent thread's read-only research at `6716b4d`, none seen failing. Documentation and comments only: no `packages/tscache/src/` code, no test, and no behaviour changed.

## Reports

| #   | Report                                                                 | Verdict                                    | Change                                                                                                   |
| --- | ---------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 1   | The SSR READMEs still say "no eviction" although `memoryBudget` exists | confirmed in two READMEs                   | `examples/react-ssr/README.md` and `examples/solid-ssr/README.md` describe the opt-in budget             |
| 2   | `reference/README.md`'s copy list leaves out `changes.ts`              | confirmed, and one more demo piece missing | the list names `integrations/shared/changes.ts` and the mock backend's Vite plugin                       |
| 3   | The benchmark adds `?run=` to the worker URL, against the worker guide | deliberate, already explained, and tested  | a fuller comment at the spot; one sentence in both copies of the guide carves out benchmarks and tests   |
| 4   | A seeding that fails stays failed for its client                       | confirmed; no doc promises a retry         | the behaviour is documented where seeding is explained; the retry question is a decision concern (below) |

### 1. "No eviction" in the SSR READMEs

Evidence: `grep -rn -i evict` over every `README.md` under `examples/`, `reference/` and `integrations/` finds the claim twice, `examples/solid-ssr/README.md` ("since tscache v1 has no eviction") and `examples/react-ssr/README.md` ("tscache v1 has no eviction, only `invalidate` and `clear`"). No README under `reference/` or `integrations/` mentions eviction or memory. Since step 121 (architecture §2.9, N86–N105) a client takes `memoryBudget`, with no default; above it the engine evicts the least recently used pages, and a later read fetches them again. An in-process client has its own engine and budget (`site/guides/patterns.md`, Memory), so the advice applies to both servers, which create one with `mode: "in-process"` (`src/entry-server.tsx`).

Change: both paragraphs now say the cache keeps everything unless the client has a budget, that tscache sets none by default, that with `memoryBudget` the least recently used pages above it are evicted and fetched again by a later read (§2.9), that the example sets none, and that a server reading many series or long ranges should set one, linking the Memory section of `site/guides/patterns.md`, which recommends it. Clearing on the application's own clock (§2.4) stays as the alternative.

### 2. The reference clients' copy list

Evidence: the reference clients import four modules of `@tscache/integrations` (`grep -rhoE 'from "@tscache/integrations[^"]*"' reference`): `shared/connection`, `shared/hydration`, `shared/server` and `vanilla/series`. `integrations/vanilla/series.ts` imports `../shared/changes` (`ViewReads`, `Frame`, `ReadMode`), so a copy without `changes.ts` does not compile. `connection.ts` and `server.ts` import only `hydration.ts`, and `changes.ts` imports only the package's types, so these five files are the whole closure. Every module of `reference/shared/src/` is covered by "take `shared/`". Of the demo's own imports, the fetcher, `read-insights`, `market.ts` (which imports the mock backend's `datasets`) and `auth.ts` (which imports its `fetcher` types and `insights`) were already in the list of what to replace; `@examples/mock-backend/vite` (`mockBackend` and `ssrPage` in each client's `vite.config.ts`, and its types in each `entry-server`) was not.

Change: the list adds `integrations/shared/changes.ts`, "which `series.ts` imports", and the replace list gains the mock backend's Vite plugin and server rendering, to be replaced with the application's backend and server.

### 3. The benchmark's `?run=` worker URL

Evidence: the query is set in `examples/benchmark/src/modes.ts` (`runWorkerUrl`), not in `scripts/bench-e2e.ts`. It is deliberate: commit `948f7540` (2026-11-09, "start a new SharedWorker for each benchmark run") added it because a SharedWorker outlives its last tab by about 30 s, so every tscache run after the first reused a warm worker with its fetcher loaded, a hidden advantage. The file's header comment already says so, and `e2e/examples/benchmark.spec.ts` runs tscache twice and expects two workers. The same technique, also deliberate and commented, gives fresh workers in `packages/tscache/bench/e2e.ts` (`options`, "a fresh name starts a fresh worker"), `scripts/bench-e2e.ts` (reload-first-read, "a worker URL no earlier run used"), `e2e/memory.spec.ts` and `e2e/persist.spec.ts` ("the same worker script under another URL: a new SharedWorker").

The guide's warning does not bite in either place. It concerns a worker chunk that imports the worker file by its plain URL. The benchmark example builds an ES worker, but none of its caches persists and nothing calls `clearAll` (`grep -rn "clearAll\|persist" examples/benchmark/src` finds nothing), so the persistence chunk never loads. The bench and e2e suites load the package's `dist/` directly, whose lazy chunk imports `engine-*.js` and `errors-*.js`, never `worker.js` (checked on a fresh `bun run --cwd packages/tscache build`).

Change: the TSDoc of `runWorkerUrl` says the query is deliberate, why, and why the guide's concern does not apply there. `docs/guides/worker-setup.md` and its site copy, `site/guides/workers.md` (Vite), gain one sentence: benchmarks and tests add a query on purpose, since a SharedWorker is one per script URL and a fresh URL gives each run a fresh worker, and an application does not need that. The required checks' code (`scripts/bench-e2e.ts`, `packages/tscache/bench/`) is unchanged.

### 4. A seeding that fails

Evidence: seeding lives in three places.

- `integrations/shared/connection.ts` (`seeder`), used by the reference clients and the six integration snippets: each cache's seeding promise is kept per client in a `WeakMap` and never removed, so a rejection is returned to every later `connection.cache(client, config)` for that cache until a replacement client (after `workerLost`) seeds afresh. `hydrateRead` (`integrations/shared/hydration.ts`) counts only the RPC answer `unknown op hydrate` (a worker from before `hydrate`) as "not seeded"; any other failure propagates. A version mismatch is not a failure: `hydrate` resolves with `skipped: 'version-mismatch'`.
- `examples/react-ssr/src/session.ts` (`connect`): a failed `seed` disposes the client and rejects the connection; the page logs `could not connect` and never tries again.
- `examples/solid-ssr/src/session.ts` (`createSession`): a failed `seed` fails the cache memo; the `Errored` boundary in `App.tsx` says the browser's cache failed and shows the server's figures. The memo runs again only when a lost worker refreshes the client memo.

A throwaway Vitest probe (not committed) confirmed the first: with a seed whose snapshot names another interval, two `connection.cache()` calls on one client rejected with the same error object, and after the client's worker was lost the replacement's call rejected with a new one. Output: `Test Files 1 passed (1)`, `Tests 1 passed (1)`.

Nothing promises a retry. Searched: architecture §2.8 and N34–N39, N77, the READMEs under `integrations/`, `reference/` and `examples/*-ssr`, and `site/`, for "retry", "tries again" and any sentence pairing a seed with a failure. The nearest text is architecture §2.8, "Old workers (N37)": "An app treats a failed `hydrate` as 'not seeded' and lets the cache fetch: hydration is an optimisation, never a requirement for correctness." It describes the old-worker case, which the helpers handle, and promises a fallback to fetching, not a retry; the helpers' own TSDoc says every other failure "is a bug and propagates". So there is no defect under the brief's rule, and no test was written.

Change: the behaviour is documented where seeding is explained: the `connection.ts` bullet of `integrations/README.md`, the TSDoc of `connect`, and the Known limits of both SSR READMEs. The retry question is the decision concern below.

## Found, not changed

The home page and limit lists still say memory is neither bounded nor reported: `site/index.md` ("What it leaves out": "no eviction or memory limit"; "Known limits"), `docs/guides/patterns.md` ("Known limits of 0.2.0"), and, per step 121's review, `README.md` and `packages/tscache/README.md`. They describe the released 0.2.0, but `site/` otherwise documents `main`, where `site/usage/client.md` and `site/guides/patterns.md` (Memory) describe `memoryBudget`, so the home page contradicts the site's own usage page. Step 121 left this text for after step 120's merge, and no queued brief owns it. They are outside this step's scope (apps and integrations docs); the 0.3.0 release step, or a small docs step, should rewrite them.

## Decision concerns

- **Should a failed seeding be retried, or skipped?** (Report 4.) Today any seeding failure but an old worker leaves the cache unusable through that client (`integrations/shared/connection.ts`) or fails the page's connection (both SSR examples) until the worker is lost or the page reloads, although a seed only saves fetches. The realistic failures are a cache config the worker refuses (`ConfigError`, for example a tab of another deploy that opened the cache with another config), a malformed or foreign snapshot (`invalid snapshot`), and a transient hosting or allocation failure.
  - (a) Keep it, as now documented. Pro: a bug surfaces loudly; a permanent failure such as `ConfigError` would fail the reader's own `client.cache(config)` anyway. Con: a transient failure blocks the cache for the client's lifetime.
  - (b) Forget a failed seeding, so the next `cache()` call tries again. Pro: recovers from a transient failure. Con: a permanent failure repeats on every call, and reads stay blocked while it does.
  - (c) Treat any failure of the snapshot's apply as "not seeded": report it (a development-build warning) and hand out the handle, so the cache fetches; a failure of `client.cache(config)` itself still rejects, through the reader's own call. Pro: matches §2.8's "hydration is an optimisation, never a requirement for correctness"; one rule for every failure, so no retry is needed. Con: a corrupt snapshot no longer stops the page, only warns.
  - **Recommendation: (c),** in `integrations/shared/connection.ts`, `integrations/shared/hydration.ts` and `examples/mock-backend/src/hydration.ts` (with each example's caller), with a test of a failed apply that still reads. It changes the helpers' contract ("any other failure is a bug and propagates") and the docs written here, so it is the user's call and a step of its own.

## Contract-test changes

None.

## Verification

- `bun run docs:check` before committing: exit 0 (the site's type checks, the module graph and the doc anchors).
- `~/code/tscache-reports/bin/heavy-run.sh "134 child: ci" bun run ci` runs on the commit that adds this file, so its result is in the builder's report to the director rather than here.
- `docs/INDEX.md`: `docs/guides/worker-setup.md` re-measured at 13,410 bytes (13.4 KB, was 13.2 KB); `site/` at 271,882 bytes over its 42 tracked Markdown pages (271.9 KB, was 271.8 KB; 271,710 bytes at `6716b4d`). The other files changed have no row with a size (`docs/reviews/` carries a dash).
