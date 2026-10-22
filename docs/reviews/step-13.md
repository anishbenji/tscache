# Step 13 — Examples and mock backend

Branches: `feat/13-examples` (⑬a, merged in #22: rounds 1–5, settled) and `feat/13b-ssr-examples` (⑬b: rounds from 6 on) · Reviewer: GPT-6.1 Sol (high) · Status of ⑬b: settled after 2 rounds · Verdict after triage: merge

Step ⑬ ships in two pull requests (user's choice, 2026-10-11): ⑬a, the shared mock backend and the four client-only apps (`feat/13-examples`), then ⑬b, the two SSR apps. Not an engine step: no contract tests and no change under `packages/tscache/src/`; tests are written with the code.

## Decisions taken with the user (2026-10-11)

- **Delivery.** Two pull requests, so each review stays smaller and the SSR mechanism settles on its own branch. The six apps are the locked list of starter §7 (decision #7).
- **Mock backend.** A private workspace package, `examples/mock-backend`: pure deterministic series generators and one fetch-style handler for `/api/*`, mounted by a Vite plugin on each example's dev and preview servers (one command and one origin per example). Rejected: a separate Bun server behind a Vite proxy (two processes per example); extending the e2e backend (its test gates and namespaces would leak into demo code).
- **Dependencies.** Approved for the examples' own private `package.json` files, never published: `vite` 8.3, `@vitejs/plugin-react` 6.1, `vite-plugin-solid` 3.0 (next), `solid-js` and `@solidjs/web` 2.0 RC (the user chose the release candidate over Solid 1.9; `@solidjs/web` is Solid 2.0's DOM renderer, split out of `solid-js`), `react` and `react-dom` 19.3 with their types, `uplot` 1.6.32, `lightweight-charts` 5.2.1. SSR uses plain Vite SSR with no framework.
- **SSR payload (for ⑬b).** The SSR apps hydrate through the public API only: the server reads with an in-process client, writes the covered points and their coverage ranges into the HTML as put payloads, and the browser puts each one back with its range. A snapshot API on the §3.4 segment payload is left to the architecture review the user plans after the initial build.
- **Open concerns from step ⑫.** DC-1 and DC-2 (`docs/reviews/step-12.md`, adversarial round 2) wait for that architecture review.

## Findings from the probes (before round 1)

Throwaway probes with Vite 8.3 and the built package, checked in Chromium in dev and preview:

- `import workerUrl from "tscache/worker?worker&url"` works as the worker-setup guide says, in dev and in a build.
- **The same import does not work for the fetcher module.** Vite bundles a worker entry with `preserveEntrySignatures: false`, hard-coded after the user's options, so the built fetcher chunk has no default export and the worker cannot use it. A small plugin that emits the fetcher as a chunk of its own with `preserveSignature: "strict"`, and serves it from source in dev, works in both modes. The examples use it (`fetcherUrl()` in `examples/mock-backend/src/vite.ts`), and `docs/guides/worker-setup.md` gains a section on the fetcher module with the plugin. Whether the library should ship such a plugin (a `tscache/vite` entry, say) is new public surface, so it is a candidate for the post-build architecture review, not part of this step.
- Vite loads `vite.config.ts` with Node's loader, which cannot resolve the extensionless imports of a linked TypeScript workspace package. The examples run Vite with `--configLoader runner`.
- Solid 2.0 RC builds and renders under `vite-plugin-solid` 3.0 (next) with Vite 8.3.

## Scope of ⑬a (`feat/13-examples`)

- `examples/mock-backend` (b3f77be): deterministic series (`candles`, `metrics`, `sensor`, `events`), pages of at most 5,000 slots with `meta.version`, `meta.finalizedUntil` and `next`, bearer auth with refresh-token rotation, controls (latency, version bump, token expiry) and counters; the `mockBackend()` and `fetcherUrl()` Vite plugins; the shared fetcher (page loop, no mixing of two versions, earliest watermark of all pages, `AuthInvalidError` on 401, a `BroadcastChannel` notice per fetch). Vitest covers the generators, the handler and the fetcher.
- Four apps, each a narrative README naming the decisions it demonstrates and a Playwright spec that fails when the mechanism breaks: `vanilla-uplot` (4ca4dee: volatile tail and version restatement; sparse events, coverage and pagination), `solid-uplot` (a9db664: confirmed gaps, one presence bit per point, the integer-field limitation), `solid-lwcharts` (34e60cb: scroll-back over nights and weekends, coverage subtraction), `react-lwcharts` (27b4e62: two tabs and one SharedWorker, `authInvalid` with the Web Locks refresh snippet copied from `e2e/pages/auth-refresh.js` with types added, `workerLost` recovery). Every app replaces its client on `workerLost`, as `docs/guides/worker-setup.md` shows.
- Docs (8801b18): the worker-setup guide's fetcher-module section and the README's list of examples.

Test configuration the examples need, changed in this step: the root workspaces include `examples/*`; Vitest includes `examples/*/test`; Playwright gains an `examples` project whose web servers build each app (`tsc` and `vite build`, so the apps are type-checked in `bun run ci`) and serve it with `vite preview` on its own port (`E2E_EXAMPLES` limits which apps start); Fallow takes the apps' HTML pages as entries and leaves `examples/**` out of its complexity thresholds, as it already does for tests (its CRAP estimate cannot see Playwright coverage). Knip needed only a `@public` tag on the one type that only the specs use.

The three framework apps were written by Claude subagents from a written brief, reviewed and integrated by the implementer; each was checked against mutants of the mechanism its spec covers (for example, a cache cleared before every `get`, a client never replaced after `workerLost`, every tab refreshing on `authInvalid`).

## Round 1 — reviewer verdict: merge after fixes

CI passed (1102 Node tests, 36 browser specs).

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | On the events page a slow answer to **Show the whole week** overwrites a later zoom: the reset waits on a fetch while the zoom is answered from the cache, so the reset draws last | accepted | Reproduced with a new spec, `a slow answer for the whole week does not undo a later zoom` (the zoom was undone: 9,791 empty slots shown instead of under half). Every reset fetches the slot after now, which the backend's watermark leaves uncovered, so the race needs no special timing beyond the latency. Fixed in 2894596: each load takes a ticket and only the latest draws. The other pages were checked for the same race: the vanilla metrics poll and the React polling allow one request in flight, and the Solid apps derive their data from async memos, where a newer computation supersedes an older one |

## Round 2 — reviewer verdict: merge after fixes

R1-1 confirmed fixed and covered. CI passed (1102 Node tests, 37 browser specs).

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P1 | The fetcher keeps the earliest watermark of its pages, so a later page cannot claim an earlier page's provisional points, but every fetcher test runs on a fixed clock and nothing pins it | accepted (test gap) | dd39b26: a test whose backend clock moves on by one interval after each page, so the three pages report rising watermarks; the response must keep the first. A fetcher that keeps the last page's watermark fails it (NOW + 2 min instead of NOW) |

## Round 3 — reviewer verdict: merge after fixes

R1-1 and R2-1 confirmed fixed and covered. CI passed (1103 Node tests, 37 browser specs).

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | The mock backend accepts a fractional interval such as `0.000001`; at a timestamp near 10¹², adding it leaves the value unchanged, so the page scan never ends and the example server hangs | accepted | Reproduced with a backend test (the Vitest worker ran out of memory). Fixed in 56c44b3: series queries take safe integers only, which is what tscache's grid sends; a fractional start is rejected too |

Convergence check: the mock backend drew findings in rounds 2 and 3, but on unrelated concerns (a missing test for correct code, then input validation), so no fix is leaking. Instead of waiting for another round, the implementer audited the backend's remaining inputs and fixed two more in 56c44b3: a malformed percent escape in the symbol made `decodeURIComponent` throw (the symbol now seeds its series undecoded), and a latency set through the controls was accepted as any number, so a huge value overflowed `setTimeout` and fired at once (it must now be a non-negative integer, capped at a minute). Both are covered by backend tests.

## Round 4 — reviewer verdict: merge

No findings. R1-1, R2-1 and R3-1 confirmed fixed and covered. CI passed (1103 Node tests, 37 browser specs). The review has settled; step ⑬ is not on the adversarial-review schedule.

## GitHub CI on the pull request

The first GitHub run failed at Fallow, which local runs had passed. A fresh checkout has no `packages/tscache/dist` when `bun run ci` reaches Fallow and Vitest (the build comes later), and the package's exports point into `dist/`: every `tscache` import in the examples was unresolved, and the mock backend's fetcher test, which imports the package at runtime, would have failed next. Reproduced locally by moving `dist/` aside. Fixed in e9af8d8: Fallow ignores unresolved `tscache` specifiers (`ignoreUnresolvedImports`; the examples consume the built package on purpose), and Vitest resolves `tscache` and `tscache/fetcher` to the package source, as the package's own tests do. `bun run ci` then passed in a clean worktree with `CI=1`.

Why local runs missed it: `dist/` existed locally, and once the branch was pushed, a local `fallow audit` compares against the branch's upstream rather than `main`, so the later local runs audited only unpushed changes (Fallow's documented default; `FALLOW_AUDIT_BASE` pins the base). Pinning it in `scripts/ci.sh` is a tooling change for a `chore/` branch.

## Round 5 — reviewer verdict: merge

Run over the GitHub CI fix, with `FALLOW_AUDIT_BASE=main` so the host CI audited the whole branch. No findings; R1-1 to R3-1 still fixed and covered. CI passed (1103 Node tests, 37 browser specs), and so did GitHub CI on the pull request.

## Contract-test changes

None (no contract tests in this step).

## Merge request: `feat/13-examples` → `main` (⑬a)

**Scope.** The first half of step ⑬ (starter §7 and §11): the shared mock backend and the four client-only example apps; the two SSR apps follow in ⑬b. No change under `packages/tscache/src/`.

- `examples/mock-backend`, a private workspace package: deterministic series (OHLCV in weekday sessions, server metrics with a late-arriving tail, a sensor with dropouts, sparse event counts) served in pages with a dataset version and a watermark; bearer auth with refresh-token rotation; controls for latency, restatement and token expiry; counters. Vite plugins mount it on each example's dev and preview servers and give the URL of the shared fetcher module, which loops over pages, never mixes two versions, keeps the earliest watermark and announces each fetch for the apps' counters.
- `vanilla-uplot`: live metrics over a volatile tail with version restatement; sparse events with coverage and pagination. `solid-uplot`: confirmed gaps, one presence bit per point, the integer-field limitation. `solid-lwcharts`: scroll-back over nights and weekends, fetching only the uncovered fortnight. `react-lwcharts`: two tabs on one SharedWorker, `authInvalid` with the Web Locks refresh snippet (a typed copy of `e2e/pages/auth-refresh.js`), and recovery after a lost worker. Each app is a narrative README naming the decisions it shows, and every app replaces its client on `workerLost`.
- `docs/guides/worker-setup.md` explains how to serve the fetcher module under Vite, whose `?worker&url` drops the module's default export; the README lists the examples.

**Decisions taken with the user** (2026-10-11): two pull requests for step ⑬; the backend as a workspace package mounted by a Vite plugin; the dependencies listed above, with Solid 2.0 RC; SSR hydration through the public API only (for ⑬b). DC-1 and DC-2 from step ⑫ wait for the architecture review after the initial build.

**Review outcome.** Five rounds. In the first three, each P1 accepted and fixed with a test that failed before the fix. R1-1: on the events page a slow answer for the whole week redrew over a later zoom (each load now takes a ticket). R2-1: nothing pinned the fetcher's earliest watermark across pages (new test with a moving clock, checked against a mutant). R3-1: a fractional interval hung the mock backend (queries take safe integers); a follow-up audit of the backend's other inputs fixed a malformed escape and an unbounded latency. Rounds 4 and 5 (the latter over the GitHub CI fix) were clean.

**Confidence: high.** Every app's spec asserts the mechanism it demonstrates through the backend's own fetch notices, so a broken mechanism fails it: each was run against mutants (a cache cleared before every `get`, a client never replaced after `workerLost`, every tab refreshing on `authInvalid`, a scroll that moves the start on every event). The specs also crash the SharedWorker's host tab and require the survivor to recover. The full browser suite (core and examples) passed on every run under `bun run ci`; the React spec passed 20 of 20 at five repetitions, the vanilla spec 12 of 12 at three. 1103 Node tests and 37 browser specs pass.

**Blast radius: examples and test configuration.** The root workspaces include `examples/*`; Vitest includes `examples/*/test`; Playwright gains an `examples` project whose web servers build each app (type-checking it) and serve it with `vite preview`, which adds four Vite builds to the Playwright step of `bun run ci`; Fallow takes the apps' HTML pages as entries and keeps `examples/**` out of its complexity thresholds, as it does for tests.

**GitHub CI fix after the review settled.** The first GitHub run failed at Fallow because a fresh checkout has no `dist/` before the build step, so the examples' `tscache` imports did not resolve; Fallow now ignores those specifiers and Vitest resolves the package to its source (e9af8d8). Round 5 reviewed it: no findings.

**Known limits.** A `get` that ends at now always fetches the slot after now, which the backend's watermark leaves uncovered; the READMEs explain it. Each app's specs share that app's in-memory backend, so they run serially and cannot be repeated in parallel. `e2e/` and `scripts/` are still not type-checked by `bun run ci`, and a local `fallow audit` on a pushed branch compares against its upstream, not `main` (both tooling changes for a `chore/` branch). The Vite fetcher plugin lives in the examples; whether the library should ship one is for the architecture review. Solid is pinned to 2.0.0-rc.14 until 2.0 ships.

# Step ⑬b — SSR examples (`feat/13b-ssr-examples`)

The second half of step ⑬: `react-ssr` and `solid-ssr`, the server-rendered apps of starter §7. The rounds continue this file's numbering (round 6 is ⑬b's first); the cap of ten rounds counts ⑬b's own.

