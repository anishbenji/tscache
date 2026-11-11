# Step 61 — The code tour and the anchor check

Branch: `docs/61-code-tour` · Reviewer: GPT-6.1 Sol (high) · Rounds: 2 · Status: in review · Verdict after triage: redesign the check on real parsers, then re-review (redesign done; round 3 next)

Two parts. A check, run in `bun run ci`, that fails when a `path#symbol` anchor in `site/` no longer
resolves, and a "Code tour" page in "How it works" that reads the package source in the order a
request travels, each stop with its anchors, what to notice and a demo-hub scenario that shows it.
Every claim on the page was taken from the source, not from the existing docs; the traces below map
each one to the code that backs it.

## Scope

| Commit                                                                 | What                                                                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci(docs): fail when a path#symbol anchor in site/ no longer resolves` | `scripts/check-doc-anchors.ts`, its Vitest file, and the one-line addition to the root `package.json` `docs:check` script. All 71 existing anchors resolved.  |
| `docs(site): add the code tour to "How it works"`                      | `site/how-it-works/code-tour.md` (85 anchors), its sidebar entry last, after "Live feeds", in `site/.vitepress/config.ts`, and a link from the overview page. |
| `docs(review): step 61, the code tour and the anchor check`            | This file.                                                                                                                                                    |
| `ci(docs): rebuild the anchor check on real parsers`                   | After round 2: the check moves to `site/scripts/check-doc-anchors.ts` on VitePress's renderer and TypeScript 6, with its test; the `scripts/` copies go.      |
| `docs(review): step 61, the anchor check on real parsers`              | This file, for the rebuilt check.                                                                                                                             |

The fix commits of the pre-reviews and rounds are listed in their sections below.

`package.json` is a protected path, so the user merges this pull request. The change there is the one
`docs:check` line, which now ends `… && bun site/scripts/module-graph.ts --check && bun
site/scripts/check-doc-anchors.ts`. `vitest.config.ts` gains one `include` entry,
`site/scripts/**/*.test.ts`. `scripts/ci.sh` is unchanged; it already runs `docs:check`.

## The anchor check

The check was rebuilt on real parsers after round 2 (see "Redesign after round 2"); this section
describes the rebuilt check. The pre-review and round sections below describe the scanner it
replaced, as they were written.

### Where it lives

`site/scripts/check-doc-anchors.ts`, beside the module-graph script, with its test in
`site/scripts/check-doc-anchors.test.ts`. Both parsers it uses are dependencies of the site workspace
and resolve from there, so it adds none: VitePress (`2.0.0-alpha.21`) and TypeScript 6 under the
site's npm alias (`typescript: npm:typescript@6.0.3`, pinned for TypeDoc; TypeScript 7 has no JS API).
Vitest collects `site/scripts/**/*.test.ts` (one new `include` entry in `vitest.config.ts`); `tsc -p
site/scripts`, already part of `docs:check`, type-checks the script and its test; Knip and Fallow
already treat `site/scripts/*.ts` as entries. Vitest runs under Node, so everything the test imports
uses `node:` modules; the one call to `Bun.spawnSync` (`git ls-files`) is the default of `run`'s
`list` parameter, which the tests replace.

### What it accepts

- **Pages.** Every page Git lists under `site/` (tracked, or new and not ignored), or the pages given
  on the command line, is parsed by VitePress's own Markdown renderer (`createMarkdownRenderer`), so a
  page reads exactly as the site renders it. The renderer runs with VitePress's default options. The
  site's config (`site/.vitepress/config.ts`) adds two things to Markdown, and neither changes how a
  page parses: a core rule that fails the build on a link to a missing repository file, and Mermaid's
  fence renderer. `<!--@include: … -->` is expanded only when VitePress renders a page, not when it
  parses one; the two includes on the site insert SVG diagrams, which hold no anchor.
- **Anchors.** An inline code token whose whole content is `<path>#<symbol>`, where `<path>` is a
  repository-relative file ending in `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` or `.cjs`,
  and `<symbol>` is an identifier or `Top.member` (the member may be a `#private` name). Fenced code,
  region includes (`<<< @/snippets/x.ts#region`), HTML blocks and placeholders such as `path#symbol`
  (no extension) are not inline code tokens of that shape, so they are not anchors. A container's
  title (`::: tip <title>`) is parsed as the inline Markdown VitePress renders it as, so an anchor
  there is checked, on the container's line. An anchor inside an HTML `<a>` element, whether written
  inline in a paragraph or opened by an HTML block around paragraphs, is reported: its `href` is not
  read, so the link must be written in Markdown. An inline code token shaped like an anchor (a code
  file and `#`) whose symbol is neither a name nor `Top.member` (`#Engine.cache()`, `#A.B.c`) is
  reported as not checkable, rather than skipped.
- **Links.** The renderer resolves every link form to the `href` the page shows: inline links with or
  without a title, angle-bracket and multi-line destinations, and full, collapsed and shortcut
  reference links, with definitions wherever CommonMark allows them (after a heading included, not
  inside a paragraph; the first definition of a label wins). When the anchor is a link's whole text,
  the `href` must be exactly `https://github.com/anishbenji/tscache/blob/main/<path>`. When the link's
  text holds more than the anchor (other text, or emphasis around it), the anchor is reported: "an
  anchor in a link must be the link's whole text". Outside a link an anchor is checked for its file and
  symbol only; that includes a reference to an undefined label (`[…][nowhere]`), which the site renders
  as text, not as a link.
