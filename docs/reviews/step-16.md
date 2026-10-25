# Step 16 — `tscache/vite` entry

Branch: `feat/16-vite-entry` · Reviewer: GPT-6.1 Sol (high) · Rounds: 4 · Status: settled except R3-1, escalated to the user · Verdict after triage: merge after the user decides R3-1

Item 2 of the post-build architecture review (`docs/architecture-review.md`; decisions N40–N41). Not an engine step: tests are written with the code.

## Scope

| Commit | What |
|---|---|
| b7ce23a | `feat(vite)`: `src/vite/fetcher-url.ts` and the `./vite` entry exporting `fetcherUrl()` and its `FetcherUrlPlugin` type; `vite ^8.0.0` as an optional peer dependency and `^8.3.4` as a dev dependency (the version the examples already use); the tsdown entry; `test/vite-fetcher-url.test.ts` runs real client, server and dev builds; Knip and Fallow configuration; architecture §4 layout and export list |
| 24b624c | `refactor(examples)`: every example imports `fetcherUrl` from `tscache/vite`; the mock backend's copy goes |
| affb818 | `docs(guides)`: `docs/guides/worker-setup.md` replaces the forty-five-line copy with the import; roadmap pointer |

## Points for the user

| # | Point | Done (recommended) | Alternatives |
|---|---|---|---|
| V1 | Supported Vite range (N40 left it to this step) | `^8.0.0`: the one major the test and the examples build with. Widening later is not breaking | `^6.0.0 \|\| ^7.0.0 \|\| ^8.0.0`, since the environments API the plugin uses exists from Vite 6, but nothing here tests 6 or 7 |
| V2 | How the plugin is typed | A structural type (`FetcherUrlPlugin`) declaring the hooks and context members it uses; nothing imported from `vite`. Vite's types reference Node's, so importing them would put Node globals into the package's type check and let Node APIs into the browser library unnoticed (the guard `batch-realms.test.ts` relies on). The examples' type check of their `vite.config.ts` against Vite's real `Plugin` type proves the fit, and `dist/vite.d.ts` references neither Vite nor Node | Import `type { Plugin } from "vite"`: exact types for users, but Node types throughout `src/` and `test/` |
| V3 | Build platform | Withdrawn after round 1 (R1-1): the entry now has its own `platform: "node"` tsdown config, as N40 states | — |

## Round 1 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | The entry shares the browser-platform build, where N40 says a Node-platform entry, without recorded approval | accepted | Validated against the N40 row. Rather than ask for the deviation, the build now has a second tsdown config with `platform: "node"` and plain `.js` output for `./vite`; tsdown cleans `dist/` once for both configs before either writes (checked in its source) |
| R1-2 | P1 | In dev, the URL ignores Vite's `base`, so a normal dev server under `/app/` answers 404 | accepted | Reproduced with a real dev server under `/app/` that requests the URL over HTTP (the earlier test used middleware mode, which bypasses the base check). The browser now gets `<base>@fs/<path>` |
| R1-3 | P1 | A Windows path `C:/…` gives `/@fsC:/…` | accepted | Validated by reading; `devUrl(base, file)` now builds the URL with exactly one slash before the path, with unit cases for POSIX and drive paths |
| R1-4 | P1 | An installed `tscache` is externalized in dev SSR, so its `import()` of the `/@fs/` URL runs in plain Node and fails | accepted | Reproduced with a stand-in `node_modules/tscache` whose `import()` loads the fetcher under `ssrLoadModule`: "Cannot find module '/@fs/…'". The plugin's `config` hook now adds `tscache` to `ssr.noExternal`, so the import goes through Vite's module runner; server code keeps the `/@fs/` path without the base, which the runner resolves. The guide says so |

Commit note: the Node-platform tsdown config of R1-1 landed in the round 1 triage commit (99a6f21) rather than its own, because its own commit was refused by commitlint and the file stayed staged. The branch was already under review, so the history was left as it is.

## Round 2 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P1 | A literal `%` in the checkout path breaks the dev URL: `/repo/a%20b` is requested as `/repo/a b` | accepted; area redesigned | Reproduced with the fetcher in a directory named `lib %41`. **Convergence check:** dev-URL construction drew findings in rounds 1 and 2, so the area was redesigned rather than patched. Delegating to Vite's own `?url` import was tried first and failed: Vite turns `lib %41` into `lib%20A`. Probes then fixed the design on evidence: Vite's module middleware decodes with `decodeURI`, so the browser gets `<base>@fs/` + `encodeURI(path)`, its exact inverse; Vite's module runner does not decode at all, so server code gets the plain absolute path (also free of the Windows `/@fs` slash). The virtual module's id no longer embeds the path either: Vite puts ids into URLs unencoded and decodes the request, which failed with a 500 for the same directory. The test now keeps the fetcher outside the app's root in that directory and checks the URL and its fetch over a real dev server under a base, the runner's load, and the installed-package case. A path holding `#` or `?` cannot be served by Vite's middleware at all; the code says so |