## Decisions taken with the user (2026-10-22)

- **Scenarios.** `react-ssr` charts ACME daily candles in Lightweight Charts, with scroll-back; `solid-ssr` charts the greenhouse sensor, with its dropouts and offline blocks, in uPlot. Two datasets for two coverage stories: the provisional tail (today's forming bar) and confirmed gaps travelling with the coverage. Rejected: candles in both (the Solid app would teach nothing new); candles and live metrics.
- **Server client lifetime.** One in-process client per server process, shared by every render: a later render fetches only the provisional tail, and concurrent renders share one fetch. It fits public data only, since a per-user cache would leak between users, and tscache v1 has no eviction; both READMEs say so. Rejected: a client per request (stateless and safe for per-user data, but every render refetches its window); one of each.
- **Dependencies.** None new.
- **Roadmap.** The user asked for reference clients in vanilla JavaScript and React on the roadmap, alongside Solid, held to reference quality (best practices, high performance, idiomatic, clean). Recorded in `docs/roadmap.md` (962f067), which this branch starts; step ⑭ completes it. The implementer read "client" as a complete, tested integration for each platform, beyond step ⑭'s snippets, and flagged that reading to the user.

## Findings from the probes (before round 6)

Throwaway probes outside the repository, with Vite 8.3.4, React 19.3, Solid 2.0.0-rc.14 and the built package, checked in Chromium in dev and in preview:

- Plain Vite SSR works for both frameworks with an in-process client on the server: the server's client fetches from its own origin, the page carries the seeds, and the browser, after putting them, fetches only the provisional slot.
- **Vite's config runner and request-time imports.** The examples load `vite.config.ts` with `--configLoader runner`, which closes its module runner once the config is loaded. A plugin's `import()` at request time then fails ("Vite module runner has been closed"). The preview server loads the built server entry with `require()` of an ES module instead (Node 22.12 and later). In dev, the SSR environment's own runner (`server.environments.ssr.runner.import`) loads it.
- **The fetcher's URL on the server.** In a server build, Vite renders an emitted chunk's `import.meta.ROLLUP_FILE_URL_*` as a path under `base` (`/assets/fetcher-….js`), which Node cannot import. A `resolveFileUrl` hook for the server environment makes it `new URL("./assets/…", import.meta.url).href`. In dev the browser's `/@fs/` path works on the server too, because the module runner processes tscache and resolves its `import()`.
- **The fetcher's origin on the server.** The shared fetcher requests relative paths, which a server-side `fetch` cannot resolve. The context gains `origin`, which the SSR plugin takes from the server's own resolved address, never from the request's `Host` header (which the client controls).
- `vite build --app`, with an output directory per environment, builds `dist/client` and `dist/server` in one command. `appType: "custom"` turns off the SPA fallback, so unknown paths, and `dist/server`, answer 404 on the preview server.

## Scope of ⑬b

- `examples/mock-backend` (3de4cd0): the fetcher's `origin`; `fetcherUrl()` gives server code a file URL; `ssrPage({ entry })` renders `/` with the app's server entry on `vite` and `vite preview` and configures `vite build --app`; `@examples/mock-backend/hydration` with `dehydrate`, `hydrationScript`/`readHydration`, `jsonScript`/`readJson` and `putSeeds`. Two choices of the implementer: seeds carry base64 of the typed arrays, so NaN, −0 and ±Infinity survive (JSON would turn NaN into null); and `putSeeds` puts a seed only where the browser's cache does not cover it yet, because with a SharedWorker another tab may hold the range from a later fetch than the server's, and a seed carries no version that would let the cache notice. Vitest covers the round trip into a real in-process client, gaps travelling with coverage, the provisional tail staying out, and a cache that already covers part of a seed; two mutants (seeds that overwrite covered ranges, seeds that include the tail) fail it.
- `react-ssr` (c4189ff) and `solid-ssr` (ecc4b2b): each a narrative README and a Playwright spec. Both specs check the page without JavaScript; that the browser fetches only what the seeds do not cover; that a later render reads from the server's cache; loading older history; and recovery when the worker's host tab crashes. Checked against mutants: no `putSeeds` in the browser, a server client per render, and for React a hydration mismatch and a scroll-back that moves the start on every event.
- Docs (this commit): the worker-setup guide's section on server rendering, the README's list of examples and a link to the roadmap.
- Configuration: ports 5105 and 5106 in `e2e/examples/apps.ts`; the server entries as entry points for Knip and Fallow, since only the Vite config names them.

The two apps were written by Claude subagents (Opus 5.5) from a written brief, one per app, and reviewed by the implementer. Each subagent also had its own reviewer. The Solid builder's reviewer reported after the builder had finished, so the implementer validated and fixed its findings: a spec that assumed coverage ends at the render's minute, when a minute boundary between the server's clock read and the backend's moves it one minute on (rare; the check now allows both); a crash test whose survivor's own earlier fetch notice could stand in for the fetch after the crash; a page-count check that could not tell the two server designs apart (one page either way), replaced by the readings the second render fetched; README claims about which minute is provisional and what changes at the switch to the live panel; an unhandled rejection in the dev reload hook; server-side misses dropped silently (both servers now warn on any miss other than the expected `uncached` tail); and an error boundary that replaced the server's figures with one line. The implementer also linked each app's stylesheet from its `index.html`, which removes an unstyled flash of the server-rendered page in dev.

## Round 6 (⑬b round 1) — reviewer verdict: block

CI passed (1109 Node tests, 48 browser specs).

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R6-1 | P0 | After a lost worker, the Solid session put the page's seeds into the new worker's empty cache. If the page had meanwhile fetched a restated history (v2), the new worker adopts v2 with its first fetch and keeps the unversioned v1 seeds as covered (N18) | accepted | Reproduced as a spec change first: the crash test now requires the new client to fetch the whole window, and it failed against the re-seeding session (no such fetch). Fixed in 2312b9d: only the first client gets the seeds, as in `react-ssr`; the README says why. The first seeding keeps the documented limit (a seed carries no version), whose window is the time from the server's read to the browser's put, not the page's lifetime |
| R6-2 | P1 | The React spec expects coverage to end the day before the render's day; when midnight UTC passes between the render's clock read and the backend's, the newly final day is covered too | accepted | Confirmed by tracing both clocks (`entry-server.tsx` reads `Date.now()`, the backend reads its own later; its watermark follows its clock). The same class as the minute-boundary flake the implementer fixed in the Solid spec before round 6. Fixed in 8f5d15a: the provisional day is the one after the last seeded day, which may be the render's day or the next; the bar counts that midnight can move by one day allow that one day. The implementer audited the other clock-dependent assertions of both specs and found none that a boundary can break |
| R6-3 | P2 | The Solid README says a put without a range would leave each dropout looking unfetched; a put without a range covers its own span, interior gaps included (N3) | accepted | Correct per architecture §2.4 (N3). Both READMEs (the React one made the same claim about weekends) now say the range matters at the edges: an empty start or end of the window, or a seed with no point (2312b9d, e1d8011) |

After the fixes both SSR specs passed 33 of 33 (three repetitions). One earlier run had a single failure, the React drag test timing out after 7.7 minutes while the machine's load average was about 146 from other work; at normal load it passed every run.

## Round 7 (⑬b round 2) — reviewer verdict: merge

No findings. R6-1 to R6-3 confirmed fixed. CI passed (1109 Node tests, 48 browser specs). The review of ⑬b has settled; step ⑬ is not on the adversarial-review schedule.

## Merge request: `feat/13b-ssr-examples` → `main` (⑬b)

**Scope.** The second half of step ⑬ (starter §7 and §11): the two server-rendered example apps, and what they share. No change under `packages/tscache/src/`.

- `examples/mock-backend`: the fetcher takes the backend's `origin` in its context, since a server has no page origin; `fetcherUrl()` gives server code a file URL of the fetcher chunk; `ssrPage({ entry })` renders `/` with an app's server entry on `vite` and `vite preview`, and builds browser and server with `vite build --app`; `@examples/mock-backend/hydration` turns a server's `get` result into seeds (each covered range with its points, as base64 of the typed arrays, so NaN survives) and puts them into the browser's cache with their ranges, only where that cache does not cover them yet.
- `react-ssr`: ACME daily candles, read on the server and rendered with `renderToString`; the browser hydrates, puts the seeds and fetches only the provisional day; Lightweight Charts loads after hydration; scroll-back fetches only the uncovered older half-year. `solid-ssr`: the greenhouse sensor with Solid 2.0; the confirmed gaps travel with the coverage, so the browser knows the empty minutes without fetching them; uPlot draws the readings as the cache returns them. In both, one in-process client per server process serves every render, the page works without JavaScript, and a lost worker is replaced by a new client that fetches its window.
- Docs: a server-rendering section in `docs/guides/worker-setup.md`; the README lists the two apps; `docs/roadmap.md` is started, with the reference clients the user asked for.

**Decisions taken with the user** (2026-10-22): candles for React and the sensor for Solid; one server client per process, shared by every render (public data only, no eviction in v1); no new dependencies; reference clients in vanilla JavaScript, React and Solid on the roadmap.

**Review outcome.** Two rounds. Round 6: R6-1 (P0), after a lost worker the Solid page seeded the new worker again, which could revive history from before a restatement the page had since fetched; only the first client is seeded now, and the crash test, which failed against the old session, requires a full refetch. R6-2 (P1), the React spec assumed the render's day is the backend's, which midnight UTC can break; it now reads the provisional day from the seeds. R6-3 (P2), both READMEs overstated what a put's range adds. Round 7 was clean.

**Confidence: high.** Each spec is checked against mutants that fail it: no seeds put in the browser, a server client per render, a hydration mismatch (React), a scroll-back that asks again on every event (React), and re-seeding after a lost worker (Solid). The hydration module's Vitest suite fails against seeds that overwrite covered ranges and against seeds that include the provisional tail. Both SSR specs passed 33 of 33 at three repetitions; `bun run ci` passed with 1109 Node tests and 48 browser specs.

**Blast radius: examples and configuration.** Knip gains a workspace entry per SSR app and Fallow an entry pattern for their server entries, which only the Vite config names. Playwright's `examples` project builds and serves two more apps (ports 5105 and 5106), which adds two builds to the browser step of `bun run ci`.

**Known limits.** A seed carries no dataset version, because the public `get` result does not report one: a restatement between the server's read and the browser's put goes unnoticed for the seeded ranges (the READMEs say so). The preview plugin loads the built server entry with `require()` of an ES module (Node 22.12 or later, the repository's minimum), because Vite's config runner is closed by the time a request arrives; in dev, the server entry disposes its client on `vite:beforeFullReload`, since Vite's module runner calls no dispose hook on a reload. Solid is pinned to 2.0.0-rc.14.

**For the post-build architecture review.** A snapshot API over the segment payload (§3.4) that carries the dataset version and watermark would close the seed-version gap and make hydration exact. The two Vite plugins the examples need (`fetcherUrl`, now with server file URLs, and the SSR page plugin) are candidates for a `tscache/vite` entry.

**For the user.** The roadmap entry reads "client" as a complete, tested integration for each platform (vanilla JavaScript, React and Solid), beyond step ⑭'s type-checked snippets; whether they ship as packages or as source to copy is left open there.