- **Lines.** markdown-it gives blocks a line range and inline tokens none. The check subclasses the
  renderer's inline parser state, as VitePress itself does for its CJK rule, and notes for each inline
  code token how many newlines of its block's text precede the opening backtick. A problem's line is
  the block's first line plus that count, plus the lines of the frontmatter VitePress strips before
  parsing. The check fails with an error, rather than guess, if the parsed text is not the page minus
  a leading frontmatter.
- **Files.** The path must name a file under the repository root that Git lists: a build output such
  as `packages/tscache/dist/` has no page on GitHub, so it does not resolve, and a path that leaves the
  repository is refused even when listed. The check exits 1 when `git ls-files` fails or no page is
  found, rather than passing with nothing checked.
- **Declarations.** Each source is parsed with `ts.createSourceFile`, whose dialect follows the
  file's extension (`.tsx` and `.jsx` parse JSX). `<symbol>` resolves when the file has, at top level:
  - a function, class, variable (every declarator, and every name a destructuring pattern binds),
    type alias, interface, enum (`const enum` included) or namespace declaration, exported or not,
    `declare` included;
  - a name in an `export { … }` or `export type { … }` clause, re-exports included, under its exported
    name (`a as b` declares `b`), or `export * as ns`.

  A named function or class expression (`const impl = function ghost() {}`) declares no top-level
  name, and neither does a `declare module "…"` block or `declare global`.

  `Top.member` resolves when `Top` is such a declaration and `member` is a member of its own body: a
  class member (method, property, accessor, `#private` name, constructor parameter property), an
  interface member, an enum member, a member of the object type a `type` alias names, a declaration of
  a namespace's body, or a property of the object literal or class expression that initialises a
  `const`, `let` or `var` `Top`, seen through parentheses, `as`, `satisfies` and `!`, and through
  `Object.freeze(…)`. Declarations that merge (a class and an interface of one name) pool their
  members.

  A bare name, with no `Top.`, resolves against the top-level names only. The redesign kept the old
  rule that a bare name also resolves to any member of any body in the file; the pre-review before
  round 3 showed that it lets a renamed function pass while its old name survives as an object key or
  option name anywhere in the file, and no page relies on it (every anchor without a `Top.` names a
  top-level declaration). The director dropped it: a member is always named `Top.member`.

The export-clause rule is a decision taken in the first commit: the step 59 anchors on the package
map point at the entries (`entries/index.ts#createClient` and four more), whose API is a list of
re-exports.

### What it cannot see

- An anchor written as HTML (`<code>…</code>`, or inside an HTML block) is not an inline code token,
  so it is not checked; no page writes one.
- A member with a computed name (`[key]: 1`) is not a member; a quoted name is, but no anchor can name
  it, since the anchor pattern takes identifiers only.
- `Top.member` does not follow types: a `const` annotated with an interface, or initialised by a call
  other than `Object.freeze`, owns no members.
- TypeScript's parser recovers from syntax errors; a file that does not parse still yields what it can
  read. `bun run typecheck` fails on such a file first.

### Tests

`site/scripts/check-doc-anchors.test.ts`, 79 tests, no clock or sleep (and covered by `bun scripts/test-clocks.ts`, whose globs now include `site/scripts/`). Pages: an anchor that
resolves; a missing file; a missing symbol; a link to another file; titled links in each title form;
full, collapsed and shortcut references, label case and the first definition winning; a definition
right after a heading; a definition-shaped line inside a paragraph; angle-bracket and multi-line
destinations (the links the old check could not read), at the right and the wrong target; an
undefined reference, which renders as text; an anchor that is part of a link's text, in an inline
link, a full reference, a shortcut reference and under emphasis; the reported file, line and anchor;
the line of anchors in a heading, on a paragraph's second line, after a link split across lines, in a
list item's continuation, a blockquote and a table cell, after frontmatter, with fenced code skipped;
a bare anchor; and what is not an anchor (a placeholder, fenced code, a region include, an
`@include`, raw HTML, a Markdown path). Declarations: each top-level kind, destructuring and second
declarators included; each member kind; `Top.member` against each kind of body, and its failures (a
local object, a call's argument, a missing member); what declares nothing (comments, strings,
templates, regular expressions, locals, calls, named function and class expressions, `declare
module`, `declare global`); one test that a declaration after each construct that misled the old
scanner still resolves (regular expressions after a condition, an interpolation and a spread;
divisions after postfix operators and keyword property names; JSX); and a `.tsx` anchor read as TSX.
The repository reader: a listed file, an unlisted one and a path that leaves the repository. The
command: exit 1 when Git fails and when there is no page. Three mutations of the line and link code
(no per-token line, no frontmatter offset, every link taken as whole-text) each fail a test.

### Anchors fixed in today's site/

None. The rebuilt check finds 246 anchors in 11 pages of `site/how-it-works/`, all resolving and all
linked to their file: `code-tour.md` 85, `index.md` 34, `data-model.md` 28, `startup.md` 23,
`persistence.md` 17, `read.md` 13, `tabs.md` 12, `auth.md` 9, `package-map.md` 9, `fences.md` 8 and
`live-feeds.md` 8. No other page has one.

