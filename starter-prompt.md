# Starter Prompt — Browser Time-Series Cache Library

> Paste this entire document as the opening prompt in your implementation environment (e.g., Claude Code). It encodes a completed design session: every architectural decision below is **locked** and must not be relitigated silently. A short list of **open decisions** remains; resolve those with me before touching related code.

---

## 1. Mission

You are building **`tscache`** (working name — see Open Decisions): a high-performance, open-source TypeScript library that caches time-series data in the browser, hosted in a **SharedWorker → dedicated Worker → main-thread** fallback chain, with worker-side fetch orchestration, non-contiguous range management, and real-gap awareness.

Primary use cases: financial candles (OHLCV), live server metrics, IoT telemetry, sparse event counts — anything timestamp-aligned. Multi-tab cache sharing and fetch deduplication via SharedWorker is the headline feature.

## 2. Working Process — non-negotiable

1. **Never implement without sign-off.** Architecture, API surfaces, data structures, and approaches are reviewed with me first. Your **first deliverable** (§12) is a document, not code.
2. **Grill me.** When anything is ambiguous, ask until it isn't. Prefer one focused round of questions over assumptions.
3. **Propose alternatives** for any new decision point — multiple approaches with pros/cons. I make the final call.
4. **Code quality:** terse, focused, no unnecessary verbosity. Small functions, small files, small modules. TSDoc on public API. TypeScript strict. Document *why*, not *what*.
5. **Commits:** small, human-reviewable, Conventional Commits style. Build features over multiple commits per the plan in §11. Every commit-sized unit leaves the repo green (`bun run ci` passes).
6. **Local-only development for now:** no GitHub remote, no GitHub Actions. Quality gates live in Lefthook hooks and a local `bun run ci` script (written so it can later become the CI workflow body verbatim).

## 3. Locked Architecture — Decision Register

### 3.1 Data model

- A **cache** is identified by a consumer-chosen string ID. **Interval** (ms) is per-cache config; it defines the minimal gap between adjacent points. Aggregation/resampling across intervals is **out of scope** (roadmap §10); a series at 1m and the same series at 1h are two caches.
- **Timestamps:** Float64 ms epoch (exact integers to 2^53). Must be **aligned to the interval**; misaligned timestamps in a `put` → **atomic reject** of the whole batch with a descriptive error (first offender, expected alignment). Same atomic-reject for unsorted or duplicate timestamps — input must be sorted ascending.
- **Schema:** fields declared at cache creation with per-field dtype. `f64` default; `f32`, `i32`, `u32`, etc. supported. Timestamps are always f64 (derived in dense segments, stored in columnar).
- **Presence is point-level:** 1 bit per point (not per field), filled from whether the timestamp exists in the ingested data. Consequences: **NaN is a legal field value** (e.g., "point exists, volume unreported"); integer fields **cannot** represent per-field missingness — documented limitation (per-field masks are a possible future segment-format extension; format self-describes, so non-breaking).
- **Merge policy:** new data wins. Optional warning when overlapping values differ outside the volatile region — **off by default** (O(overlap) cost).
- Multi-source field assembly (different fetches supplying different fields for one timestamp) is deliberately **unsupported**: model independent series as separate caches, join at read time. Coverage authority applies to whole rows.

### 3.2 Storage

- **Coverage is separated from data.** The coverage index records which time ranges are *known/authoritative* (asked the backend; answer is final). Absence of points inside coverage = **confirmed real gap** (weekend, sensor offline). "Is [a,b] cached?" is a pure coverage question.
- **Coverage index:** sorted array of disjoint `[start, end]` ranges per cache, binary search, splice on merge. n stays small (tens). Document the rejected alternatives (interval tree, skip list) with pros/cons in the architecture docs.
- **Coverage semantics:** a fetch response for requested range [a,b] is authoritative for all of [a,b] — except the volatile region (§3.3).
- **`Segment` interface from day one** (`lookup`, `slice`, `mergeFrom`, `transferPayload`), so coverage logic, merge orchestration, and RPC are layout-agnostic:
  - **`DenseSegment` ships in v1:** implicit timestamps (`start + i * interval`), presence bitmask (`Uint8Array`, 1 bit/slot), one typed array per field.
  - **`ColumnarSegment` is a documented fast-follow** (explicit timestamp array, no mask) for sparse data; future third implementation can serve irregular timestamps.
- **Gap-split heuristic:** a dense segment splits when an internal gap exceeds K intervals (K configurable per cache; default proposal: 4). Splitting data segments is cheap; coverage never splits over real gaps.
- **Segments are size-capped** (slots per segment; default proposal: 32,768) and **self-describe their layout** in the payload — both chosen deliberately so the format works for persistence later.

