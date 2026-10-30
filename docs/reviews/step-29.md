# Docs 29 — User documentation site

Branch: `docs/29-docs-site` · Reviewer: Codex (high) · Rounds: 3 · Status: re-review pending (round 3 raised a P1; the skip list was closed) · Verdict after triage: merge after re-review

Comprehensive documentation for library users, as a site in its own Bun workspace (`site/`), with an API reference generated from the TSDoc and a build check in `bun run ci`. Built by a Claude Opus 5.5 subagent while the user was away, under the user's grant of 2026-10-30; not a commit-plan step. No engine behaviour changes: the only edits under `packages/tscache/src` are TSDoc comments.

## Scope

| Commit | What |
|---|---|
| 67d4665 | `docs(api)`: a `@module` TSDoc block on the `tscache`, `tscache/engine`, `tscache/fetcher` and `tscache/vite` entries, so the reference names modules after their import paths; `RequestId`'s comment puts its pattern in backticks (raw `<clientId>` broke the VitePress build); `Engine.get`'s comment no longer says orchestration arrives at step ⑪ |
| 9f47a2f | `build(site)`: the `site/` workspace (VitePress, TypeDoc with typedoc-plugin-markdown and typedoc-vitepress-theme, TypeScript 6 under an alias for TypeDoc), its config with the repository-link check, `docs:dev`, `docs:build` and `docs:check` root scripts, `bun run ci` steps, Knip and Fallow configuration; the pages and the compiled code examples |
| feb2595 | `docs`: the README links the site |
| 5db28fc | `docs(review)`: this file |
| 27ca5ea | `docs(site)`: R1-1, R1-2 |
| 431e556 | `docs(site)`: R1-3 |
| 2af0c3f | `docs(site)`: the grid example says why its client has no fetcher (round 1 sweep) |
| 220681e | `docs(site)`: R2-1: the server half of the snapshot example is a renderer created with the fetcher module and the backend's origin, which the fetcher resolves requests against; the example is split into `snapshots-server.ts`, `snapshots-browser.ts` (`startCache`) and `snapshots-page.ts`; the fetcher example speaks the mock backend's protocol; the live example's schema matches its candles |
| 93a9081 | `build(site)`: `bun run docs:run` (`site/scripts/run-snippets.ts`), in `bun run ci` after `docs:check`: the snippets run against the examples' mock backend and are checked for their data (below); `@examples/mock-backend` exports `./backend`; the miss-reason table corrected (the provisional tail stays `'uncached'`) |
| 9da0a97 | `docs(site)`: R3-1: the live example listens for the backend's named `bar` events; its feeds are functions returning their stop |
| 6ee8e2b | `build(site)`: every snippet runs in `docs:run` behind page shims (bundler imports, page origin, a spec-following `EventSource`, `document`, no workers); only `env.d.ts` is skipped |

Pages: getting started; concepts (coverage and gaps, the grid and `alignmentOffset`, segments and slots, versions and watermarks, invalidation and clearing, events in three scopes); the API by example (client, cache, snapshots, fetcher module, engine, errors) beside the generated reference; guides (workers and fallback, writing a fetcher, the Vite plugin and its static-import rule, credentials and `tscache:auth-invalid`, server rendering, live feeds by SSE, WebSocket and polling, expiry and other patterns); vanilla, React, Solid and chart libraries; performance (a summary of `docs/benchmarking.md`); troubleshooting and FAQ; an architecture map for contributors. The internal documents (`docs/architecture.md`, `docs/workflow.md`, `docs/reviews/`, `docs/review-checklist.md`, `docs/guides/`) stay where they are; the site links to them on GitHub.

## How the checks work

- **Code examples compile.** Every example is a region of a TypeScript file in `site/snippets/`, included with `<<< @/snippets/file.ts#region`; `bun run docs:check` (`tsc -p site`, TypeScript 7 from the root) type-checks them against the built package, as `check:integrations` does for the integration snippets. Pages also include whole files from `integrations/`, `examples/` and `reference/`, which their own checks compile. Short configuration blocks (webpack, a shell command, a JSON-like interface listing) stay inline.
- **Dead links fail the build.** VitePress fails on a dead link between pages, including the generated reference. A link to a repository file is a GitHub URL, which VitePress does not check, so a markdown-it rule in `site/.vitepress/config.ts` fails the build when the file is missing from the working tree. A missing include or region fails the build too.
- **The reference is generated.** `typedoc` runs before every `docs:dev` and `docs:build`, into `site/api/` (gitignored), with `treatWarningsAsErrors`.