### The old scanner and the new check over today's tree

- **Pages:** both find the same 246 anchors, on the same lines, with the same link targets, and both
  pass. No page uses a form on which they disagree.
- **Declarations,** over all 401 TypeScript files Git lists: the new check never misses a top-level
  name the scanner found, except `satisfies` in `examples/mock-backend/src/datasets.ts`, a keyword the
  scanner took for a name. It finds top-level names the scanner could not in 14 files, all from
  destructuring or a second declarator (`const { build, createServer } = await import("vite")` in the
  Vite tests, `[insight, setInsight]` in the Solid examples, `startPage` in a `.tsx` file whose
  brackets the scanner could not balance). For bare members, the scanner reported 128 files with
  names the parser does not count: `constructor`, words such as `static`, `new` and `Set` taken from
  type positions, names destructured in parameter lists, and fragments of JSX. Its `Top.member` sets differed
  in 116 files, mostly members it took from a type annotation or a call's object argument
  (`const client = await createClient({ mode })` gave it `client.mode`). The parser adds members with
  quoted names (`"content-type"`), which no anchor can name. None of these differences touches a
  page's anchor.

## Traces

Paths are relative to `packages/tscache/src/` unless they start with `examples/`, `reference/`,
`scripts/` or `site/`; `#name` after a path names another symbol of the same file. "Hub" is the demo
hub's catalog, `scripts/demo/catalog.ts`.

### 1. The entries

| Claim                                                                                                              | Backed by                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Four entries only re-export; `entries/worker.ts` runs code at load                                                 | `entries/index.ts`, `engine.ts`, `fetcher.ts`, `vite.ts` (export clauses only); `entries/worker.ts` (the two `if` blocks at the end) |
| `.` exports `createClient`, errors, `encodeSnapshot`/`decodeSnapshot`, `DTYPES`, types; handle and client as types | `entries/index.ts` (`export type { CacheHandle }`, `export type { TscacheClient }`)                                                  |
| `./engine` exports the `Engine` class                                                                              | `entries/engine.ts` (`export { Engine } from "../engine/engine"`)                                                                    |
| `./fetcher` re-exports from `errors.ts` alone, plus type-only exports                                              | `entries/fetcher.ts`                                                                                                                 |
| Every example imports `…/worker?worker&url` and passes it as `workerUrl`                                           | a grep finds the import in all ten apps (`examples/*/src`, `reference/*/src`); `examples/react-lwcharts/src/client.ts#connect`       |

### 2. The client

| Claim                                                                                                                                                         | Backed by                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Options validated before anything is created; `workerUrl` required unless the chain starts in-process; timeout default 5000, positive                         | `client/client.ts#resolve`, `#timeoutOf`, `#DEFAULT_HANDSHAKE_TIMEOUT_MS`, `#createClient` (resolve before connect) |
| `connect` walks `CHAIN` from `options.mode`; only `HostingError` steps down; others reject                                                                    | `client/client.ts#chainFrom`, `#connect`                                                                            |
| Fallback steps emitted as `modeFallback` on the next macrotask                                                                                                | `client/client.ts#Client` (constructor, `setTimeout(…, 0)`)                                                         |
| The handshake timer runs only until `hello`; a worker `error` before `init-ok` aborts                                                                         | `client/hosting.ts#handshake` (`clearTimeout` in the `afterHello` callback; `error` listener removed in `finally`)  |
| `openShared`: `type: 'module'`, `extendedLifetime: true`; watches the lock from `hello`; grant before `init-ok` fails the hosting, after it aborts the client | `client/hosting.ts#openShared`                                                                                      |
| An abort after the handshake becomes one `workerLost`                                                                                                         | `rpc/port-client.ts#PortClient.abort` → `#shutDown` → lost listeners; `client/client.ts#Client.#lose`               |
| `openDedicated` learns of failure from the worker's `error` event                                                                                             | `client/hosting.ts#openDedicated` (`onFatal`)                                                                       |
| `openInProcess` loads `in-process.ts` with `import()`; a failed load is a `HostingError`                                                                      | `client/hosting.ts#openInProcess`                                                                                   |
| `CacheHandle`: one request per method; `put` transfers the batch's buffers; `hydrate` sends no transfer list                                                  | `client/cache.ts#CacheHandle` (`put` passes `transferablesOf(batch)`; `hydrate` passes none)                        |
| The client disposes itself on `pagehide` unless `persisted`                                                                                                   | `client/client.ts#Client.#onPageHide`                                                                               |
| `ClientEmitter.receive` maps wire events and ignores unknown names                                                                                            | `client/events.ts#ClientEmitter.receive`                                                                            |
| Hub: crash the first tab of **Two tabs, one SharedWorker**; the others get `workerLost`                                                                       | hub `react-lwcharts` `lookFor`; `examples/react-lwcharts/src/client.ts#useClient` (`on("workerLost")`)              |
| The server-rendered entries use `mode: 'in-process'` on the server                                                                                            | `examples/react-ssr/src/entry-server.tsx`, `examples/solid-ssr/src/entry-server.tsx` (`mode: "in-process"`)         |

### 3. The RPC layer

