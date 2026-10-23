# Step 14 — Integration snippets, documentation and roadmap

Branch: `feat/14-integrations` · Reviewer: GPT-6.1 Sol (high) · Rounds: 5 · Status: settled · Verdict after triage: merge

## Decisions taken with the user (2026-10-22)

- **Snippets.** Six, each client-only and server-rendered with hydration, in current idioms: vanilla JavaScript; React 19 (a provider and a Suspense hook on `use()`); Solid 2.0 (async `createMemo` with `Loading`; 2.0 has no `createResource`, which the starter names); Vue 3.5 (a plugin and a composable); Svelte 5 (runes in `.svelte.ts`); Angular 22 (a root service with signals; `TransferState` for the server's read). Server rendering through each framework's plain renderer, no meta-framework, as ⑬b decided for the examples. All share one framework-neutral core. Rejected: Solid 1.9 `createResource` as the starter names it (a second Solid version in the repository); meta-framework server rendering (Next, Nuxt, SvelteKit, SolidStart, Angular SSR: five large dependencies and their configuration).
- **Dependencies.** Approved as devDependencies of the private `integrations` workspace only, never of the published package: `vue` 3.5.44, `svelte` 5.57.2, `@angular/core` and `@angular/common` 22.2.3 with their `rxjs` 7.8 peer. React 19.3 and Solid 2.0.0-rc.14 were already in the repository (the examples' versions).
- **Checks.** `bun run check:integrations` type-checks every snippet against the built package (one `tsconfig.json` per framework) and runs in `bun run ci` after the build; Vitest runs the shared core and the vanilla snippet against in-process clients. The CI line ships on this branch because it checks only this step's code, as ⑬a's Playwright project did. Rejected: types only (the core would be proven only by compiling); runtime tests for all six (jsdom, a Svelte plugin and Angular's testing packages).
- **Reference clients** (the roadmap's open question from ⑬b): tested source to copy, grown from these snippets, not packages. Recorded in `docs/roadmap.md`. Rejected: subpath adapters (`tscache/react`, `tscache/solid`; every hook becomes semver surface); deferring to the architecture review.

## Findings from the probes (before round 1)

- Plain `tsc` 6.0.3 type-checks all three new frameworks without their own tooling: Svelte's runes are global declarations once a file imports from `svelte`, so `.svelte.ts` modules check; Angular 22's `@Injectable` checks with standard decorators. Neither `svelte-check` nor the Angular compiler is needed. Not covered: `.svelte` and Angular templates, which no snippet type-checks.

## Scope

- `integrations/shared/` (3384ed9): `connection.ts` connects once, replaces the client when its worker is lost, seeds only the first client (⑬b R6-1 made structural), and disposes; `hydration.ts` carries a whole server read through JSON (base64 typed arrays, so NaN survives) and puts its covered ranges into the browser's cache where it does not cover them yet; `server.ts` gives a server process one shared in-process client; `candles.ts` is the demo dataset and its one-line view. A framework adapter adds only the step from a promise to its reactivity, the surface starter §7 describes.
- `integrations/vanilla/` (3384ed9): a latest-wins series that reads again on the client replacing a lost one, without reporting the loss; client-only and server-rendered pages, the server half split from the browser half so no server code reaches the browser bundle.
- `integrations/react/` (5d1220a): `TscacheProvider` and `useSeries`, which suspends through `use()` on a promise cached per client, cache id and range (bounded: answers a mounted component shows stay, plus the eight used last per client). The connection's state comes through `useSyncExternalStore`; state, config and range pass through `useDeferredValue`, so a reconnect or a new range loads in a background render with the previous answer on screen (a store update cannot be a transition). The server reads before `renderToString` and hands the read to the hydration render through the provider's seeds.
- `integrations/solid/` (e457349): `createConnection` and `createSeries`, an async `createMemo` over the connection's state and the range; `isPending` instead of a fallback; after hydration settles, the live chart mounts with the server's read as `loadingValue`.
- `integrations/vue/` (0c3c41b): a `createTscache` plugin (disposed by `app.onUnmount`) and `useSeries` returning shallow readonly refs; everything live starts in `onMounted`, so a server render subscribes to nothing; the range goes through `toRaw`, since a worker cannot be posted a reactive proxy.
- `integrations/svelte/` (13aad11): a `Series` runes class (`$state.raw`), the connection's state bridged with `createSubscriber`, failures thrown to `<svelte:boundary>`; `svelte/server` renders, `hydrate` takes the same props. No `.svelte` files (tsc cannot check them); the component is in the README.
- `integrations/angular/` (0485a1b): `provideTscache`, a root `Tscache` service (`@Service()`) whose state is a signal, and `cacheResource()` over `resource()`, keeping the previous value with Angular's `linkedSignal` and `resourceFromSnapshots` recipe (experimental in 22); the server's read travels in `TransferState`. Bootstrap code that needs `@angular/platform-browser` or `platform-server`, not installed, is in the README.
- Docs: `integrations/README.md` and the root README's section (bb58474); `docs/roadmap.md` (06769d2) with the persistence sketch from the settled §3.7 notes, sketches for dirty notifications and eviction, the reference clients' shape and the items for the post-build architecture review; `docs/guides/patterns.md` (b6cd741) for the starter §8 debts that had no home; the integer-field caveat in `CacheConfig.fields` TSDoc (26005b9).

The five framework snippets were written by Claude subagents (Opus 5.5) from one written brief, one per framework, each confined to its folder, and reviewed by the implementer. Each subagent proved its snippet in a throwaway probe outside the repository, against the built package, and checked the probe with mutants that must fail it:

| Snippet | Server half | Browser half | Mutants caught |
|---|---|---|---|
| React | Node, `renderToString` against an in-process client | Chromium, a real SharedWorker: hydration without fallback or mismatch (a tampered number in the markup does report one), only the uncovered day fetched, latest wins, StrictMode issues one read | n/a (negative control for the mismatch) |
| Solid | Node (`renderToString`) | Chromium, dev and production builds of Solid: 26 checks | 5 of 5 |
| Vue | Bun | Chromium, a real SharedWorker: no hydration warning, only the tail fetched; a `ref()` range without `toRaw` fails with `DataCloneError` | 5 of 7; the two survivors are a guard that the real port's ordering never reaches and `toRaw`, which only the browser run shows |
| Svelte | Node, `svelte/server` with the README's component compiled as written | Chromium: 32 checks | 5 of 5 |
| Angular | Node, `renderApplication` from `@angular/platform-server` (installed in the probe only), JIT | Chromium: hydration of 1 component and 3 nodes, none skipped; only the tail fetched | 4 of 4 |

Not proven at runtime anywhere: a real worker loss (every probe simulated it with a facade like `integrations/test/helpers.ts`, which rejects pending calls and then emits `workerLost`, as the client does), the frameworks' production builds other than Solid's, and Angular's ahead-of-time compiler.

Changes the implementer made in review: the Solid series had dropped the lost-worker guard, relying on the client rejecting pending calls before it emits `workerLost` and on Solid re-running the memo before the rejection arrives; the guard is back, so the read stays pending after a loss whatever the order (the Solid probe passes 26 of 26 with it). The server read every `ssr-server` repeated moved into `shared/server.ts` (`serverReader`, 476a059), which also cleared Fallow's clone groups. Fallow's health gate, which takes code no test references as uncovered, skips the five framework folders, as it skips the examples; `shared/` and `vanilla/` stay gated.

### Documentation debts (starter §8)

| Debt | Where it ships (⑭ marks this step's part) |
|---|---|
| Coverage-index alternatives | `docs/architecture.md` §6.1 |
| Auth designs (a)/(b)/(c) and the Web Locks snippet | §6.2; snippet in `examples/react-lwcharts/src/auth-refresh.ts`; pointer in `docs/guides/patterns.md` (⑭) |
| TTL as a consumer pattern | `docs/guides/patterns.md` (⑭) |
| Integer per-field missingness | §2.2, `examples/solid-uplot`; `docs/guides/patterns.md` and `CacheConfig.fields` TSDoc (⑭) |
| Chrome Android SharedWorker | `docs/guides/worker-setup.md` |
| Multi-tab `clear()` warning | §2.4, §2.7, TSDoc of `clear`/`clearAll`; `docs/guides/patterns.md` (⑭) |
| Version-signal honesty | §2.4; `docs/guides/patterns.md` (⑭) |
| Bundler and worker-entry setup | `docs/guides/worker-setup.md` |
| Persistence design sketch | `docs/roadmap.md` (⑭) |
| Roadmap | `docs/roadmap.md` (started in ⑬b, completed in ⑭) |

## Round 1 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | Hydration drops a field named `__proto__` | accepted | Validated: the library treats Object.prototype names as legal fields (`segment-field-names.test.ts`), and `mapFields` assigned into `{}`, hitting the inherited setter. `mapFields` now uses `Object.fromEntries`, and `rehydrate` reads dtypes from own properties only; a round trip of `__proto__` and `constructor` through JSON and into a second client's cache is tested (854d0d0). |
| R1-2 | P0 | `Connection.cache` reuses a handle for a conflicting config | accepted | Validated by reading: the memo was keyed by cache id alone, so a second config never reached the client's N4/N20 check. The handle is reused only for the same config object; another config goes to `client.cache()` once the first open (and its seed) has finished, so a conflict rejects with `ConfigError` and an equal config opens the same cache. Tested after and during the first open (ec0460b). |
| R1-3 | P1 | React evicts promises that suspended renders still need | accepted | Validated, and worse than reported: twelve cold series under one boundary livelocked (nothing shown in 10 s, 13 to 14 reads per range), because the count-based bound ran during render and judged reads by the components showing them, which a suspended render never is. Redesigned rather than patched: a read is dropped only 30 s after it settled or was last shown, never during a render and never while pending (as TanStack Query's `gcTime`). The repro exposed a second fault: a render that suspended while the client connected met a different promise when React replayed it after the connect. Reads are now kept under the promise their client is known by, which the client keeps once connected. The React probe's twelve-series regression shows one read per range in 847 ms with no warning; its other 23 checks pass (257aa9e). |
| R1-4 | P1 | Svelte can show an overtaken answer for a range asked again (A → B → A) | accepted | Validated: the guard compared range identity, which a read asked again for the same object passes. Each read now takes a generation from a private counter and lands, answer or failure, only if it is still the latest; the range check stays for the microtask before Svelte re-runs the effect. The Svelte probe gained A → B → A with the first A answered last and failed last, and a window case; removing the generation check fails 6 of its checks, removing the range check 2 (4908088). |

## Round 2 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P0 | React's read cache still bypasses the config-conflict check | accepted | Validated in the React probe: the 2-day chart rendered the 1-day chart's answer, with no `ConfigError`. Reads are keyed by the config's JSON (memoised per object), and the server's seed lookup uses the same key: equal configs written as separate objects share one read, and a conflicting one fails at its own error boundary with `ConfigError` before any data is read. The probe gained both cases; its 24 earlier checks pass (fbc12a8). |
| R2-2 | P0 | A seed can replace a concurrent tab's newer data | escalated | Validated by reading: `putCovered` checks the browser's coverage with one request and puts with another, so another tab's fetch landing between them is replaced by the seed's ranged put (N11). The public API has no put that applies only where nothing is covered, so the browser side cannot close it; and it changes values only when the backend changed covered history after the server's read, which is the documented limit of a seed without a dataset version (§2.4, `integrations/README.md`). Documented precisely in `putCovered` and the integrations README (c200e31), and added to the snapshot API item for the post-build architecture review in `docs/roadmap.md`, which would fill only uncovered slots in one engine step. The same race exists in the ⑬b examples' `putSeeds`. Escalated to the user, not patched: closing it is an API decision. |
| R2-3 | P1 | The R1-1 test broke `check:integrations` | accepted | Validated: `tsc -p integrations/test` failed (dtypes widened to `string` by `Object.fromEntries`; `.constructor` read the inherited `Function`), so the round's CI failed. The config is typed and both fields are read as own properties; the test still fails against the old `mapFields` (96fb37b). |

**Convergence check.** R1-2 and R2-1 are one root cause in two places: a memo keyed by cache id in front of the client's N4/N20 check. R2-1 is fixed at the key (React keys reads by the whole config), and no other adapter memoises by id in front of `cache()`. R1-1 and R2-2 both touch `hydration.ts` but are unrelated (field-name encoding; request atomicity); R2-2 is escalated rather than patched.

## Round 3 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P0 | A config changed in place after its open skips the client's check | accepted | Validated by reading: the R1-2 shortcut returned the first handle for the same config object, whatever its current contents. Redesigned with R3-2 (below): every `Connection.cache` call now goes to `client.cache()`, so a changed config is judged afresh; tested (29c9925). |
| R3-2 | P0 | A seed is put into whatever config first asks for its id | accepted | Validated by reading: `openCache` applied a seed by id to the cache opened with the asking config, so coverage read on one grid could become confirmed gaps on another. Each seed is now put once, on the first client, into the cache opened with the seed's own config, before any handle for its id is given out; a reader with a conflicting config is refused with `ConfigError`. Tested, with mutants (no first-client guard, seed never put, read before the seed) each failing a test (29c9925). |
| R3-3 | P1 | React's seed match depends on property order | accepted | Validated in the React probe against the previous commit: a seed config and a hook config with the same values in another property order made the server write a client-rendered boundary. The key is now canonical (the config's and its fields' entries sorted, computed on each render); the probe gained the reordered config on the server and through hydration (no fallback, no mismatch) and a config changed in place (error boundary with `ConfigError`), and its 26 earlier checks pass against the redesigned connection (900adba). |

**Convergence check.** R1-2, R2-1, R3-1, R3-2 and R3-3 share one area: the snippets deciding whether two configs name the same cache, each fix re-implementing N4/N20 a little further and missing a case (identity, id, mutation, seed config, property order). Redesigned instead of patched again: the snippets no longer decide it. `Connection.cache` sends every call to `client.cache()`, which costs one message to the worker per read and is the library's own N4/N20 check; a seed is opened with its own config. React's promise cache still needs a key; it is the config's canonical form, computed on each render, and only decides which reads share a promise, never whether a config is accepted. A further finding in this area goes to the user.

The Solid, Svelte, Vue and Angular probes were rerun against the redesigned connection and pass.

## Round 4 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R4-1 | P1 | React's server render misses a seed whose config spells defaults differently | accepted; escalated per the convergence note | Validated in the React probe against the previous commit: the seed config omitting `alignmentOffset` and the hook's setting it to 0 made the server render the fallback. `serverAnswer` now matches by cache id and range; the README's limits state the accepted cost. The probe gained four regressions: on the server, a reordered config, an explicit default and a conflicting interval all render the seed; in the browser the explicit default hydrates without mismatch and turns live, and the conflicting interval reaches the error boundary with `ConfigError`. Its 29 earlier checks pass (39d6515). |

**Escalation.** The fourth finding in the config-equivalence area went to the user as round 3's note committed. Options put to the user: match the seed by cache id and let the browser's client judge the config (recommended); resolve the library's defaults in `keyOf` (exact, but copies library internals that can drift); document that `useSeries` must be given the seed's own config and reject. **User decision (2026-10-23): match by id.** It finishes round 3's rule that the library alone decides config identity; its accepted cost is that a truly conflicting config renders the seed's data on the server before the browser shows `ConfigError`.

## Round 5 — reviewer verdict: merge

No findings. The reviewer checked that every accepted finding of rounds 1–4 is fixed and saw no basis to re-raise the escalated seed race (R2-2).

## Contract-test changes

None. Step ⑭ is not an engine step; its tests were written with the code.

## Decision concerns

None raised by the reviewer. R2-2 is escalated as a finding (above), and R4-1 was decided by the user.

## Follow-up: the post-build architecture review's agenda (`docs/14-architecture-review-agenda`)

Documentation only, no change under `packages/tscache/src/`. Steps ①–⑭ are merged; the user holds an architecture review next, and `docs/architecture-review.md` prepares it: for the snapshot API (with the seed race R2-2), a `tscache/vite` entry, DC-1 and DC-2 (`docs/reviews/step-12.md`), the context with its sources, the decision points, the options with pros and cons, and a recommendation. `docs/roadmap.md` and the README point at it. What a review of this branch checks is the agenda's claims about the code and the documents it cites (one engine call per op and which calls are synchronous, what `put` with `meta.version` does, what `segmentFromPayload` validates, what the lifetime lock does after a steal, how the snippets render a seed), not the recommendations, which are the user's to decide. Rounds continue from round 6 in `.reviews/step-14/`.

### Round 6 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R6-1 | P2 | A snapshot without a segment (a confirmed gap) carries no grid or schema, so nothing validates it against the receiving cache | accepted | Validated by reading: option D1-A relied on `segmentFromPayload`, which never runs for `segments: []`. The envelope now carries `interval`, `alignmentOffset` and `fields`, checked before anything is applied, and the errors rule says so (a0bdeb9) |
| R6-2 | P2 | A server read and a separate snapshot can see different versions; the agenda said "no race" | accepted | Validated by reading `integrations/shared/server.ts`: one client serves every render, so another render's fetch, and a version change with it, can land between a render's `get` and its `snapshot`. The window is documented under the two-method option, and one `get` with a snapshot option, which takes both from one engine read, is now the recommended shape (a0bdeb9) |
| R6-3 | P2 | A reissued access token need not be refused again: an opaque token renewed in place lets a single tab's retry succeed, so the agenda's single-tab loop does not follow | accepted | Validated by reading: the inference is gone; the context names the renewed opaque token as the realistic case and notes that the mock backend does not exercise it (a0bdeb9) |

**Settled.** No P0 or P1. Per the workflow, P2s do not trigger another round, so round 6's fixes, one of which changes a recommendation (D3), are not Codex-reviewed; say if you want a round 7 before the review.

## Follow-up: the review's decisions and the DC-1/DC-2 assumptions (`docs/14b-assumptions`)

Documentation only, no change under `packages/tscache/src/`. The user held the post-build architecture review and took the recommended option at every decision point of `docs/architecture-review.md` (D1–D11). This branch records the decisions as rows N34–N44 in `docs/architecture.md` §8, each with the alternatives it rejected, and lands the two documentation-only outcomes: DC-1 (N42) as a precondition in the refresh snippet's header, its copy in the examples and `docs/guides/patterns.md`; DC-2 (N43, N44) as assumptions of loss detection in §4.8, one sentence in the fetcher contract (§2.5) and a note in `docs/guides/worker-setup.md`. The roadmap, the README and the agenda point at the rows. The snapshot API (N34–N39) and `tscache/vite` (N40–N41) are built in steps ⑮ and ⑯. What a review of this branch checks: that each row matches the option the agenda recommended and the alternatives it listed, and that the stated assumptions match the code (`rpc/lifetime.ts`, the snippet) and Web Locks behaviour; not the decisions themselves. Rounds continue from round 7 in `.reviews/step-14/`.

### Round 7 — reviewer verdict: merge

No findings. The reviewer checked that N34–N44 match the options the agenda recommended and that the round 6 fixes are still in place. **Settled** after one round, as planned for a documentation branch.

## Follow-up: review tooling (`chore/17-review-tooling`)

Tooling only, no change under `packages/tscache/src/`; backlog items the user parked for after the build (2026-10-11). `scripts/review-watch.sh` commits the silence watchdog every review since step ⑫ ran from a copy in `/tmp`: it runs `scripts/codex-review.sh` with stdin closed and kills the session after `REVIEW_SILENCE_SECONDS` (default 600) without output, exiting 124. Tested against stand-in review scripts: a silent one is killed after 35 s with no process left behind, a busy one exits 0. `scripts/ci.sh` now sets `FALLOW_AUDIT_BASE` to its own base when unset, so a pushed branch is audited against `main` rather than its upstream. `docs/workflow.md` points the review step at the watchdog. Not done, since each needs a decision: type-checking `e2e/` and `scripts/` needs Node or Bun type definitions, a new dependency; running `check:integrations` in pre-push needs a build first. Rounds continue from round 8 in `.reviews/step-14/`.

### Round 8 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R8-1 | P1 | The timeout's global `pkill -f 'codex exec -s read-only'` also kills another checkout's healthy review | accepted | Validated with a regression case: a process named like a codex session outside the review was killed by the old script. The watchdog now kills only the review's own process group, which job control gives it |
| R8-2 | P1 | A review that finishes during the sleep without new output is reported as a timeout (124) | accepted | Validated with a regression case that failed on the old script (124 instead of 0). The loop now rechecks the child after each sleep and returns its own status |

`scripts/review-watch.test.sh` holds four cases (silent review times out; busy review keeps its status; quick silent review exits 0; other sessions survive) with `REVIEW_POLL_SECONDS` and `REVIEW_SILENCE_SECONDS` set to seconds, and `scripts/ci.sh` runs it next to the guard's tests.

### Round 9 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R9-1 | P1 | If `mktemp -d` fails, the test goes on in the real checkout and overwrites `scripts/codex-review.sh` | accepted | Reproduced: with a `mktemp` that always fails first in `PATH`, the old test overwrote the real script (`cd ""` succeeds in bash and stays put). Every setup step now exits on failure, and the scratch path must be a directory. `scripts/ci.sh` runs the test with that failing `mktemp` and checks that it exits non-zero and leaves the real script's hash unchanged. An unwritable `TMPDIR` does not simulate it on macOS, whose `mktemp` falls back to `/tmp` |

### Round 10 — reviewer verdict: merge

No findings. **Settled** after three rounds (8–10).

## Merge request: `chore/17-review-tooling` → `main`

**Scope.** Tooling only, from the backlog the user parked after the build. `scripts/review-watch.sh` runs `scripts/codex-review.sh` with stdin closed under a silence watchdog (`REVIEW_SILENCE_SECONDS`, default 600; `REVIEW_POLL_SECONDS`, default 30): after the limit without output it kills the review's own process group and exits 124; otherwise it exits with the review's status. `scripts/review-watch.test.sh` pins four cases against stand-in reviews in a scratch repository, and `scripts/ci.sh` runs it plus a check that it stops, leaving the real review script unchanged, when no scratch directory can be made. `scripts/ci.sh` sets `FALLOW_AUDIT_BASE` to its base when unset. `docs/workflow.md` points the review step at the watchdog.

**Review outcome.** Three rounds: R8-1 (a timeout's global `pkill` could kill another checkout's review), R8-2 (a review finishing silently during a poll was reported as a timeout), R9-1 (a failed `mktemp` let the test overwrite the real review script); each reproduced against the old code and fixed with a regression; round 10 clean.

**Blast radius.** Scripts and docs; no package code. `bun run ci` passed: 1429 Node tests and 48 browser specs, plus the watchdog cases.

**Not done, needs the user.** Type-checking `e2e/` and `scripts/` needs Node or Bun type definitions (a new dependency); running `check:integrations` in pre-push needs a build first. The watchdog was exercised by every round of this chore (rounds 8–10 ran through it).

## Merge request: `docs/14b-assumptions` → `main`

**Scope.** Documentation only; nothing under `packages/tscache/src/` changes. The post-build architecture review's decisions, recorded, and the two outcomes that need only documentation.

- **Decisions N34–N44** in `docs/architecture.md` §8, one row per decision point D1–D11 of `docs/architecture-review.md`, each with the alternatives it rejected: the snapshot API (N34 envelope of range-clipped segment payloads, N35 one `hydrate` engine call that refuses a differing version and fills only uncovered ranges, N36 `get(range, { snapshot: true })` plus `CacheHandle.hydrate`, N37 protocol stays 1, N38 shipped text encoders with both forms on the page, N39 migration in the same step), `tscache/vite` (N40 `fetcherUrl()` with `vite` as an optional peer, N41 `ssrPage()` stays in the examples), DC-1 (N42) and DC-2 (N43, N44).
- **DC-1 (N42).** The refresh snippet's header, its copy in the examples and `docs/guides/patterns.md` state that a refresh must issue a new access token, and what a backend that renews one in place costs: one redundant refresh per extra tab, each with the current refresh token.
- **DC-2 (N43, N44).** §4.8 states what loss detection assumes: same-origin scripts are trusted, and a stolen and released lifetime lock gives false `workerLost` events and an endless recovery loop; a fetcher must not close its worker, also stated in the fetcher contract (§2.5). `docs/guides/worker-setup.md` repeats both under its recovery example.
- **Pointers.** The agenda gains a "Decided" line, the roadmap's review section lists the outcomes with their steps (and no longer says the SSR page plugin goes into `tscache/vite`, which N41 rejects), the README points at the rows.

**Review outcome.** One round (round 7 of this file's numbering), no findings, verdict merge.

**Confidence: high** for the transcription: each row follows the agenda's recommended option and its listed alternatives, which the reviewer checked. One wording was checked against the Web Locks specification while writing: a `steal: true` request is granted ahead of the queued client requests, so the false loss fires when the thief releases the lock, not at the steal; §4.8 and the guide say so.

**Blast radius: docs and two comment headers.** `bun run ci` passed on the branch: 1137 Node tests and 48 browser specs.

**Known limits.** The decision list in the user's message was the template placeholder; the rows record "all recommended options", which every other instruction in that message matched. D6 left one point open (whether `connection.ts` keeps seeding only the first client); N39 defers it to the step ⑮ architecture text.

**For the user.** Confirm the rows match your decisions, then merge. Next: `feat/15-snapshot`, architecture text first for your approval.

## Merge request: `docs/14-architecture-review-agenda` → `main`

**Scope.** Documentation only; nothing under `packages/tscache/src/` changes. `docs/architecture-review.md` prepares the post-build architecture review: for each deferred question, the context with its sources, the decision points, the options with pros and cons, and a recommendation. `docs/roadmap.md` and the README point at it; this file gains the follow-up section.

- **Snapshot API and the seed race (R2-2).** One problem in two forms: a seed carries no version or watermark, and the coverage check and the put are two requests. Recommended: a snapshot of segment payloads clipped to the range, with the grid, schema, coverage, version and watermark (D1-A, the §3.4 invariant and the persistence sketch's cache record); one `hydrate` engine call that refuses a differing version, fills only uncovered ranges and carries the watermark forwards only (D2), dropping the snapshot's own provisional tail; `get(range, { snapshot: true })` returning the read and its snapshot from one engine state, plus `CacheHandle.hydrate` (D3-A); protocol stays 1 (D4); shipped text encoders (D5-A); both helpers and both SSR examples migrated in the same step (D6). An engine step with Codex contract tests after approved architecture text.
- **`tscache/vite` (D7, D8).** Recommended: ship `fetcherUrl()` as a subpath with `vite` as an optional peer and a programmatic-build test; `ssrPage()` stays in the examples. Rejected: a second package (starter §5).
- **DC-1 (D9).** Recommended: state the precondition in the snippet headers and the guide; the realistic case is an opaque token renewed in place, where the cost is one redundant refresh per extra tab, each with the current refresh token. A snippet-level rotation stamp is the upgrade if a backend needs it.
- **DC-2 (D10, D11).** Recommended: record both as assumptions in §4.8 and §2.5. Found while preparing: a stolen lock is never requested again by the worker, so once freed every later client is granted it at once and a recovery loop reconnects without end; a `navigator.locks.query()` check before watching is listed as the cheap guard (D10-C).
- **Not on this agenda**, listed for scheduling: N28, N31, IndexedDB persistence, the reference clients, the tooling chores. A suggested sequence with branches and model suggestions closes the document.

**Review outcome.** One round (round 6 of this file's numbering), three P2 findings, all accepted and fixed: the envelope needed its own grid and schema for gap-only snapshots; the two-call server flow has a version window on the shared client, which moved the recommendation to one `get` with a snapshot option; and DC-1's single-tab inference was wrong. Settled without a further round per the P2 rule; the fixes are not Codex-reviewed.

**Confidence: medium-high.** Every claim about the code cites the module or section it rests on and was checked by reading it (`rpc/server.ts` dispatch, `rpc/lifetime.ts`, `engine/cache.ts` version rules, `segment/payload.ts` validation, `integrations/shared/server.ts` and `connection.ts`, `integrations/react/series.tsx`). The reviewer checked the same claims and found the three above. The recommendations are judgement; the user decides them at the review.

**Blast radius: docs.** `bun run ci` passed on the branch: 1137 Node tests and 48 browser specs.

**Known limits.** No code or probe backs the snapshot-size claims (a dense payload's zeros bounded by the K-gap split) or the Vite peer-range claim (the environments API from Vite 6); both are stated from the docs and should be checked in their steps. The watchdog wrapper still lives outside the repository (backlog).

**For the user.** The review itself: decisions D1–D11, each with a recommended option. Then the sequence at the end of the agenda, starting with the DC-1/DC-2 docs commit.

## Merge request: `feat/14-integrations` → `main`

**Scope.** Step ⑭ of the commit plan (starter §7, §8, §10, §11), the last step. No change under `packages/tscache/src/` except one TSDoc paragraph.

- `integrations/`, a private workspace never published: type-checked snippets for vanilla JavaScript, React 19, Solid 2.0, Vue 3.5, Svelte 5 and Angular 22, each client-only and server-rendered with hydration. They share a framework-neutral core in `integrations/shared/`: `connection.ts` (connect once, a new client when the worker is lost, the server's seeds for the first client only, dispose), `hydration.ts` (a server's read through JSON, its covered ranges into the browser's cache), `server.ts` (one in-process client per server process) and `candles.ts` (the demo dataset). A framework folder adds only the step from a promise to its own reactivity, the surface starter §7 describes; `integrations/README.md` compares them.
- Checks: `bun run check:integrations` type-checks every snippet against the built package and runs in `bun run ci` after the build; Vitest runs the core and the vanilla snippet (28 tests) against in-process clients. Knip and Fallow know the workspace; Fallow's health gate skips the five framework folders, as it skips the examples, since nothing in CI runs them.
- Docs: `docs/roadmap.md` completed (the IndexedDB persistence sketch, sketches for dirty notifications and eviction, the reference clients' shape, the items for the post-build architecture review); `docs/guides/patterns.md` for the starter §8 debts that had no home; the integer-field caveat in `CacheConfig.fields` TSDoc; the README's guides and integrations sections. Every §8 debt now ships (table above).

**Decisions taken with the user** (2026-10-22 and 2026-10-23): the six snippets in current idioms with plain server renderers; `vue`, `svelte`, `@angular/core` and `@angular/common` (with `rxjs`) as devDependencies of the integrations workspace only; types for every snippet plus runtime tests for the core; reference clients as tested source to copy; React's server render matches its seed by cache id (R4-1).

**Review outcome.** Five rounds. Round 1: a field named `__proto__` lost in hydration (R1-1), a cache handle reused for a conflicting config (R1-2), React evicting reads that suspended renders still needed (R1-3, which also exposed a replay fault while connecting), Svelte showing an overtaken answer for a range asked again (R1-4). Round 2: React's read cache keyed by id (R2-1), the seed's check-then-put race (R2-2, escalated), a test that broke the type check (R2-3). Round 3: a config changed in place, a seed put under a conflicting config, and property order in React's key (R3-1 to R3-3). The config-equivalence area drew findings in rounds 1–3, so round 3 redesigned it instead of patching again: the snippets no longer decide whether two configs name one cache, `client.cache()` does (one message to the worker per read). Round 4's finding in that area (R4-1) went to the user, who chose matching the server's seed by id. Round 5 was clean.

**Confidence: high for the core and the vanilla snippet, medium-high for the framework snippets.** The core's tests are checked against mutants (seeding every client, ignoring the browser's coverage, no latest-wins, transferring the page's arrays, the `__proto__` assignment, seeding with the reader's config, reading before the seed). Each framework snippet was run in a throwaway probe against the built package, the server half under Node or Bun and the browser half in Chromium, with mutants that must fail it (counts in the scope section); the probes were rerun after the round 3 redesign. They live outside the repository, so CI does not repeat them. `bun run ci` passed with 1137 Node tests and 48 browser specs.

**Blast radius: tooling and docs.** `scripts/ci.sh` gains `bun run check:integrations` after the build; the root workspaces gain `integrations`; Vitest includes `integrations/test/`; Knip and Fallow gain the workspace. The new framework dependencies are confined to the private integrations workspace. The library changes by one TSDoc paragraph.

**Known limits.** A seed carries no dataset version, and the browser's coverage check and the seed's put are two requests (R2-2): either matters only when the backend changed covered history after the server's read. Not proven at runtime anywhere: a real worker loss (every probe simulated it the way the client signals it), production builds other than Solid's, Angular's ahead-of-time compiler, and the Svelte component under `svelte-check`. `resourceFromSnapshots` (Angular) is experimental in Angular 22, and Solid is a release candidate.

**For the user.**
- R2-2: closing the seed race needs a library-level put that fills only uncovered slots in one engine step, recorded with the snapshot API for the post-build architecture review. The ⑬b examples' `putSeeds` has the same race. Say if you want it sooner.
- Learning loop for R2-3 (a test that broke the type check reached a commit): no local hook type-checks `integrations/`. Smallest durable fix, on a `chore/` branch: run `bun run check:integrations` in pre-push, which needs the built package or a `paths` mapping from `tscache` to `src`. Related to backlog item 5 (type-check `e2e/` and `scripts/`).