Observed while verifying: one CI run timed out an unrelated heavy test (`merge-failures.test.ts`, 5 s) while the new Vite builds ran in the same Vitest pool; the rerun passed. Recorded as a load risk, not changed.

## Round 3 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | An `import()` inside the fetcher's graph of code the app shares gets Vite's module-preload helper, which reads `document` and throws in the worker | accepted in part; **escalated** | Reproduced with a build whose fetcher dynamically imports a module sharing a dependency with the app: the fetcher chunk carries the helper, which queries `document` whenever the import's dependency list is non-empty. A full fix changes how Vite preloads, so it is a decision for the user (below). Meanwhile the limit and its workaround (`build.modulePreload: false`, which Vite's source shows empties the non-CSS dependencies) are stated in the plugin's TSDoc and the guide |
| R3-2 | P1 | A server build's file URL is not encoded: an assets directory `assets %41` or one holding `#` breaks the import | accepted; area redesigned | Reproduced with `assetsDir: "assets %41 #1"`. **Convergence check:** URL encoding drew findings in rounds 1, 2 and 3, so every URL the plugin builds now lives in one module, `src/vite/urls.ts`, each encoded as the exact inverse of what decodes it: the dev URL with `encodeURI` (Vite's middleware applies `decodeURI`), the server file URL with `encodeURIComponent` per segment (the URL parser and Node decode every escape), keeping Rolldown's hash placeholders, which the first attempt encoded and broke. The server-build test now imports through a `node` child process, since Vitest's own `import()` does not decode file URLs as Node does |

### Escalated: R3-1, the fetcher's dynamic imports in a worker

| Option | What | Pros | Cons |
|---|---|---|---|
| A. Document the limit (done) | TSDoc and guide: keep the fetcher's dynamic imports to its own code, or set `build.modulePreload: false` | Nothing more to build; the common fetcher has no dynamic import | A trap for a fetcher that lazily loads a shared decoder; the workaround turns preloading off for the whole app |
| B. Empty the preload list for chunks the worker runs (recommended) | The plugin wraps `build.modulePreload.resolveDependencies` (and any the app set) to return `[]` for imports hosted in the fetcher chunk and the chunks it reaches | Exact, automatic, the app keeps preloading elsewhere | Relies on a Vite hook's call order in the bundle step; a chunk shared by page and worker loses preloading for its own dynamic imports |
| C. Build the fetcher separately, as Vite builds workers | A second bundle for the fetcher graph, exports kept | Worker code fully isolated from page helpers | Duplicates shared code; much more plugin machinery |

## Round 4 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R4-1 | P1 | R3-1 is still open: documenting the workaround does not fix it | escalated (re-raises R3-1) | Correct: it stays open until the user picks an option in the table above. No other finding; the reviewer confirmed every other accepted fix. The loop stops here as step ⑭ did with R2-2: the remaining finding needs a decision, not another patch |

## Contract-test changes

None: not an engine step.

## Decision concerns

None yet.

## Correction after round 6 on #30 (2026-10-23)

Round 6 on the option B branch showed that the workaround this PR documented, `build.modulePreload: false`, is wrong: Vite still wraps every bundled `import()` in its preload helper, whose failure path calls `window.dispatchEvent`, so in a worker a failing lazy import throws a `ReferenceError` instead of its own error. Checked in built output with and without the setting. The plugin's TSDoc and the guide now say to import the fetcher's dependencies statically, and no longer offer the setting as a fix.

## After the review: GitHub CI on a fresh checkout

The first GitHub run failed at Knip: it loads each example's `vite.config.ts`, which now imports `tscache/vite` from `dist/`, and a fresh checkout has no `dist/` before the build (local runs always had one). Reproduced locally by deleting `dist/`. `scripts/ci.sh` now builds the package before Knip; the full gate passes from a deleted `dist/`. Not Codex-reviewed: a reordering of existing steps.

## Merge request: `feat/16-vite-entry` → `main`

**Scope.** Item 2 of the post-build architecture review (N40–N41): `tscache/vite` exports `fetcherUrl()`, so an app writes `import url from "./fetcher.ts?fetcher"` and gets the fetcher's URL with its default export intact; `vite ^8.0.0` is an optional peer dependency. The examples import it and drop their copy; the guide replaces its forty-five-line copy with the import.