| Claim                                                                                                                                                                                                                             | Backed by                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attach` assigns `c1`, `c2`, …; `hello` carries protocol, lib and, with one, the lock                                                                                                                                             | `rpc/server.ts#RpcServer.attach`; `rpc/protocol.ts#Hello`                                                                                             |
| `init` carries the fetcher config                                                                                                                                                                                                 | `rpc/protocol.ts#Init`; `rpc/port-client.ts#PortClient.connect` (`reply.fetcher`)                                                                     |
| `#init` refuses another protocol with `init-err`, loads the fetcher before `init-ok`                                                                                                                                              | `rpc/server.ts#RpcServer.#init`                                                                                                                       |
| Requests are `{ t: 'req', id, op, params }`, `id` per port client; the server names a request `clientId:id`                                                                                                                       | `rpc/protocol.ts#Req`; `rpc/port-client.ts#PortClient.request` (`++this.#seq`); `rpc/server.ts#RpcServer.#handlers` (`` `${c.clientId}:${req.id}` ``) |
| `get`, `invalidate`, `updateAuth` to the orchestrator; `put`, `clear`, `setFinalizedUntil`, `hydrate` to the engine; cache ops through `durably`; `clearAll` to `Persistence.clearAll`; `cache` awaits `open` for `persist: true` | `rpc/server.ts#RpcServer.#handlers`, `#durably`, `#clearAll`, `#cache`                                                                                |
| `get` results transferred; `dispose` answered before the drop                                                                                                                                                                     | `rpc/server.ts#RpcServer.#request`                                                                                                                    |
| Errors cross as `WireError`; named by `instanceof`; unknown names become `TscacheError`                                                                                                                                           | `rpc/protocol.ts#toWireError`, `#wireNameOf`, `#fromWireError`                                                                                        |
| Events to every ready port; `bye` on a drop the server starts; flush when the last connection goes                                                                                                                                | `rpc/server.ts#RpcServer.#broadcast`, `#drop` (`notify` default true; `onClose` passes false)                                                         |
| The lifetime lock: exclusive, never released while the worker runs; watched in shared mode                                                                                                                                        | `rpc/lifetime.ts#holdLifetimeLock` (callback returns a never-settling promise), `#watchLifetimeLock`                                                  |

### 4. The worker host

| Claim                                                                                               | Backed by                                                                                              |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Worker kinds told apart by `importScripts` and `onconnect`                                          | `entries/worker.ts#dedicatedWorkerScope`, `#sharedWorkerScope`                                         |
| A dedicated worker's global is the port, attached at load                                           | `entries/worker.ts` (`createServer(…).attach(dedicated)`)                                              |
| SharedWorker: listener at load; ports wait for the lifetime lock; one server for every port         | `entries/worker.ts` (`waiting`, `holdLifetimeLock(lockManager()).then(…)`)                             |
| `createServer`: one `Engine`, one `RpcServer`; `HostedPersistence`, `ClearOnlyPersistence`, or none | `entries/worker.ts#createServer`; `persist/clear-only.ts#lazyIdbStore` (undefined without `indexedDB`) |
| `connectInProcess` builds the same pair over a `MessageChannel`                                     | `client/in-process.ts#connectInProcess`                                                                |
| Hub: every tab reads `shared`; a new tab draws three days at once and fetches only the forming bar  | hub `react-lwcharts` `lookFor`                                                                         |

### 5. The orchestrator

| Claim                                                                                                                                                                          | Backed by                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No fetcher or `cacheOnly`: one `Engine.get`                                                                                                                                    | `orchestrator/orchestrator.ts#Orchestrator.get`                                                                                                             |
| A round is synchronous from the coverage read to listing its fetches; coverage read one slot beyond                                                                            | `#Orchestrator.#round` (no `await`; `probe`), its TSDoc and that of `#Orchestrator.get`                                                                     |
| `planRound`: need minus blocked; joins in-flight fetches that meet it; fetches the rest; `coalesce` merges and extends by one slot                                             | `#planRound`, `#coalesce`                                                                                                                                   |
| Joinable: current cache and auth generations, not fenced                                                                                                                       | `#Orchestrator.#round` (`joinable` filter); `#Orchestrator.invalidate` (`fenced = true`)                                                                    |
| `#run` passes copies of the range and a clone of the context; decides in one step; drops after a clear; else applies with the range as authority; leaves the list in that step | `#Orchestrator.#run` (`structuredClone(context)`, generation check, `finally leave()`), `#Orchestrator.#apply` (`engine.put(cacheId, response, { range })`) |
| A second round only after a clear, minus failed and auth-pending ranges; then one read; `annotate` labels                                                                      | `#Orchestrator.#rounds`, `#blockedBy`, `#annotate`                                                                                                          |
| `isAuthInvalidError`; only the current auth generation flips; `authInvalid` once per flip; gated rounds                                                                        | `#Orchestrator.#refused`; `orchestrator/auth.ts#AuthState.invalidate`; `#Orchestrator.#round` (`gated`)                                                     |
| `updateAuth` one at a time; hook hears a clone; context and generation switch together                                                                                         | `#Orchestrator.updateAuth` (`#authUpdate` chain)                                                                                                            |
| `load` once per server; another module is a `ConfigError`; a different context goes through `updateAuth`                                                                       | `#Orchestrator.load`                                                                                                                                        |
| Hub: **Candles with weekend gaps**, earlier fortnight; **Two tabs, one SharedWorker**, expire token                                                                            | hub `solid-lwcharts` and `react-lwcharts` `lookFor`                                                                                                         |

