# Fix 35 — Merge warnings printed in development builds

Branch: `fix/35-dev-merge-warning` · Reviewer: not yet reviewed · Rounds: 0 · Status: implemented, awaiting review · Verdict after triage: —

Resolved decision #8 (architecture §7) says overlap warnings are emitted as `mergeWarning` events **and** printed with `console.warn` in development builds (§2.7). The event and the `put()` result existed; nothing in `src/` printed. Chosen by the director while the user was away, under the user's grant of 2026-10-30; built by a Claude Opus 5.5 subagent. The meaning of decision #8 is unchanged: this fix implements it and records where and when the line prints.

## Scope

| Commit | What |
|---|---|
| 88f5fab | `fix(client)`: `client/dev.ts` `warnMerges()`; `CacheHandle.put` prints its result's warnings in one `console.warn` in development builds; the browser build defines `process.env.NODE_ENV` as itself; TSDoc on `warnOnOverlapDiff`, `PutResult.warnings` and `mergeWarning`; tests |
| 135de15 | `fix(client)`: the client whose `get` started an orchestrated fetch prints that fetch's warnings from its own request-scoped events (`PortClient.pendingOp` tells its puts apart); tests |
| this commit | `docs`: architecture §2.7 clarification and this file |

## Decisions made in the fix

Taken by the subagent under the grant (logged for the user). D1 and D2 are the options the director's brief recommended.

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | The line prints in the page that made the write: `put()` prints from its own result. The worker, the `Engine` and other tabs never print | The developer sees it in their tab's console, once; other tabs already hear the event | The RPC server (worker console, which most developers never open); every client that hears the event (repeats it in every tab) |
| D2 | A development build is `process.env.NODE_ENV !== 'production'`, read bare and wrapped in `try`, so an unbundled page without `process` counts as production and nothing throws | The standard bundler-replaced check; no new public option | `import.meta.env.DEV` (Vite only); an explicit client option (new public API) |
| D3 | The guard is `try { if (process.env.NODE_ENV === 'production') return } catch { return }`, not `typeof process !== 'undefined' && …` | Vite's development server and webpack replace `process.env.NODE_ENV` but leave `typeof process`, which is `'undefined'` in a browser: the `typeof` form would silence every development build in the browser (probed with Vite 8.3.4) | The `typeof` guard |
| D4 | `tsdown.config.ts` defines `process.env.NODE_ENV` as itself for the browser entries | Rolldown replaces it on the browser platform at the package's build, which fixed it to development: the published code would have printed in production too (seen in `dist/index.js` before the define) | Platform `neutral` (changes resolution for every browser entry) |
| D5 | Orchestrated fetches are covered too: the tab whose `get` started the fetch prints each of its request-scoped events, one line per warned range; events of its own pending puts are skipped | A fetch is applied as a put in the worker, so decision #8 applies to it, but a `get` result carries no warnings: the events are the only signal. A tab that joins another tab's in-flight fetch prints nothing (the fetch's warnings carry the starter's request id) | Leave fetch-driven warnings event-only (decision #8 then half-met); group a get's events into one line at its response (needs request ids threaded through `PortClient.request`). Separable: commit 135de15 can be dropped on its own |
| D6 | The message: `tscache: a put to cache "<id>" overwrote cached values that differed: [<start>, <end>] <fields>; …`, with a note that `warnOnOverlapDiff` is on, the events carry the same, and it prints in development builds only | One line per put, listing ranges (already maximal runs), never per point | Per-range lines for puts |

## Verification

- New `test/dev-warnings.test.ts` (8 tests): one warn per put listing every range and field; silent with no warnings (identical values, and `warnOnOverlapDiff` off); two tabs on one SharedWorker print once, while the other tab still hears the event; an `Engine` called directly prints nothing; silent in production (`vi.stubEnv('NODE_ENV', 'production')`) while the result and event still carry the warning; `process` undefined is silent and does not throw; an orchestrated fetch prints once in the tab whose get started it, and nothing in production.
- Before each change: commit 88f5fab's three printing tests failed against a no-op `warnMerges`; the orchestrated test failed against 88f5fab. The silence tests passed throughout, as they should.
- Bundlers, against the built `dist/` imported by a scratch app: Vite 8.3.4 production build contains neither the message nor `NODE_ENV` (branch dropped); Vite's development transform rewrites the check to `"development" === "production"`, so it prints; `bun build --production` folds it to `try{return}catch{return}`, so it never prints, but Bun's minifier keeps the unreachable message text; `bun build` without `--production` treats the build as development.
- `bun scripts/size.ts`: every entry within budget (`index` 14.08 kB brotli of 14.25 kB).

## Decision concerns

None.
