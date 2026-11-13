# Step 82 — State three known limits plainly in the guides

Branch: `docs/82-limits` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: settled · Verdict after triage: merge (one P2 fixed)

## Scope

The review of 2026-11-10 (`docs/reviews/2026-11-review.md`, findings M3, M5 and M7) found three gaps that have no code today: nothing bounds or reports memory, deploy skew has no recovery path, and readers get no change notifications. The user decided (decision 46 A, 2026-11-13) that before 0.1.0 one documentation step states each limit plainly where a user meets it, and that the designs follow after the release. This step does that. It changes no code and promises no design, date or API.

| Commit (by subject)                                        | What                                                                                                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs: state three known limits of 0.1.0 in the guides`    | The site's home page, the patterns, workers and live-feeds guides, troubleshooting, `docs/guides/patterns.md`, one line in the package README, and their sizes in `docs/INDEX.md`. |
| `docs(review): step 82 scope and verification`             | This file, and the review-file count and size in `docs/INDEX.md`.                                                                                                                  |
| `docs(troubleshooting): persistence has shipped`           | By the director: the FAQ answer on caching across page loads (Contradictions, item 2).                                                                                             |
| `docs: correct the deploy-skew limit after the pre-review` | The five pre-review findings below; the `docs/INDEX.md` sizes re-measured on the final head.                                                                                       |

**Where each limit is stated.**

- **A list.** The site already lists what version 1 leaves out under "What it leaves out" on its home page (`site/index.md`). A "Known limits" subsection there now names the three limits in one line each and links to the page that details each. The package README gets one line, under Stability, pointing at that list. `docs/guides/patterns.md`, the repository's page for "the limits an application has to design around", ends with a short "Known limits of 0.1.0" section for contributors that points at the same site pages.
- **M3, memory: `site/guides/patterns.md`, Memory.** The section existed ("Nothing is evicted in version 1"); it now says that nothing bounds or reports memory, gives the per-series arithmetic, says that a persisted cache loads its records into memory, and names what an application can do today (`clear()`, small dtypes). It links the roadmap's eviction sketch.
- **M5, deploy skew: `site/guides/workers.md`, Stale scripts after a deploy.** The section now quotes the real `ProtocolMismatchError` messages and fields, and a warning block describes the two ways a deploy runs: hashed worker URLs (separate SharedWorkers, nothing reported, both writing one database) and a fixed worker URL (one worker, but the fetcher URL must be fixed too). It names the one thing a page can do after a mismatch today, a new client with `mode: 'dedicated'`, and when that cannot help (the page or a cached script is the stale side, so it must reload). `site/troubleshooting.md` repeats that under `ProtocolMismatchError` and adds an entry for the fetcher conflict a fixed worker URL can produce.
- **M7, change notifications: `site/guides/live-feeds.md`, Redrawing when the cache changes.** A new section with a warning block says that no event reports a change except `cacheCleared` (and the opt-in `mergeWarning`), and how a view redraws with the existing API: `get` after its own `put`; an application signal such as a `BroadcastChannel`, then `get(range, { cacheOnly: true })` under a SharedWorker; a fetching `get` on a timer; `cacheCleared` for an emptied cache. It links the roadmap's subscriptions sketch. The "Many tabs, one feed" section says that its `BroadcastChannel` is the application's, and links the new section.

**The roadmap.** `docs/roadmap.md` lists eviction and memory limits ("Design sketch: eviction and memory limits") and subscriptions ("Design sketch: subscriptions (dirty notifications)"); the guides link both. It does not list deploy skew or a recovery path for it, so the workers guide links no roadmap item, and none was added.

## Claims checked against the code

Every statement the new text makes about behaviour, with where it holds:

- **No eviction, budget or size API.** `grep -rniE "evict|budget|memoryUsage|byteSize|sizeOf|bytesHeld" packages/tscache/src` outside tests: no match. The public types (`packages/tscache/src/types.ts`) have no size call on `Client` or `CacheHandle`.
- **A bar's bytes.** A `DenseSegment` stores one typed array per field and a presence bitmask of one bit per slot, with implicit timestamps (`packages/tscache/src/segment/dense.ts:1-10`); the mask is `Math.ceil(capacity / 8)` bytes and each field `capacity` elements (`dense.ts:311-313`). Capacity doubles up to the slot cap (`dense.ts:303-306`), so a buffer can hold spare slots; the year benchmark measures 36.233 bytes per bar for 36 bytes of fields (`docs/benchmarking.md`, `site/performance.md:11-12`), so the spare room is small.
- **The 21 MB figure.** 365 days × 1,440 minutes = 525,600 bars. Five `f64` fields (open, high, low, close, volume, as in the README's quick start) are 5 × 8 = 40 bytes, plus 1/8 byte of mask: 40.125 bytes per bar. 525,600 × 40.125 = 21,089,700 bytes, about 21.1 MB (20.1 MiB); a leap year is 527,040 bars, 21.1 MB. The guides say "about 21 MB" and that this excludes the copies a page keeps of what it read (a read returns copies, `site/concepts/coverage.md:32`).
- **A SharedWorker outlives the tab that opened it.** The browser keeps a SharedWorker while any connected document lives; tscache creates it with `extendedLifetime: true` (`packages/tscache/src/client/hosting.ts:122`), which keeps it about 30 seconds after the last tab in Chromium (`site/guides/persistence.md`, What is stored).
- **A persisted cache loads its records into memory.** The persister applies the stored records to the cache's in-memory state with `cache.state.restore(stored)` (`packages/tscache/src/persist/persister.ts:502`, `packages/tscache/src/engine/cache.ts:429`), before `cache()` resolves (`site/guides/persistence.md`, Loading).
- **`clear()` frees points; `invalidate` does not.** `site/concepts/invalidation.md:3-7` (points "kept" for `invalidate`, "all removed" for `clear`); a persisted cache's `clear` deletes its records (`site/guides/persistence.md`, What is stored).
- **The protocol-mismatch messages.** The client refuses a hello whose protocol differs with `worker speaks protocol ${show(message.protocol)}, client speaks ${PROTOCOL_VERSION}` (`packages/tscache/src/rpc/port-client.ts:107-118`); the worker refuses an init whose protocol differs with `client speaks protocol ${show(protocol)}, worker speaks ${PROTOCOL_VERSION}` (`packages/tscache/src/rpc/server.ts:247-257`). Both set `clientProtocol` and `workerProtocol` (`packages/tscache/src/errors.ts:97-114`). Neither message asks the user to close tabs; see Contradictions.
- **A dedicated retry meets the same script.** `openDedicated` constructs `new Worker(url, { type: "module" })` with the same `workerUrl` (`packages/tscache/src/client/hosting.ts:184`), so when the page or the script at that URL is the stale side, the dedicated worker's hello carries the same mismatching protocol and `connect` rethrows it (`client.ts:144`).
- **No fallback, no retry, no event.** `connect` steps down only on a `HostingError` and rethrows anything else (`packages/tscache/src/client/client.ts:144`), so a `ProtocolMismatchError` or `ConfigError` rejects `createClient`. `ClientEvents` (`types.ts:284` onward) has no event for a newer worker.
- **The package version is reported but not checked.** Every server sends `hello.lib` (`packages/tscache/src/rpc/protocol.ts:24-27`, `LIB_VERSION`); no code outside the server and the protocol type reads it (`grep -rn "\.lib\b" packages/tscache/src`: no read).
- **Both deploys write one database.** The IndexedDB database name is the constant `"tscache"` (`packages/tscache/src/persist/idb-store.ts:15`), with no option in the public API; what two writers can cost (deleted pages, a removed range written back, nothing with a changed `version`) is architecture §4.10.7 (N52).
- **A worker runs one fetcher module.** `Orchestrator.load` refuses a second, different module with `ConfigError` `this worker already runs fetcher ${this.#module}; cannot also load ${config.module}` (`packages/tscache/src/orchestrator/orchestrator.ts:298-303`), and the server answers `init-err` (`server.ts:261-268`), which rejects `createClient` without a fallback (above).
- **Vite hashes both file names.** `fetcherUrl()` emits the fetcher as a Rollup chunk (`packages/tscache/src/vite/fetcher-url.ts:172-176`), which takes Vite's hashed chunk name. Checked with a production build of `examples/vanilla-uplot` (below): the output holds `assets/worker-_aG70VYQ.js` and `assets/fetcher-DgZf2Phu.js`.
- **Change events.** The engine emits only `cacheCleared` (`packages/tscache/src/engine/engine.ts:260`); the orchestrator adds the request-scoped, opt-in `mergeWarning` (`orchestrator/orchestrator.ts:689`). No event follows a merge, an invalidation or a watermark move. `GetOptions.cacheOnly` returns the cache's state without fetching (`types.ts:122-124`). The reference clients' feed signals other tabs on a `BroadcastChannel` and, under a SharedWorker, the readers only redraw (`reference/shared/src/live.ts:5-12`).

## Verification

- `bun install --frozen-lockfile`: exit 0. `bun run build`: exit 0.
- `bunx vite build --configLoader runner --outDir <scratch>` in `examples/vanilla-uplot`: built; the output names quoted above. The output directory was outside the repository.
- `bun run docs:check`: exit 0, "doc-anchors: 246 anchors in 42 pages resolve" (the new in-site links and anchors included).
- `bun run docs:build`: "build complete"; the built pages carry `id="known-limits"` (`index.html`), `id="redrawing-when-the-cache-changes"` (`guides/live-feeds.html`) and the warning block in `guides/workers.html`.
- `bunx biome check docs site/guides site/index.md site/troubleshooting.md packages/tscache/README.md`: no fixes.
- No snippet was added, so `docs:run` and `check:integrations` are not affected; both run in the gate.
- **The gate.** `~/code/tscache-reports/bin/heavy-run.sh "82 child: ci" bun run ci` on the final head; the result is in the child's report to the director.

Not verified: the deploy-skew behaviour in a browser (two deploys side by side, a fixed-URL deploy with a hashed fetcher, the `mode: 'dedicated'` retry after a mismatch); each is read from the code above, not reproduced. The README link (`https://anishbenji.github.io/tscache/#known-limits`) resolves only once the site is deployed with this change.

## Decisions

- **The list lives on the home page.** "What it leaves out" (`site/index.md`) is the one place the site already gathers what version 1 lacks; a "Known limits" subsection there keeps one list rather than adding a page.
- **Memory in the patterns guide.** Its Memory section already held the limit in two sentences; extending it keeps one home for it. The workers and persistence guides are linked from it rather than repeating it.
- **The `mode: 'dedicated'` retry is named, not shown as a snippet.** It is the only recovery the code supports today, and only when a running SharedWorker is the stale side; a snippet would have to run against the mock backend without a real mismatch, and prose states the trade-off (no sharing, no persistence) as plainly.
- **A fixed fetcher URL is part of the fixed-URL advice.** The brief suggested a stable worker URL. The code refuses a second fetcher module in one worker, and Vite hashes the fetcher's name, so the advice is incomplete without it; the guide points at the existing "A fetcher that needs `import()`" build for a fetcher at a fixed name.

## Contradictions found

1. **The quoted advice is not in the code.** The review (M5) and the brief quote `createClient` as rejecting "with an error that asks the user to close the old tabs and reload". The error's message asks nothing: it is `worker speaks protocol N, client speaks M` (or the reverse). "Close the old tabs and reload" is the advice in `site/troubleshooting.md:20`, which this step keeps and extends.
2. **Troubleshooting says there is no persistence.** `site/troubleshooting.md`, "Does tscache cache across page loads?", answers "No. Version 1 keeps everything in memory; persistence to IndexedDB is on the roadmap", which has been untrue since step 38 (`persist: true`). Fixed by the director before the pre-review in `docs(troubleshooting): persistence has shipped`: the answer now says a `persist: true` cache keeps its history in IndexedDB under the SharedWorker hosting, and links the persistence guide.
3. **A stale size in `docs/INDEX.md`.** The `site/` row said 215.0 KB of Markdown; the tracked Markdown under `site/` was 244.7 KB before this step. Re-measured with this change.

## Pre-review (Claude), not the gate

Before Codex round 1, a fresh-context pre-review raised five P2 findings. Each was checked against the code; all five held and were fixed in `docs: correct the deploy-skew limit after the pre-review`.

1. **The `mode: 'dedicated'` retry was presented as always working.** It works only when the stale side is a SharedWorker that old tabs keep alive. When the page is stale (an old tab recreating its client after `workerLost`, HTML or script from an old cache) or the worker script comes from an old HTTP cache entry, the dedicated worker loads the same script (`packages/tscache/src/client/hosting.ts:184`), its hello mismatches the same way, and `ProtocolMismatchError` is not a `HostingError`, so `connect` does not step down (`packages/tscache/src/client/client.ts:144`). Fixed: `site/guides/workers.md` and `site/troubleshooting.md` say when the retry helps (the page is newer: `clientProtocol` larger than `workerProtocol`) and that otherwise the page has to reload.
2. **The home page's fixed-URL item named only `ProtocolMismatchError`**, though a new fetcher module URL rejects new tabs with `ConfigError` (`packages/tscache/src/orchestrator/orchestrator.ts:298-303`); and "share nothing" contradicted the shared IndexedDB database. Fixed: `site/index.md` names both errors and says the two workers share no memory and both write the database; the workers guide's fixed-URL bullet no longer says "only a protocol change is refused" and names the `ConfigError` case beside it.
3. **`clearAll` was missing from what two deploys' workers stop sharing.** A logout's `clearAll` in a new tab empties the disk and its own worker, but the old worker writes back the pages it still holds (architecture §4.10.7; `site/guides/persistence.md`, Sensitive data and logout). Fixed: the hashed-URL bullet lists `clearAll` and says this, with a link to that section.
4. **Sizes and the commit table.** The `docs/INDEX.md` rows for `site/`, `docs/guides/patterns.md`, `packages/tscache/README.md` and `docs/reviews/` re-measured on the final head; the director's troubleshooting commit and the fix commit added to the table above.
5. **The `extendedLifetime` upgrade paragraph** under "Stale scripts after a deploy" described tabs falling back on the first upgrade to a release that creates the SharedWorker with `extendedLifetime`. Every release passes that option (`packages/tscache/src/client/hosting.ts:122`), the repository has no tag and `CHANGELOG.md` lists only `[Unreleased]`, so no published release lacks it, and the paragraph contradicted the fixed-URL bullet. Dropped from the site guide. The history stays in architecture §4.10.7 and §4.10.8, which record design history rather than user guidance.

## Round 1 — reviewer verdict: merge after fixes

One P2 (2026-11-13): the live-feeds guide said a fetching `get` on a timer picks up what other tabs added,
which holds only where the tabs share a SharedWorker; with a cache per tab, a timer `get` fetches only what
its own cache lacks and never sees another tab's `put`. Valid; fixed in `docs: scope the polling advice to
a shared worker`: the sentence is scoped to a shared SharedWorker, says what a cache per tab must do
instead, and keeps that polling still brings new and provisional bars. The one-line pointer in
`docs/guides/patterns.md` (Known limits) gains the same scope.

## Finding check (claude-fable-5-2), round 1

V 1, P 0, I 0, D 0