### 6. The engine

| Claim                                                                                                         | Backed by                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Get-or-create; `STRUCTURAL` fields must agree or `ConfigError`; joining version and watermark ignored         | `engine/engine.ts#Engine.cache`, `#STRUCTURAL`, `#assertCompatible`                                                                                             |
| Synchronous, no timers; `clearAll` keeps caches and configs                                                   | `engine/engine.ts` header ("No DOM, worker or timer use"); `#Engine.clearAll`                                                                                   |
| `put` validates the whole batch first; alignment, ascending, lengths, range; copies into the dtypes           | `engine/batch.ts#validateBatch`, `#assertTimestamps`, `#assertInside`; `engine/cache.ts#CacheState.put`                                                         |
| `#putValid` order: version clear, write, watermark, coverage claim minus provisional, then the clear's report | `engine/cache.ts#CacheState.#putValid`, `#applyVersion`, `#cover`                                                                                               |
| `#setWatermark` withdraws coverage from the new slot on when the provisional region grows                     | `engine/cache.ts#CacheState.#setWatermark`                                                                                                                      |
| `hydrate` writes only unknown parts below the provisional region; refuses another version                     | `engine/cache.ts#CacheState.#hydrateValid`, `#unknownParts`                                                                                                     |
| `read`: present points, covered sub-ranges, `'uncached'` misses; slots become ms                              | `engine/read.ts#read`                                                                                                                                           |
| Hub: **Live server metrics**: one fetch, then the provisional tail; **Restate history**: version clear        | hub `vanilla-uplot` `lookFor`; `examples/mock-backend/src/backend.ts` (`v${version}` in `meta`); `examples/vanilla-uplot/src/session.ts` (`on("cacheCleared")`) |

### 7. Segments and coverage

| Claim                                                                                                 | Backed by                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `grid.ts` alone converts ms and slots; reads snap out, a put's authority in                           | `grid.ts` header; `#snapOut`, `#snapIn`; `engine/batch.ts#validateBatch` (`snapIn`)                                  |
| `SegmentStore.put` carves the authority first, then writes run by run; `#together` is the layout rule | `engine/merge.ts#SegmentStore.put`, `#SegmentStore.#carve`, `#SegmentStore.#insertChunks`, `#SegmentStore.#together` |
| A `DenseSegment` stores no timestamps; typed array per field; one presence bit per slot               | `segment/dense.ts#DenseSegment` (header, `#mask`)                                                                    |
| `mergeFrom` with an authority leaves exactly the given points; without, adds or overwrites            | `segment/types.ts#Segment.mergeFrom`                                                                                 |
| `add` merges overlapping and adjacent; `subtract` may split; `gaps` gives the misses                  | `coverage.ts#CoverageIndex.add`, `#CoverageIndex.subtract`, `#CoverageIndex.gaps`                                    |
| Hub: greenhouse charts break together; zooming inside the loaded week fetches nothing                 | hub `solid-uplot` and `vanilla-uplot` `lookFor`                                                                      |

### 8. Persistence

| Claim                                                                                                                                                    | Backed by                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persist/` imports the engine, never the reverse; internal access no entry exports; `installRestore` at construction                                     | the package map's generated graph; `engine/engine.ts#cacheStateOf`, `engine/cache.ts#cacheInternals`; `persist/persister.ts#Persister` (constructor)              |
| `HostedPersistence` loads `persist/lazy.ts` at the first persisted cache or `clearAll`; calls wait in order; a failed or late load turns persistence off | `persist/hosted.ts` header, `#HostedPersistence.open`, `#HostedPersistence.durably`                                                                               |
| `open`'s deadline `timeoutMs` (5000); flush due `debounceMs` (1000) after the latest change, by `maxDelayMs` (5000); planned from memory                 | `persist/persister.ts#PersisterOptions`, `#Persister.open`, `#Persister.#plan`                                                                                    |
| `durably` holds the answer until a recorded removal is durable or persistence stopped                                                                    | `persist/persister.ts#durably`                                                                                                                                    |
| `QuotaExceededError` stops the cache at once; `persistStopped` reaches every tab                                                                         | `persist/persister.ts#Persister.#rejected`; `entries/worker.ts#createServer` (`onStopped` → `server.persistStopped`); `rpc/server.ts#RpcServer.persistStopped`    |
| `tscache` database, version 1, `caches` and `pages`; a page record holds a page's snapshot                                                               | `persist/idb-store.ts` header and constants; `persist/records.ts#PageRecord`                                                                                      |
| `ClearOnlyPersistence` persists nothing; its `clearAll` empties the database                                                                             | `persist/clear-only.ts#ClearOnlyPersistence`                                                                                                                      |
| No hub scenario persists; every app builds workers as ES, so the chunk stays separate                                                                    | a grep finds no `persist` option in `examples/*/src` or `reference/*/src`; `worker: { format: "es" }` in all ten `vite.config.ts` files; `persist/lazy.ts` header |

### 9. The Vite plugin