Verified by hand: a page with a link to `/guides/nowhere` failed the build ("1 dead link(s) found"); a link to `https://github.com/anishbenji/tscache/blob/main/docs/nowhere.md` failed it ("links to docs/nowhere.md, which is not in the repository"); an include of a missing file and of a missing region each failed it. The test page was then removed.

The in-process snippets (`cache.ts`, `engine.ts`, `grid.ts`) were run under Bun against the built package once, and the values their comments state (the `PutError` fields, coverage, the snapped range) match the output.

## Decisions made in the step

Taken by the subagent under the grant (logged for the user).

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | VitePress `2.0.0-alpha.21`, pinned exactly | It runs on Vite 8, the repository's Vite; the stable 1.6.4 (August 2025) needs Vite 5, which is end-of-life | VitePress 1.6.4 (stable, but a second, unsupported Vite major in the lockfile) |
| D2 | TypeDoc 0.28.20 with typedoc-plugin-markdown 4.14.1 and typedoc-vitepress-theme 1.1.4; `typescript` aliased to `npm:typescript@6.0.3` in `site/` only | TypeDoc supports TypeScript up to 6.0 and needs a JS API that TypeScript 7 lacks (AGENTS.md toolchain rule); Bun's isolated install resolves TypeDoc's peer to the alias | Generating from `dist/*.d.ts` (still needs the compiler API) |
| D3 | Examples as compiled snippet files, included by region | Simplest robust option: plain `tsc`, no new dependency, the same pattern as `integrations/` | VitePress twoslash (another dependency and the TypeScript JS API at build time, so TS 6 again; slower builds) |
| D4 | `tscache/worker` left out of the reference | It is a worker script; its one export, `createServer`, is for the package's tests | Documenting it, or marking `createServer` `@internal` |
| D5 | `intentionallyNotExported` for `CacheEvent`, `Context` and `OutputChunkLike` | They are internal shapes named by public signatures; exporting them would change the API surface | Exporting them |
| D6 | `docs:check` and `docs:build` in `scripts/ci.sh` after `check:integrations`; not added to pre-push | The task asks for the CI gate; the build takes a few seconds and pre-push already runs the snippet-style integration check | Adding both to the pre-push `built` group |
| D7 | Repository files linked on GitHub (`blob/main`), anchors unchecked | The site has no copy of those files; anchors into GitHub's rendering are not knowable at build time, so pages link to files and name sections in text | Copying the internal documents into the site |
| D8 | The site restates `docs/guides/worker-setup.md` and `patterns.md` rather than moving them | The task keeps internal docs in place; the README and architecture link them | Moving the guides into the site and linking there from the README |
| D9 | No base path, no deploy, no demo page | Out of scope per the task | — |

## Dependencies added

All dev dependencies of the private `site/` workspace, pre-approved: `vitepress` (the site), `typedoc`, `typedoc-plugin-markdown`, `typedoc-vitepress-theme` (the reference), `typescript` as `npm:typescript@6.0.3` (TypeDoc's compiler), and `vite` `^8.3.4` (the Vite config snippet imports `defineConfig`; the same version the examples use). `tscache` is a `workspace:*` dependency for the snippets. Nothing changes for the published package.

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | The browser snapshot example (`site/snippets/snapshots.ts`) creates its client without a fetcher, so the provisional tail and later bars never load | accepted | Confirmed against architecture §4.9: without a fetcher, `get` stays cache-only and the tail the snapshot leaves out comes back `'uncached'`. 27ca5ea gives the browser client the fetcher module |
| R1-2 | P1 | An older worker rejects `hydrate` with "unknown op hydrate", and the uncaught rejection skips the live read the pages promise as the fallback | accepted | Confirmed against N37 and `integrations/shared/hydration.ts`: the example awaited `hydrate` outside any `try`. 27ca5ea catches exactly that `TscacheError` and goes on to the read; any other error still throws |
| R1-3 | P1 | The fetcher example accumulates fields in an object that inherits from `Object.prototype`, so a field named `constructor` breaks `??=` and `push()` | accepted | Reproduced under Bun: the snippet's accumulation throws "push is not a function" for `constructor`, while an `Object.create(null)` dictionary works and `Engine.put` accepts it. Fixed in 431e556 |

Sweep for the same patterns on other pages: every other client without a fetcher is deliberate. `cache.ts` writes with `put` and reads `cacheOnly`; `errors.ts`, the webpack and no-bundler blocks only connect; `client.ts`'s in-process client is only disposed; `engine.ts` has no worker. `grid.ts` reads without a fetcher to show the snapped miss, and now says so (2af0c3f). The other `hydrate` calls are the integrations' `hydrateRead`, which has the fallback, and `Engine.hydrate`, which has no older worker. The examples' fetcher (`examples/mock-backend/src/fetcher.ts`), which the fetcher guide shows in full, accumulates fields the same way as R1-3; its datasets name no such field, and it is left for a branch that touches the examples.

## Round 2 — reviewer verdict: merge after fixes

The reviewer confirmed R1-1, R1-2 and R1-3 fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P1 | The server snapshot example reads through the fetcher's relative `fetch("/api/series/…")`, which a server cannot resolve without an origin: no points, `'fetch-failed'` misses, empty snapshot coverage | accepted | Reproduced with the new check: with the server's fetcher context lacking an origin, `bun run docs:run` failed with "✗ snapshots-server.ts, snapshots-browser.ts: the server read no points" (exit 1). 220681e passes the origin in the server's fetcher context, as `integrations/shared/server.ts` and the SSR examples do, and the fetcher resolves each request against it; the check then passed |

**Convergence check fired.** `site/snippets/snapshots.ts` drew P1s in rounds 1 and 2 (docs/workflow.md, review loop step 7). Their common cause was that the snippets were only type-checked, so code that compiled but did not work passed CI. The area was redesigned rather than patched: the snippets are now executed in CI (93a9081). `bun run docs:run` starts the examples' mock backend on a free port in the Bun process, runs `fetcher.ts` (five days of bars, so more than one page), `cache.ts`, `engine.ts`, `grid.ts`, and the server and browser halves of server rendering (the browser half in-process against the same backend, with the server's snapshot), and asserts the data each produced: point counts, coverage, columns, the snapped range, and that only the provisional tail is missing. `client.ts`, `errors.ts`, `getting-started.ts`, `live.ts`, `snapshots-page.ts` and `vite-config.ts` need a bundler's `?worker&url`/`?fetcher` imports, `document`, or a stream that never ends, and are listed with that reason; `patterns.ts` defines functions only and `env.d.ts` declarations only. A snippet in neither list fails the check. No Playwright, so it is not a heavy job; it takes about a second.

