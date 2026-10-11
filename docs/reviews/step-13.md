# Step 13 — Examples and mock backend

Branch: `feat/13-examples` (⑬a) · Reviewer: GPT-6.1 Sol (high) · Rounds: 4 · Status: settled · Verdict after triage: merge

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

## Contract-test changes

None (no contract tests in this step).

## Merge request: `feat/13-examples` → `main` (⑬a)

**Scope.** The first half of step ⑬ (starter §7 and §11): the shared mock backend and the four client-only example apps; the two SSR apps follow in ⑬b. No change under `packages/tscache/src/`.

- `examples/mock-backend`, a private workspace package: deterministic series (OHLCV in weekday sessions, server metrics with a late-arriving tail, a sensor with dropouts, sparse event counts) served in pages with a dataset version and a watermark; bearer auth with refresh-token rotation; controls for latency, restatement and token expiry; counters. Vite plugins mount it on each example's dev and preview servers and give the URL of the shared fetcher module, which loops over pages, never mixes two versions, keeps the earliest watermark and announces each fetch for the apps' counters.
- `vanilla-uplot`: live metrics over a volatile tail with version restatement; sparse events with coverage and pagination. `solid-uplot`: confirmed gaps, one presence bit per point, the integer-field limitation. `solid-lwcharts`: scroll-back over nights and weekends, fetching only the uncovered fortnight. `react-lwcharts`: two tabs on one SharedWorker, `authInvalid` with the Web Locks refresh snippet (a typed copy of `e2e/pages/auth-refresh.js`), and recovery after a lost worker. Each app is a narrative README naming the decisions it shows, and every app replaces its client on `workerLost`.
- `docs/guides/worker-setup.md` explains how to serve the fetcher module under Vite, whose `?worker&url` drops the module's default export; the README lists the examples.

**Decisions taken with the user** (2026-10-11): two pull requests for step ⑬; the backend as a workspace package mounted by a Vite plugin; the dependencies listed above, with Solid 2.0 RC; SSR hydration through the public API only (for ⑬b). DC-1 and DC-2 from step ⑫ wait for the architecture review after the initial build.

**Review outcome.** Four rounds, each P1 accepted and fixed with a test that failed before the fix. R1-1: on the events page a slow answer for the whole week redrew over a later zoom (each load now takes a ticket). R2-1: nothing pinned the fetcher's earliest watermark across pages (new test with a moving clock, checked against a mutant). R3-1: a fractional interval hung the mock backend (queries take safe integers); a follow-up audit of the backend's other inputs fixed a malformed escape and an unbounded latency. Round 4 was clean.

**Confidence: high.** Every app's spec asserts the mechanism it demonstrates through the backend's own fetch notices, so a broken mechanism fails it: each was run against mutants (a cache cleared before every `get`, a client never replaced after `workerLost`, every tab refreshing on `authInvalid`, a scroll that moves the start on every event). The specs also crash the SharedWorker's host tab and require the survivor to recover. The full browser suite (core and examples) passed on every run under `bun run ci`; the React spec passed 20 of 20 at five repetitions, the vanilla spec 12 of 12 at three. 1103 Node tests and 37 browser specs pass.

**Blast radius: examples and test configuration.** The root workspaces include `examples/*`; Vitest includes `examples/*/test`; Playwright gains an `examples` project whose web servers build each app (type-checking it) and serve it with `vite preview`, which adds four Vite builds to the Playwright step of `bun run ci`; Fallow takes the apps' HTML pages as entries and keeps `examples/**` out of its complexity thresholds, as it does for tests.

**Known limits.** A `get` that ends at now always fetches the slot after now, which the backend's watermark leaves uncovered; the READMEs explain it. Each app's specs share that app's in-memory backend, so they run serially and cannot be repeated in parallel. `e2e/` and `scripts/` are still not type-checked by `bun run ci` (backlog). The Vite fetcher plugin lives in the examples; whether the library should ship one is for the architecture review. Solid is pinned to 2.0.0-rc.14 until 2.0 ships.