| Claim                                                                                                                                          | Backed by                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The worker needs the fetcher's default export; `?worker&url` drops exports; `?fetcher` gives its URL                                           | `vite/fetcher-url.ts` header and `#fetcherUrl` TSDoc; `orchestrator/orchestrator.ts#Orchestrator.#import` |
| Build: a chunk with `preserveSignature: 'strict'`; dev: `devUrl` for the browser, absolute path for server code; server build: `serverFileUrl` | `vite/fetcher-url.ts#fetcherUrl` (`load`, `resolveFileUrl`); `vite/urls.ts#devUrl`, `#serverFileUrl`      |
| `generateBundle` fails on the preload helper in the fetcher's chunk graph                                                                      | `vite/fetcher-url.ts#fetcherUrl` (`generateBundle`, `vite:preloadError`)                                  |
| `buildStart` warns once for IIFE workers in a browser build; never changes the format                                                          | `vite/fetcher-url.ts#fetcherUrl` (`buildStart`, `warned`), `#IIFE_WARNING`                                |
| Imports nothing from Vite, not even types                                                                                                      | `vite/fetcher-url.ts` header (its only import is `./urls`)                                                |
| Every app uses `fetcherUrl()` and imports its fetcher with `?fetcher`                                                                          | a grep finds both in all ten apps; `examples/react-lwcharts/src/client.ts`                                |

## Contradictions between the code and `docs/architecture.md`

The page follows the code in each case; neither the code nor the architecture document was changed.

1. **§4 module layout, `entries/vite.ts`:** "imports Vite's types only, so it adds no runtime
   dependency". The code imports nothing from Vite, not even its types: `vite/fetcher-url.ts` declares
   the shapes it uses, so Node's types stay out of the library's type check.
2. **§4 module layout, `segment/types.ts`:** lists the `Segment` interface as "lookup / slice /
   mergeFrom / transferPayload". The interface also has `countIn` and `sliceInto`, which the read path
   uses to copy each point once (`engine/read.ts#collect`).
3. **§4.7, the `transferablesOf` signature:** shown as taking `{ timestamps?, fields? }`. The code also
   takes `snapshot?` and adds each payload's mask and field buffers; §4.7's own "Transfer" rule
   already says so, so only the signature block is stale.
4. **§4.7 "Dispatch":** "`op` maps one-to-one onto `Engine` … Params are passed through to the
   engine". In the code `get`, `invalidate` and `updateAuth` go to the `Orchestrator`, and every op
   that names a cache runs through the persistence's `durably` when there is one
   (`rpc/server.ts#RpcServer.#handlers`). §4.9 and §4.10.8 describe this correctly; §4.7 was written
   before them.
5. **§4.7 "Entries":** "The entry imports `Engine` and `RpcServer` only", and "SharedWorker
   `onconnect` arrives at step ⑩". `entries/worker.ts` also imports the persistence classes and the
   lifetime lock, and listens with `addEventListener("connect")`; the §4 layout block was corrected at
   step 59, this rule was not.
6. **§6.1 (coverage index), "n stays small … tens of ranges":** `coverage.ts`'s header agrees, but
   the orchestrator's comment on `planFetches` says coverage "can hold thousands of fragments (step 36
   R1-1)", and its sweeps are linear for that reason; §4.9.1 rule 13 budgets the same case. Not a
   behaviour difference: the rationale in §6.1 understates the case the code is tuned for.

No contradiction affects behaviour. Items 3 to 5 are text that predates later steps.

## Verification