### 3.3 Invalidation & freshness

- **`finalizedUntil` watermark** per cache (settable via `put` metadata and directly): points at `t >= watermark` are provisional — excluded from coverage authority, so they're always reported as missing on `get`, re-fetched, and merged new-wins. Models the live candle / moving tail.
- **`invalidate(cacheId, range)`** — coverage subtraction, for corrections/restatements known out-of-band.
- **`clear(cacheId)` / `clearAll()`** — session resets, end-of-day. Document loudly: in SharedWorker mode one tab's clear affects all tabs by design.
- **Opt-in dataset `version`** (string) per cache; threadable from fetch-response metadata via `put`. Mismatch → auto-clear + `cacheCleared` event with `reason: 'version-mismatch'`. When unset, the machinery is inert — manual clear is the base layer (graceful fallback for unversioned backends). Docs must state plainly: restatements without a version signal are undetectable by any library mechanism.
- **TTL rejected** in core; documented as a consumer-side pattern (call `invalidate`/`clear` on your own clock).

### 3.4 Worker architecture

- Fallback chain: **SharedWorker → dedicated Worker → in-process**, with consumer able to pin a starting mode (fallback continues down-chain from the pin). Document prominently: **Chrome on Android has no SharedWorker** — the dedicated-worker path is mainstream, not exotic.
- **One engine class, three hostings:** the in-process engine has zero DOM/worker imports at module top level (lazy construction) → SSR/Node-safe; the RPC layer is a thin shell around it. Unit tests run against the engine directly. In-process is sufficient for Node (no `worker_threads` in v1).
- **Same-origin tabs only** for sharing. Ship a stable worker entry point as a package subpath; document bundler setup (Vite/webpack).
- **Boundary transfer:** structured payloads with **transferable typed arrays** (zero-copy move). Reads copy out of cache-owned buffers (mandatory — never transfer cache-owned memory). **No SharedArrayBuffer in v1** (COOP/COEP burden); roadmap opt-in.
- **Protocol version handshake at worker connect:** worker reports protocol version; client refuses mismatch with a clear error. Protects against package skew and stale cached worker scripts after deploys.

### 3.5 Fetch orchestration & auth

- **Pull model is the primitive:** `get(range)` returns data + coverage + miss descriptors; consumer can `put` data itself.
- **Worker-side orchestration is the first-class layer:** consumer provides a **self-contained fetcher module** (URL/specifier) which the worker dynamically `import()`s. Fetcher receives `(cacheId, range, context)` and returns points plus optional metadata (`version`, `finalizedUntil`); it signals auth failure via a distinguished error class/result code. Fetchers cannot close over main-thread state — config/auth material arrives as structured-cloneable context.
- **In-flight dedup** keyed in the worker (one fetch serves all tabs). **Miss coalescing:** computed miss ranges extend by one interval on flanks abutting existing coverage (the one-point overlap aiding range merge).
- **Auth:** cookie-based auth works natively in workers. **`authInvalid` broadcasts to all tabs** (design "b"); **`updateAuth(context)`** accepted from any tab, delivered to the fetcher, paused fetches retried. Ship a copy-pasteable **Web Locks** dedup snippet in examples (refresh-token rotation safety). Document the alternatives — (a) initiating-tab-only, (c) worker-elected handler with failover — with pros/cons; (c) is the roadmap upgrade.
- **Auth-pending behavior (design "y"):** while auth is invalid, `get` resolves promptly with partials; affected misses carry `reason: 'auth-pending'`; consumer re-`get`s after `updateAuth`. Never block a `get` on a human-speed event.

### 3.6 Read contract

- `get(range)` returns **present-points-only columnar shape**: `{ timestamps: Float64Array, fields: { [name]: TypedArray }, coverage: Range[], misses: Miss[] }`. Equal lengths, no holes, no mask — identical shape regardless of internal segment layout. (Raw-dense read shape was considered and dropped from v1; chart-format adaptation happens in example/consumer code.)
- **Partial-result policy (II):** `get` **never rejects for data-availability reasons.** Fetch failures resolve with whatever exists plus per-range miss reasons (`'uncached' | 'fetch-failed' | 'auth-pending'`, with error detail). Rejection is reserved for programmer errors (invalid range, misaligned put, unknown cache). `misses` is always present (possibly empty) so it can't be overlooked.

### 3.7 One format, three uses — design invariant

