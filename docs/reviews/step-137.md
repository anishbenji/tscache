# Step 137 — a failed seeding means "not seeded"

Branch: `fix/137-seed-failure-not-seeded` · Reviewer: none yet (the director runs the review) · Status: built, awaiting review · Never paths touched: none

## Scope

User decision 98 C (2026-11-21), raised as a decision concern in [step 134](step-134.md) (report 4): treat any failure to apply a server's snapshot as "not seeded". Until now, in `integrations/shared/connection.ts`, any seeding failure other than a worker without `hydrate` made every later `cache()` for that cache reject on that client until a replacement client seeded again, so the React snippet never connected until a reload. Decision C follows architecture §2.8 ("hydration is an optimisation, never a requirement for correctness"): warn in development with the error's message only, never the snapshot, hand out the cache, and let it fetch.

Out of scope, as the brief sets it: the tscache package (`packages/tscache/src/` is unchanged, its public API included), decision 106 C, and the two SSR examples, which seed through their own code (below, Decision concerns).

## What changed

- **`integrations/shared/connection.ts`.** The seeder still opens the seed's cache with the seed's own config and applies the snapshot once per client and cache, shared by every later call. A rejection of `hydrateRead` is now caught: in a development build `warnNotSeeded` prints one `console.warn` naming the cache id and the error's message, and the seeding resolves, so `cache()` hands out the cache, which fetches what the seed would have filled. Only the message goes to the console, as a single string; neither the error object nor the snapshot, which carries the page's data, is passed. A failure to open the seed's cache is not caught and still rejects, as before: decision C covers applying the snapshot, not opening the cache. Development is told from production as the library's own warnings do (`packages/tscache/src/client/dev.ts`): `process.env.NODE_ENV`, read bare so a bundler replaces it, and a page without `process` counts as production. The TSDoc of `connect` (formerly lines 90–99) states the new contract.
- **`integrations/shared/hydration.ts`.** `hydrateRead` is unchanged: it still counts only the exact `unknown op hydrate` answer as nothing applied and lets every other failure through, as `hydration.test.ts` pins. Its TSDoc no longer calls every other failure "a bug"; it says that `connect` counts it as not seeded and warns in development.
- **`integrations/README.md`.** The `connection.ts` bullet describes the new behaviour in place of the step 134 text.
- **`integrations/test/helpers.ts`.** `lossy(options)` passes client options, here a fetcher, to the in-process client; existing callers pass none.

Nothing is half-applied by a refused snapshot: architecture §8 (Hydrate: validation, N35) validates the whole snapshot before anything changes, the version and watermark included. The one partial case is a write that fails part way (an allocation failure, Hydrate: failure part-way), which keeps the parts already written, each recorded as coverage with its points, so the cache stays correct; the TSDoc says so.

Documentation searched for a description of a failed seeding: `git grep -niE "seed|hydrat"` over `site/` and `integrations/`, then the hits filtered for "fail", "reject", "error", "warn", "stays" and "retry". The only description was the `integrations/README.md` bullet and the `connect` TSDoc, both updated. `site/frameworks/vanilla.md` embeds `connection.ts` itself, so it shows the new TSDoc. `site/guides/ssr.md` and `site/usage/snapshots.md` already tell an application to treat a failed `hydrate` as "not seeded" and let the cache fetch. No framework helper seeds on its own: React, Solid, Vue, Svelte, Angular and vanilla all reach the seeds through `connection.cache`. `CHANGELOG.md` has no unreleased section (git-cliff writes it at release from the commits), so it is unchanged. No `docs/INDEX.md` row or size changes: the `docs/reviews/` row carries no size.

## Tests

New block `connect, when a seed fails to apply` in `integrations/test/connection.test.ts`, with a fetcher that answers 7 for every slot and records each range it was asked for:

| Test                                                                                                 | Before the change | What it pins                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hands out the cache with nothing of a snapshot that fails validation part way, and the cache fetches | failed            | The seed's snapshot carries its one segment twice: validation rules 1–4 pass and the first payload is accepted, then the second is refused (`invalid snapshot: segments[1] overlaps or precedes segments[0]`). `cache()` resolves; a cache-only read finds no coverage and no point; a read then fetches `[0, 20]` once and answers the fetched values. |
| warns once in development with the error's message, and no snapshot                                  | failed            | One `console.warn` with a single string argument that contains the error's message (taken from an empty cache's own refusal of the same snapshot) and the cache id.                                                                                                                                                                                     |
| is silent in production, and still hands out the cache                                               | failed            | With `NODE_ENV` `production`, no warning; the cache is handed out and fetches.                                                                                                                                                                                                                                                                          |
| counts a worker without hydrate as not seeded, silently, as before                                   | passed            | A handle whose `hydrate` rejects with `unknown op hydrate`: the cache fetches, no warning. Pins today's behaviour.                                                                                                                                                                                                                                      |
| applies and warns once per client and cache, however often the cache is asked for                    | failed            | Two concurrent calls and a later one apply the snapshot once and warn once; a replacement client, after its predecessor's worker is lost, applies and warns once more.                                                                                                                                                                                  |
| still rejects when the seed's cache cannot be opened                                                 | passed            | A seed whose config the client refuses (`interval: -1`): both calls reject with `ConfigError`, and nothing warns. Pins today's behaviour.                                                                                                                                                                                                               |

The two tests that passed before the change pin behaviour decision C keeps; the brief lists both. No existing test or assertion was changed or removed: no test pinned the reject-forever behaviour (the step 134 probe that showed it was never committed), and `hydration.test.ts`'s "lets other failures through" still holds, since `hydrateRead` is unchanged.

## Verification

- `bunx vitest run integrations/test/connection.test.ts` before the change: 4 failed, 16 passed (the four marked "failed" above); after it, with `hydration.test.ts`: 28 passed.
- `bunx vitest run integrations/test`: 8 files, 111 tests passed.
- `bun run build`, then `bun run check:integrations` (tsc over every snippet folder): exit 0.
- `bun scripts/test-clocks.ts`: 215 files clean.
- `bunx biome check integrations`: no findings.
- `~/code/tscache-reports/bin/heavy-run.sh "137 child: ci" bun run ci`: exit 0 on `a832ca1b` (Vitest 3,368 passed, Playwright 197 passed, bench smoke ok). This file is the only change after that run; the final head was gated again (see the child report).

## Contract-test changes

None. These tests are integration tests of application snippets, outside the engine areas that take Codex-authored contract tests.

## Decision concerns

- **The two SSR examples still fail on a failed seed.** `examples/react-ssr/src/session.ts` disposes the client and rejects the connection when its seed fails, and `examples/solid-ssr/src/session.ts` fails the cache memo; their READMEs (Known limits) say so. Both seed through their own code, not `integrations/shared/connection.ts`, and the brief scopes this step to the integrations. Step 134's recommendation for option C named them too (with `examples/mock-backend/src/hydration.ts`). Options: (a) a follow-up step applies decision C to both examples and their READMEs; (b) leave them, documented as they are. Recommendation: (a), so every seeding in the repository follows one rule.

## Part b: the SSR examples

The director applied decision 98 C to the two SSR examples in this step (option (a) of the concern above), so every seeding in the repository follows one rule. The examples import nothing from `integrations/`, so the rule is mirrored in each example's own code rather than shared; `examples/mock-backend/src/hydration.ts`'s `seed` keeps its contract, as part a kept `hydrateRead`'s.

### What changed

- **`examples/react-ssr/src/session.ts`.** A new `seedCache` applies the snapshot through `seed` and returns the ranges it filled, or `undefined` when the snapshot failed to apply. In that case a development build (`import.meta.env.DEV`) prints one `console.warn` naming the cache id and the error's message, as a single string; neither the error nor the snapshot is passed. `connect` still disposes the client and rejects when the cache cannot be opened. The page log reads `snapshot from the server: not applied; the cache fetches what it would have covered` in place of the ranges applied. One consequence needed a guard: a seed interrupted by a lost worker used to reject the attempt, and now resolves with the lost client, so `useConnection` marks each attempt lost when its `workerLost` fires and disposes the attempt's result instead of setting it, which keeps a lost client from replacing the client connected after it.
- **`examples/solid-ssr/src/session.ts`.** The cache memo catches a failure of `seed`, warns in development as above, logs the same line, and returns the handle, so the memo resolves and the page reads through the cache, which fetches. A `client().cache(config)` that rejects still fails the memo, and the `Errored` boundary still shows the server's figures. A lost worker refreshes the client memo, which recomputes the cache memo, so no guard like React's is needed.
- **`examples/mock-backend/src/hydration.ts`.** `seed` is unchanged. Its TSDoc no longer calls every other failure "a bug"; it says that the SSR examples' callers count it as not seeded and warn in development.
- **READMEs.** Both examples' Known limits describe the new behaviour: the page connects, the log reads `not applied`, the cache fetches the whole window, a development build warns with the message; only a cache that cannot be opened fails as before.
- **`e2e/examples/support.ts`.** `serveCorruptSnapshot(page)` serves the page with its snapshot's first segment given twice, the part a corruption: validation rules 1–4 pass and the second segment is refused as overlapping the first. Range and coverage are left as the server wrote them.

### Tests

The examples' seeding tests are their Playwright specs (`e2e/examples/react-ssr.spec.ts`, `e2e/examples/solid-ssr.spec.ts`); the examples have no Vitest tests of their own. The brief's scope list names only `examples/` and this file, but its test step asks for a test where the examples' seeding tests are, so one test was added to each spec, with the helper above. This is the one departure from the listed scope.

| Test                                                                                 | Before the change                                               | What it pins                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| react-ssr: a snapshot that fails to apply leaves the cache to fetch the whole window | failed: status stayed `hydrating` (the connection was refused)  | The page reaches `ready` in shared mode, the log reads `not applied`, the one fetch starts at the window's first day (nothing seeded), the fetch count reads 1, and no page error, console error or console warning (a production build). |
| solid-ssr: a snapshot that fails to apply leaves the cache to fetch the whole day    | failed: status stayed `server-rendered` (the cache memo failed) | The page reaches `ready` in shared mode, the log reads `not applied`, the first fetch starts at the window's first minute, the readings reach at least the server's, and no page error, console error or console warning.                 |

No existing test or assertion was changed or removed. `examples/mock-backend/test/hydration.test.ts` still pins `seed`'s "lets other failures through", which holds, since `seed` is unchanged. The development warning is not covered by a test: the specs run production builds (`vite preview`), and the examples have no unit-test setup that renders a session.

### Verification

- Before the change (session files at `af18229f`, the new tests in place): `E2E_EXAMPLES=react-ssr,solid-ssr heavy-run.sh … bunx playwright test --project=examples -g "fails to apply" e2e/examples/react-ssr.spec.ts e2e/examples/solid-ssr.spec.ts`: 2 failed, as in the table.
- After it: the two specs in full, 13 passed, including both worker-crash tests.
- `bunx tsc -p examples/react-ssr`, `examples/solid-ssr`, `examples/mock-backend` and `e2e` with `--noEmit`: exit 0. `bunx biome check examples e2e docs/reviews`: no findings.
- `bunx vitest run examples/mock-backend`: 6 files, 128 tests passed. `bun run check:integrations`: no errors. `bun scripts/test-clocks.ts`: 215 files clean.
- `bun run ci` through `heavy-run.sh`: see the child report for the final head.

Not verified: the development-build warning in a browser (`bun run dev` for either example); it is the same expression as part a's, behind `import.meta.env.DEV`.