The first run of the check found a documentation error the reviews had not: the provisional tail is reported as an `'uncached'` miss even right after its fetch returned its points (`orchestrator.ts`, the rest of a fetched range stays uncached while it is uncovered), but the miss-reason table said `'uncached'` meant nobody had asked the backend. The table now says so (93a9081).

## Round 3 — reviewer verdict: merge after fixes

The reviewer confirmed R1-1 to R2-1 fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | The SSE example listens with `events.onmessage`, but the mock backend sends `event: bar`, which `onmessage` never hears, so copied code never puts a pushed bar; CI missed it because `live.ts` was on the runner's skip list | accepted | Confirmed against `examples/mock-backend/src/backend.ts` (`event: bar`) and reproduced: with `live.ts` running behind a spec-following `EventSource`, `bun run docs:run` failed on the old code with "✗ live.ts: no streamed bar reached the cache within 5000 ms" (exit 1). 9da0a97 listens with `addEventListener("bar", …)`; the check then passed. The page's other feeds hold: the polling example now runs and is checked (one poll fills the newest bars), and the WebSocket is described in prose only, consistent with the backend's protocol (a subscription with the token as the first message, then put batches) |

**The skip list was the remaining gap.** The round-2 redesign held, but `docs:run` skipped eight of the fourteen snippets, and R3-1 was in one of them. 6ee8e2b closes the list instead of adding one more run: shims stand in for the page (the bundler's `?worker&url` and `?fetcher` imports, the backend as the page's origin for relative URLs, an `EventSource` that dispatches named events as the spec does, a `document` holding the server's script element for the page entry, and no workers, so every client falls back to in-process as the chain does where workers are missing). Every snippet now runs and is checked for what it produced: the getting-started read, the client's fallback events, the two errors caught, the first streamed bar and the first poll in the cache, the retry pattern's read, the Vite config's plugin, and the page entry's read from the server's snapshot. Only `env.d.ts`, declarations, is skipped. The check still uses no browser and takes a few seconds.

## Found while writing

Discrepancies between the code and other documents, not fixed here (outside a docs branch's scope); the site describes the code.

1. **No `console.warn` for merge warnings.** Resolved decision #8 and architecture §2.7 say an overlap difference is also logged with `console.warn` in dev builds; `packages/tscache/src` has no `console` call. The site documents the `mergeWarning` event and `put()`'s `warnings` only. Either the warning is implemented or the decision text is amended: a decision for the user.
2. **Stale limits in the integration READMEs.** `integrations/README.md` ("Limits every variant shares") and `integrations/solid/README.md` still say a seed carries no dataset version and that closing the seed race needs a snapshot API, which step ⑮ added (`hydrate`).

## Contract-test changes

None.

## Decision concerns

None.