The segment transfer payload (`{layout, start, count, mask?, fields, ...}`) is simultaneously: the **RPC** wire format, the future **IndexedDB** persistence value, and the **SSR hydration** payload serialized into HTML. Protect this invariant in every design choice. Persistence notes already settled for the roadmap doc: write-behind only (dirty-segment set, debounce + `pagehide` flush), volatile region excluded from persistence, coverage reconciled against actual segment presence on hydrate (IDB can evict), schema-version field required.

## 4. Tooling Stack (researched June 2026 — use these)

| Category | Tool | Notes |
|---|---|---|
| Package manager / scripts | **Bun** (workspaces) | Bun everywhere except where Node required |
| Lint + format | **Biome** | replaces ESLint+Prettier; pair with tsc for types |
| Type-check | **`tsc --noEmit`** authoritative | **`tsgo --noEmit`** optional fast pre-push check (TS 7 is Beta — don't make it the source of truth) |
| Build | **tsdown** | Rolldown/Oxc; ESM-only output; subpath + worker entries; `.d.ts` via oxc with **`isolatedDeclarations: true`** in tsconfig; tsup is EOL — do not use |
| Publish hygiene | **publint + `attw --pack`** + `npm pack` dry-run | wired into `bun run ci` (tsdown can integrate both) |
| Dead code / unused deps | **Knip** + **`fallow audit`** | Fallow (fallow-rs/fallow): Rust codebase-intelligence — dead code, duplication, complexity, boundaries; syntactic-only (no type info), so use `@public`/`@internal` TSDoc tags and config `entry` patterns for worker entries to avoid false positives. Both run pre-push, not pre-commit |
| Commit-msg lint | **commitlint** (`config-conventional`) | `commit-msg` hook |
| Changelog / versioning | **git-cliff** (recommended) | zero-ceremony, commit-derived, no GitHub dependency; changesets is the alternative if explicit release intents preferred — confirm (Open Decisions) |
| Git hooks | **Lefthook** | parallel, single YAML |
| Secret scanning | **gitleaks** | pre-commit |
| Unit tests + bench | **Vitest 4 — run under Node** | Bun runs everything else; Vitest-on-Bun has documented edge cases and Vitest requires Node ≥22.12. Never `bun test` (different runner) |
| Multi-tab integration | **standalone Playwright** | **Critical:** Vitest Browser Mode opens one page per file and cannot share a SharedWorker across tabs. Pattern: one `BrowserContext`, multiple `context.newPage()` — pages share the SharedWorker; separate contexts isolate it |
| Precision micro-bench | **mitata** | for hot paths (binary search, typed-array merge, transfer overhead); Vitest bench (tinybench) for regression gating |
| API docs | **TypeDoc** + TSDoc | |
| Optional | **sherif** (workspace dep consistency), **taze** (dep updates) | cheap insurance |

**Hook staging:** pre-commit = Biome (staged) + gitleaks + commitlint (sub-second budget). Pre-push = `tsc --noEmit` (+ optional tsgo) + full Biome + Knip + `fallow audit` + Vitest suite. `bun run ci` = full superset incl. build + publint/attw + Playwright + bench smoke.

## 5. Repo Structure & Packaging

**Hybrid model (locked):** Bun-workspaces **monorepo as repo layout**, but **exactly one published npm package** with subpath exports — no version skew between client and worker is possible, and the protocol handshake (§3.4) backstops stale-script cases.

```
packages/tscache/            # the only published package
  src/                       # engine, coverage, segments, rpc, client, worker-entry
  package.json               # exports: ".", "./worker", "./engine"; ESM-only; optional peers later for adapters
examples/                    # workspace members, never published
  vanilla-uplot/  solid-uplot/  solid-lwcharts/  react-lwcharts/
  react-ssr/  solid-ssr/
integrations/                # type-checked snippets (not published), `bun run check:integrations`
docs/                        # architecture decision records, roadmap, guides
```

## 6. Testing Strategy

- **Vitest (Node):** engine unit tests (the one-engine design makes this ~90% of logic), RPC protocol over mock ports, property-style tests for coverage merge/subtraction and segment merge, bench files.
- **Vitest browser mode (single-page):** worker construction, fallback chain, transferable round-trips, single-tab SharedWorker sanity.
- **Playwright (multi-tab):** shared fetch dedup across tabs, `authInvalid` broadcast + Web Locks recovery, version-mismatch clear propagation, tab-death during in-flight fetch.
- **Benchmarks are first-class:** merge/read/transfer hot paths tracked from early commits.

## 7. Examples & Scenarios

Six runnable apps (locked list) exercising five scenarios; each example doubles as a narrative doc page naming the design decision it demonstrates. Proposed mapping (confirm/adjust):

| App | Scenario |
|---|---|
| vanilla + uPlot | ② live server-metrics dashboard — watermark/volatile tail; plus ⑤ sparse event-count series (K-split heuristic) as a second page |
| Solid + uPlot | ③ IoT sensor with dropout gaps + an integer field (presence bitmask showcase) |
| Solid + Lightweight Charts | ① OHLCV scroll-back with weekend gaps (coverage vs real gaps) |
| React + Lightweight Charts | ① variant + ④ **multi-tab demo**: two windows, one SharedWorker, visible fetch counter — the raison d'être made visible |
| React SSR + hydration | mechanism (y): server runs in-process engine, serializes put-payloads into HTML, client hydrates cache from them |
| Solid SSR + hydration | same mechanism, Solid idioms |

**Integration snippets** (in `integrations/`, type-checked, not full apps): Solid (`createResource`), React (hook, Suspense-compatible), Vue (composable), Svelte 5 (runes store), Angular (service + signals), vanilla — each in client-only and SSR+hydration variants (SSR-only is the degenerate case of the same code). The library's framework-coupling surface is deliberately tiny: lifecycle (create/connect once, dispose on teardown) + promise→reactivity.

Mock backend (shared by examples): synthetic data with session/weekend gaps, configurable latency, version bumping, 401 simulation for the auth demo.

## 8. Documentation Debts (committed during design — must ship)

Coverage-index alternatives pros/cons · auth designs (a)/(b)/(c) comparison + Web Locks snippet · TTL-as-consumer-pattern · integer per-field-missingness caveat · Chrome-Android SharedWorker note · multi-tab `clear()` warning · version-signal honesty note · bundler/worker-entry setup guide · persistence design sketch (§3.7) · roadmap (§10).

## 9. Open Decisions — resolve with me before related code

1. **Library name** (placeholder `tscache`) and npm scope; license (propose MIT).
2. **Default interval** when unspecified (propose 60,000 ms).
3. **Alignment anchor:** plain epoch-multiples, or optional per-cache `alignmentOffset` (default 0) for e.g. daily bars stamped at session open? (Propose: include the offset — cheap, removes a real footgun.)
4. **K default** for gap-split (propose 4) and **segment slot cap** (propose 32,768).
5. **git-cliff vs changesets** (recommendation: git-cliff for local-only single package).
6. **ESM-only** confirmed, or ESM+CJS? (Recommend ESM-only.)
7. Example→scenario mapping above: confirm or adjust.
8. Differs-on-overlap warning surface: `console.warn` vs emitted event (propose event, with console in dev).

## 10. Roadmap (explicitly deferred, document in repo)

Aggregation/resampling (likely user-defined rules per dataset) · ColumnarSegment · subscriptions/dirty-notifications (design already sketched: notify-only, re-`get`) · IndexedDB persistence (§3.7 sketch) · LRU/eviction & memory limits · SharedArrayBuffer opt-in · per-field presence masks · irregular timestamps (third segment impl) · elected auth handler (c) · Node `worker_threads` hosting.

## 11. Commit / PR Plan

① repo scaffolding + tooling (Bun workspaces, Biome, Lefthook, gitleaks, commitlint, tsdown, Vitest, Playwright, `bun run ci`) → ② core types + config validation → ③ coverage index → ④ DenseSegment + bitmask → ⑤ merge/put path (incl. alignment/monotonic validation, new-wins, overlap warning) → ⑥ read path + miss descriptors → ⑦ invalidation suite (watermark/invalidate/clear/version) → ⑧ engine assembly — in-process mode usable end-to-end here → ⑨ RPC protocol + handshake + dedicated worker → ⑩ SharedWorker + fallback chain → ⑪ fetcher orchestration + dedup + auth events → ⑫ Playwright multi-tab suite → ⑬ examples + mock backend → ⑭ integrations snippets + docs + roadmap.

Each step = one or a few small Conventional Commits; the repo is green after every step.

## 12. Your First Deliverable

Before writing any implementation code, produce the **consolidated architecture document** for my review and sign-off:

1. Full public **TypeScript API surface**: `createCache` config type, `get`/`put`/`invalidate`/`clear`/`clearAll`/`updateAuth` signatures, the miss-descriptor and read-result types, event surface (`authInvalid`, `cacheCleared`, merge warning), fetcher-module contract (exports, error signaling, metadata return).
2. **RPC message schema** + protocol handshake.
3. **Module layout** within `packages/tscache/src`.
4. Your resolutions/questions for §9 Open Decisions, with proposals where you have a view.

Iterate on that document with me until approved; only then begin commit ①. Throughout, honor §2 — when in doubt, ask.