For the rebuilt check (the first commit's results, with the scanner, are in the round sections and in
the step's history):

- `bunx vitest run site/scripts/check-doc-anchors.test.ts`: 79 passed.
- `bun site/scripts/check-doc-anchors.ts` on the final tree: "doc-anchors: 246 anchors in 42 pages
  resolve", the same count the scanner reported before it was removed.
- A deliberately broken anchor and a deliberately wrong link target fail it. With the tour's
  `orchestrator.ts#coalesce` renamed to `#coalesceMisses` and the `engine/read.ts#read` link pointed
  at `engine/cache.ts`, the check exits 1 with two problems: `site/how-it-works/code-tour.md:165`
  "…/orchestrator.ts declares no coalesceMisses" and `site/how-it-works/code-tour.md:223` "the link
  points to …/engine/cache.ts, not …/engine/read.ts". Both edits were undone, and the check passes
  again.
- `bun run docs:check` passes (`tsc -p site`, `tsc -p site/scripts`, the module-graph check, the
  anchor check).
- `bunx biome check`, `bunx knip` and `bun run fallow` pass on the changed files.
- Three mutations of the page reader (no per-token line, no frontmatter offset, every link taken as
  the anchor's whole text) each fail at least one test; each was undone.
- `~/code/tscache-reports/bin/heavy-run.sh "61 redesign: ci" bun run ci` runs on the final head,
  after this file's commit; its result is in the report to the director.

## Not verified

- The tour page was not opened in a browser; the build renders it, and it has no diagram.
- The demo-hub scenarios were read from the hub's catalog and the examples' source, not run.
- The renderer's line numbers are tested for the block kinds the pages use (headings, paragraphs,
  list items, blockquotes, tables) and after frontmatter; other block kinds (footnotes, containers)
  carry inline content the same way but were not tested.

## Pre-review (Claude), not the gate

Before Codex round 1, a fresh-context Opus pre-review checked the tour against the source and the
anchor check for wrong accepts and rejects. No P0 or P1. Eight P2 findings, each checked against the
code and fixed in `fix(docs): step 61 pre-review fixes to the tour and the anchor check`:

1. The check accepted a file Git does not track (a build output under `dist/`), whose GitHub link is
   dead. Fixed: `repoReader` reads only files `git ls-files` lists; tests for an unlisted file.
2. A failing `git ls-files` let the check pass with no page checked. Fixed: it exits 1 when Git fails
   or lists no page. (`scripts/test-clocks.ts` has the same gap; left for a later step.)
3. A type literal among a class's or interface's type arguments is taken for its body, so a real
   member is reported missing. Not fixed in the scanner (no source uses the shape); listed above among
   its limits, with `import type Foo from`, and the earlier "never stricter" claim corrected.
4. The refusal of a path that leaves the repository had no test. Fixed: one test.
5. Stop 4 credited `createServer` with choosing the persistence; the entry chooses and passes its
   choice. Reworded.
6. Stop 8 said writes are behind; removals request a flush at once. Reworded.
7. Stop 8 said every call waits while the persistence chunk loads; only opens, ops on a cache whose
   open waits, and everything after the first op that waits do. Reworded, as `persist/hosted.ts` says.
8. Stop 5 said only the older fortnight is fetched (the provisional right-edge slot is too) and that
   the fetcher module loads once per server (a failed import is retried). Reworded.

Smaller points also fixed: `handshakeTimeoutMs` must be finite; `CacheHandle.on` sends nothing;
`instanceof` naming applies to library errors only; the `Persister` anchor now points at its
declaration in `persist/persister.ts`, not the re-export; over-wide lines rewrapped.

## Round 1 — reviewer verdict: merge after fixes

Two P1 findings (2026-11-11), both reproduced and fixed in `fix(docs): step 61 round 1, regex after a condition and titled links`:

1. **A `/` after a control keyword's condition was read as a division.** For `if (ready) /[{]/.test(value);`
   the regular expression's `{` opened a false block and hid later declarations, so a valid anchor
   failed. Fixed: the scanner records, for each `(`, whether it opens the condition of `if`, `while`,
   `for` or `with`, and reads a `/` right after the matching `)` as a regular expression. Test: a
   class declared after two such lines, with a parenthesised division beside them.
2. **A link with a title was taken for a bare anchor,** so its target was never compared:
   ``[`…#slotOf`](https://example.com/wrong "title")`` passed. Fixed: the link pattern accepts a
   `"…"`, `'…'` or `(…)` title, and a link after an anchor that the pattern still cannot parse (for
   example `](<…>)`) is reported, never treated as bare. Tests: a titled link to the right and the
   wrong target, and an unparsed link.

## Pre-review before round 2 (Claude), not the gate

No P0. Two P1 findings, both reproduced, each the same kind as a round 1 finding, so both areas were
redesigned rather than patched again (`fix(docs): step 61, redesign the regex rule and the link
forms`):

1. **Regex or division.** A `/` after `${` and after `...` was still read as a division, and a `{`
   inside the regular expression then hid every later declaration. The rule is now reversed: a `/`
   divides only right after a value, and starts a regular expression anywhere else, so a misread costs
   at most the rest of one line. Code resumes after `${` as after an opening brace. Run over all 242
   tracked TypeScript sources of the package, reference clients, integrations and scripts, the old and
   new scanners find exactly the same declarations.
2. **Link forms.** A reference link around an anchor (`[…][g]`, `[…][]`, and a shortcut with a
   definition) was taken for a bare anchor, so its target was never compared. The check now collects
   the page's reference definitions and resolves every form; one it cannot read is reported.

One P2, fixed: the test counts in this file were stale (now 60).

## Second pre-review before round 2 (Claude), not the gate

No P0. Three P1 and two P2 findings, all reproduced, fixed in `fix(docs): step 61, a balance check
behind the scanner and links with more text`:

1. **More divisions read as regular expressions:** after `x!`, `i++`, and a keyword used as a
   property name (`s.in / s.out`). Fixed in the rule (postfix operators keep a value, a word after
   `.` or `#` is a property name). Because the same rule drew a third finding, the scanner no longer
   depends on the rule being complete: the bracket tree reports where it stops balancing, and a
   symbol the check cannot find in such a file is reported with that line. Every tracked TypeScript
   file balances, and the old and new scanners find the same declarations in all 351.
2. **No test failed when every `/` was read as a regular expression.** The division fixtures now
   unbalance the brackets when misread, and each rule was checked by mutation (see Tests).
3. **An anchor that is only part of a link's text** (`[the `…` helper](…)`) was treated as bare.
   It is now reported: the link's text must be the anchor alone, so its target can be checked.
4. (P2) A definition-shaped line inside a paragraph was taken for a definition. Definitions now
   count only where CommonMark allows them.
5. (P2) The JSX limit understated its effect. Restated here and in the script's header.

This is the second pre-review for round 2, the most the brief allows; round 2 follows.

## Round 2 — reviewer verdict: merge after fixes

Three P1 findings (2026-11-11), all accepted:

1. A shortcut reference whose text holds more than the anchor (``[the `…#slotOf` helper]`` with a
   definition) escapes the target check; `insideLink` looks only for inline and full reference
   suffixes.
2. A reference definition right after a heading, with no blank line, is ignored, although VitePress
   renders the link with it: a wrong destination passes, and a correct full reference fails.
3. The name of a named function or class expression (`export const impl = function ghost() {}`)
   counts as a top-level declaration.

Triage: the Markdown reading and the TypeScript scanning have each drawn findings in both rounds and
in both pre-reviews, which the review loop treats as a call to redesign rather than patch. Both
parsers the check needs are already in the repository with no new dependency: the site workspace
pins TypeScript 6 under an npm alias (`typescript: npm:typescript@6.0.3`, for TypeDoc), whose compiler
API reads declarations exactly, and VitePress's own Markdown renderer gives the link tokens exactly
as the site renders them. The check is rebuilt on those two (next commits), with every finding so far
kept as a regression test, before round 3.

## Redesign after round 2

Two commits: `ci(docs): rebuild the anchor check on real parsers` (the check, its test, the
`docs:check` line and the Vitest include) and `docs(review): step 61, the anchor check on real parsers`
(this file). The anchor-check sections above describe the result. The scanner, its bracket-balance
report and the regular-expression page reader are gone; there is no "unreadable link" any more,
because the renderer reads every link form the site renders.

What each finding so far became, each with a regression test in
`site/scripts/check-doc-anchors.test.ts`:

| Finding                                                                | Now                                                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Pre-review 1: an untracked file (a build output) resolved              | Kept: `repoReader` reads only files Git lists. Test unchanged.                                                                      |
| Pre-review 2: a failing `git ls-files` passed with nothing checked     | Kept, and now tested: `run` takes the lister, and exits 1 on Git failure and on no page.                                            |
| Pre-review 3: a type literal among type arguments taken for the body   | Gone: the parser reads the class body. Covered by the `Top.member` tests.                                                           |
| Pre-review 4: a path that leaves the repository                        | Kept: refused even when listed. Test unchanged.                                                                                     |
| Round 1, 1; pre-review 2, 1; second pre-review 2, 1: regex or division | Gone: the parser reads regular expressions. One test declares a class after each construct.                                         |
| Round 1, 2: a titled link taken for a bare anchor                      | Gone: the renderer gives the `href`. Tested with each title form, at the right and wrong target.                                    |
| Pre-review 2, 2: reference links taken for bare anchors                | Gone: the renderer resolves full, collapsed and shortcut references. Tested in each form.                                           |
| Second pre-review 2, 2: no test failed when every `/` was a regex      | Moot: the rule no longer exists. The line and link code were mutation-checked instead.                                              |
| Second pre-review 2, 3, and round 2, 1: an anchor in part of a link    | Read from the token structure. Tested for an inline link, a full and a shortcut reference, and emphasis.                            |
| Second pre-review 2, 4: a definition-shaped line inside a paragraph    | Gone: the renderer applies CommonMark's rule. Test unchanged in intent.                                                             |
| Second pre-review 2, 5: JSX unbalanced the scanner                     | Gone: `.tsx` and `.jsx` parse with JSX. Tested with a declaration after JSX and with a `.tsx` anchor.                               |
| Round 2, 2: a definition right after a heading was ignored             | Gone: the renderer reads it. Tested at the right and the wrong target.                                                              |
| Round 2, 3: a named function or class expression declared a name       | Gone: an expression's name is not a top-level declaration. Tested for both.                                                         |
| The unreadable-link rule (`](<…>)`, an undefined label)                | Angle-bracket and multi-line destinations are read and compared; an undefined label renders as text, so its anchor is bare. Tested. |

The traces and the tour page are unchanged; the check passes over them as before.

## Pre-review before round 3 (Claude), not the gate

The rebuild closed the TypeScript reading. One P1 and four P2 findings, all checked and fixed in
`fix(docs): step 61 pre-review before round 3`:

1. (P1) An anchor inside an inline HTML `<a>` in a paragraph passed with no target check. It is now
   reported; the check reads Markdown links only. The header and this file had said raw HTML holds no
   inline code, which is true of HTML blocks only.
2. (P2) Anchors in container titles (`::: tip <title>`) were never read; the site writes inline code
   in such titles. Titles are now parsed as inline Markdown and checked.
3. (P2) The moved test file was outside `bun scripts/test-clocks.ts`. Its globs now include
   `site/scripts/**/*.test.ts`.
4. (P2) No test showed the command exits 1 on a broken anchor. One now runs it on a temporary page.
5. (P2) The bare-name rule let a name resolve to any object key in the file. Dropped (see "What it
   accepts"); the member tests now name `Top.member`, and a test shows a bare name no longer reaches
   a member.

## Second pre-review before round 3 (Claude), not the gate

One P1 and two P2 findings, fixed in `fix(docs): step 61, HTML links page-wide and malformed
anchors`:

1. (P1) An `<a>` opened by an HTML block around a paragraph still wrapped an unchecked anchor; the
   previous fix covered inline HTML only. HTML `<a>` depth is now tracked across the whole page, from
   HTML blocks and inline HTML alike, and any anchor inside one is reported. Test: an HTML-block link
   around a paragraph, with an anchor after it that stays bare.
2. (P2) A token shaped like an anchor whose symbol does not match the anchor pattern was skipped,
   link and all. It is now reported as not checkable.
3. (P2) The Scope table placed the sidebar entry after "Data model"; it is last, after "Live feeds".

Removing the HTML-block rule makes the new test fail. A round 3 chain had started before this
pre-review ended and was stopped before the reviewer wrote a round file; round 3 runs on this head.