**Open: R3-1, escalated.** A fetcher whose `import()` loads code the app also uses gets Vite's preload helper, which reads `document` in the worker. The limit and a workaround are documented; the fix is the user's decision (options in the round 3 section, B recommended). Merging now ships the documented limit; option B would follow as a small change with a worker-execution test.

**Design, after four rounds.** The plugin declares the Vite shapes it uses instead of importing Vite's types, which would bring Node's into the browser library's type check (V2). The entry has its own `platform: "node"` build, as N40 states (R1-1). Every URL it builds lives in `src/vite/urls.ts`, each encoded as the inverse of what decodes it (redesigned at the convergence check after rounds 1–3): the browser's dev URL under the base with `encodeURI`, server code's dev path as an absolute path, the server build's file URL encoded per segment with Rolldown's hash placeholders kept. Virtual ids carry a number, not a path. The plugin adds `tscache` to `ssr.noExternal`, so an installed package's `import()` of the fetcher goes through Vite's module runner in dev.

**Tests.** Real Vite builds and servers: a client build under a base, a server build with an assets directory holding `%`, a space and `#` imported by plain Node, a dev server under a base fetching the URL over HTTP with the fetcher outside the root in a directory named `lib %41`, the module runner's load, and a stand-in installed `tscache`. Unit cases for both URL encoders. `bun run ci` passed: 1444 Node tests and 48 browser specs, every example built with the new import.

**For the user.** V1: the peer range `^8.0.0` (only the tested major). V2: structural typing instead of Vite's types. R3-1: pick A, B or C. Known limits: a path holding `#` or `?` cannot be served by Vite's dev middleware at all; one CI run timed out an unrelated heavy test while Vite builds shared the Vitest pool (rerun passed). Commit note: the Node build config landed in a triage commit (99a6f21) after a commitlint refusal.

## Follow-up: enforce static imports in the fetcher (`feat/16c-static-fetcher-imports`)

**Decision (user, 2026-10-23).** Of the options after round 6 on #30 (closed), the user chose option 1: enforce static imports for now, and add a lower-priority backlog item to check whether a better option than relying on Vite exists for the fetcher. Option B (emptying preload lists) is dropped: it left Vite's wrapper and its `window.dispatchEvent` failure path in the worker (R6-1).

**Change.** `fetcherUrl()`'s `generateBundle` walks from each fetcher chunk through every chunk it reaches and fails the build if one carries Vite's preload helper, recognised by its `vite:preloadError` event name, which survives minification whether the helper is inlined into the fetcher chunk or emitted as a chunk of its own. The error names the fetcher and the chunk holding the helper and says to import statically. Tests build two apps whose fetcher uses `import()`, one where the lazy module shares code with the page (helper in its own chunk) and one where it does not (helper inlined); both builds are refused, and the existing static fetchers still build. The guide and the plugin's TSDoc say so.

**Round 7 — reviewer verdict: merge.** No findings; the reviewer confirmed the earlier accepted findings stay fixed under the recorded decision. `bun run ci` passed: 1446 Node tests and 48 browser specs. (Rounds 5 and 6 ran on the closed option B branch, #30.)

**Merge request: `feat/16c-static-fetcher-imports` → `main`.** One commit, the change above, settled in one clean round. Known limit, not verified: the check is conservative. It refuses any build in which a chunk the fetcher reaches carries the helper, so if Rolldown ever merged the helper into a shared chunk that the fetcher loads but never calls, a working build would be refused. No such build was seen. The open follow-up is the backlog item to look for a better option than relying on Vite for the fetcher.

## Follow-up: fetchers that need `import()` (`docs/23-fetcher-prebuild`)

**Question (backlog, user 2026-10-23).** Is there a better option for fetcher authors than the static-import rule `fetcherUrl()` enforces?

**Findings.** Vite 8.3.4 adds its preload helper only to an app's client build: `getInsertPreload` is `consumer === "client" && !config.isWorker && !config.build.lib` (`dist/node/chunks/node.js`). Worker bundles drop the entry's exports (`preserveEntrySignatures: false`), which is why `?worker&url` cannot serve a fetcher. Probes, each with a fetcher that lazily imports a decoder and throws `AuthInvalidError`:
- A Vite library-mode build keeps the default export, splits the decoder into its own chunk, and contains no helper.
- `bun build --splitting` keeps the export too. Its own preload code touches `document` only when it exists, so it is worker-safe.
- Both outputs run in Node, with no `document`: the lazy chunk loads, and the auth error keeps its `code`.
- A worker entry owned by the app, which imports the fetcher statically and is built through `?worker&url`, also carries no helper.

**Options put to the user.** A, keep the rule. B, a nested library-mode build inside `fetcherUrl()`. C, document building the fetcher on its own. D, a worker entry owned by the app: this would also remove webpack's copy step, but it changes the locked §2.5 contract, so it belongs on the architecture review.

**Decision (user, 2026-10-26).** Keep the rule and document C. The rule's cost is small: a decoder imported statically grows only the worker's fetcher, not the page.

**Change.** `docs/guides/worker-setup.md` gains "Building the fetcher on its own", with the Bun and Vite library-mode commands and the trade-offs: a separate rebuild step with no HMR, the app's aliases and defines not applied, and no content hash in the file name. The build error and the plugin's TSDoc now point to that section. The R3-1 test's pattern also requires the pointer: it fails against the old message and passes against the new one.

### Round 8 — reviewer verdict: merge after fixes

| ID | Sev | Finding | Triage | Evidence |
|---|---|---|---|---|
| R8-1 | P1 | The Vite recipe's `fileName: "fetcher"` emits `fetcher.mjs` outside a `"type": "module"` package, so the URL shown 404s | accepted | Reproduced: a library build in a package without `"type": "module"` emits `fetcher.mjs`, and with `fileName: () => "fetcher.js"` it emits `fetcher.js`. My earlier probe ran inside a module package. The recipe now uses the function. Lazy chunks stay `.mjs`, which the entry imports by relative path. |
| R8-2 | P1 | The URL `/fetcher/fetcher.js` ignores Vite's `base`, so an app under `/app/` gets a 404 | accepted | Vite serves `public/` under `base`. The example now builds the URL from `import.meta.env.BASE_URL`. |
| — | — | (found while fixing R8-1) The recipe's `outDir` lies inside `public/`, which Vite copies into `outDir` | fixed | Reproduced: without `publicDir: false`, `public/favicon.txt` lands in `public/fetcher/`, and Vite warns that the folders overlap. The recipe sets `publicDir: false`. |

Not taken: the suggested regression tests. The recipe exercises Vite's library build, not tscache code. Each point was checked by building it with Vite 8.3.4, as above.

### Round 9 — reviewer verdict: merge after fixes

| ID | Sev | Finding | Triage | Evidence |
|---|---|---|---|---|
| R9-1 | P1 | With a relative Vite `base` (`"./"` or `""`), `BASE_URL` is relative, and the worker resolves it against its own script (`/app/assets/`), not the page | accepted | Confirmed in the source: the client sends `fetcher.module` as an unresolved string (`client/client.ts`), and the worker `import()`s it (`orchestrator/orchestrator.ts`). For a page at `/app/index.html` and a worker at `/app/assets/worker-1.js`, `"./fetcher/fetcher.js"` resolves to `/app/assets/fetcher/fetcher.js` in the worker and to `/app/fetcher/fetcher.js` against the page. With `"/app/"` both give `/app/fetcher/fetcher.js`. The recipe now resolves the URL against `document.baseURI`, and the guide's fetcher section says to pass an absolute URL or path. |

**Convergence check.** R8-2 and R9-1 hit the same area, the recipe's URL, in consecutive rounds. Redesigned in the docs: the URL is resolved against the page, which is correct for every base form (absolute, relative, empty), so no form is left to patch. The root cause sits in the library: a relative `fetcher.module` resolves against the worker, which nobody expects. Making the client resolve it against the page before sending changes behaviour §2.1 documents ("the worker will dynamic-import()"), so it is **escalated to the user** rather than done here.

### Round 10 — reviewer verdict: merge after fixes

| ID | Sev | Finding | Triage | Evidence |
|---|---|---|---|---|
| R10-1 | P1 | Re-raises R9-1: with a relative `base`, resolving against the page breaks for a page in a subfolder (`/app/nested/index.html` gives `/app/nested/fetcher/fetcher.js`) | accepted; recipe narrowed | Correct: a relative `base` does not say where the app's root is, so no URL built from `BASE_URL` at runtime finds `public/` from every page. |

**Convergence check, third round in this area (R8-2, R9-1, R10-1).** I stopped patching the URL. The recipe now claims only what holds: with an absolute `base`, the path is `${BASE_URL}fetcher/fetcher.js`. With a relative `base`, the guide says why no derived URL works and has the app give the deployed path itself, for example from an environment variable. The `document.baseURI` resolution from round 9 is gone.

This also weakens the case for the library change the user approved after round 9. Resolving a relative `fetcher.module` against the page would make it behave like other web APIs, but it would not fix the relative-`base` case either. Raised with the user again.
