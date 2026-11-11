# Step 61 — The code tour and the anchor check

Branch: `docs/61-code-tour` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: in review · Verdict after triage: fix and re-review (round 2 next)

Two parts. A check, run in `bun run ci`, that fails when a `path#symbol` anchor in `site/` no longer
resolves, and a "Code tour" page in "How it works" that reads the package source in the order a
request travels, each stop with its anchors, what to notice and a demo-hub scenario that shows it.
Every claim on the page was taken from the source, not from the existing docs; the traces below map
each one to the code that backs it.

## Scope

| Commit                                                                 | What                                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ci(docs): fail when a path#symbol anchor in site/ no longer resolves` | `scripts/check-doc-anchors.ts`, its Vitest file, and the one-line addition to the root `package.json` `docs:check` script. All 71 existing anchors resolved. |
| `docs(site): add the code tour to "How it works"`                      | `site/how-it-works/code-tour.md` (85 anchors), its sidebar entry after "Data model" in `site/.vitepress/config.ts`, and a link from the overview page.       |
| `docs(review): step 61, the code tour and the anchor check`            | This file.                                                                                                                                                   |

`package.json` is a protected path, so the user merges this pull request. The change there is the one
`docs:check` line: `… && bun site/scripts/module-graph.ts --check && bun scripts/check-doc-anchors.ts`.
`scripts/ci.sh` is unchanged; it already runs `docs:check`.

## The anchor check

### Where it lives

`scripts/check-doc-anchors.ts`, the path the plan names, rather than `site/scripts/`. Vitest already
collects `scripts/**/*.test.ts` (`vitest.config.ts`), and `tsc -p .` in `bun run typecheck` checks
`scripts/`; a test under `site/scripts/` would have needed a new Vitest include. Vitest runs under Node,
so the scanner and everything the test imports use `node:fs` only; the script's command-line part uses
`Bun.spawnSync`, as `scripts/test-clocks.ts` does, behind `import.meta.main`.

### What it accepts

- **Anchors.** An inline-code span whose whole text is `<path>#<symbol>`, where `<path>` is a
  repository-relative file ending in `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` or `.cjs`,
  and `<symbol>` is an identifier or `Top.member` (the member may be a `#private` name). Placeholders
  such as `path#symbol` (no extension), VitePress region includes (`<<< @/snippets/x.ts#region`, not
  inline code) and code inside fenced blocks are not anchors. Every page Git lists under `site/`
  (tracked or new, not ignored) is read.
- **Links.** When the anchor is a link's whole text, the target must be exactly
  `https://github.com/anishbenji/tscache/blob/main/<path>`. The check reads inline links
  (`[`…`](target)`, with or without a title) and reference links (`[`…`][label]`, `[`…`][]`, and a
  shortcut `[`…`]` with a definition on the page). A form that opens a link but that it cannot read
  (`](<…>)`, a reference to an undefined label) is reported, never treated as bare, and so is an
  anchor that is only part of a link's text (`[the `…` helper](…)`). A definition is one only where
  CommonMark allows it (at a block's start or after another definition), not inside a paragraph. A
  bare anchor, not linked, is checked for its file and symbol only.
- **Files.** The path must name a file under the repository root that Git lists (tracked, or new and
  not ignored): a build output such as `packages/tscache/dist/` has no page on GitHub, so it does not
  resolve. The check exits 1 when `git ls-files` fails or lists no page, rather than passing with
  nothing checked.
- **Declarations.** `<symbol>` resolves when the file has:
  - a top-level `function` (generators and `async` included), `class` (`abstract` included), `const`,
    `let`, `var`, `type`, `interface`, `enum` or `const enum`, exported or not, `declare` included;
  - a name in a top-level `export { … }` or `export type { … }` clause, re-exports from another module
    included, under its exported name (`a as b` declares `b`);
  - a member anywhere in the file of a class body, an interface, an object literal, an object type or
    an enum: methods, `get`/`set` accessors, properties, `#private` names, shorthand properties, enum
    members, and constructor parameter properties (`constructor(private readonly x)`).

  `Top.member` resolves only when `Top` is a top-level declaration and `member` is a member of the body
  that declaration owns: the class, interface or enum body, or the object literal or object type it is
  initialised with or annotated with, including the first object argument of a call in its initialiser
  (`Object.freeze({ … })`).

The export-clause rule is a decision taken here: the brief's list of kinds does not name it, but the
step 59 anchors on the package map point at the entries (`entries/index.ts#createClient` and four
more), whose API is a list of re-exports. Without the rule they would fail although they name exactly
what the entry exports.

### How it reads a source, and what it cannot see

TypeScript 7 ships no JS API and no dependency may be added, so the check reads declarations with a
scanner instead of a parser. A first pass replaces comments, the contents of string literals, whole
template literals (interpolations included, nested ones tracked) and regular-expression literals with
spaces, keeping every newline and offset. A `/` is a division only right after a value: a name or
number (not a keyword such as `return`), a `)` that does not close the condition of `if`, `while`,
`for` or `with`, a `]`, or the end of a string, template or regular expression. A postfix `!`, `++`
or `--` leaves a value a value, and a word after `.` or `#` is a property name, not a keyword.
Anywhere else, including after `${` and `...`, it starts a regular expression. The check does not
rely on that rule being complete: a misread that wipes a bracket leaves the brackets unbalanced, and
a symbol the check cannot then find is reported with the line where they stop balancing, rather than
as a plain missing symbol. All 351 tracked TypeScript files of the repository balance. A second pass builds the
tree of `{}`, `()` and `[]` pairs and judges each brace by the text before it: a class body after
`class`, an object (members) after `interface`, `enum`, `=`, `(`, `,`, `:`, `[`, `?`, `|`, `&`, `<`
or `return`, and a block otherwise (after `)`, `=>`, a keyword such as `else`).

It cannot see:

- names bound by destructuring (`const { a } = …`) or by a second declarator (`const a = 1, b = 2`
  finds `a` only);
- names an `export * from` re-exports, a `namespace` or `declare module`'s contents as top-level
  names, or `export default` of an expression;
- quoted or computed member names (`"a-b": 1`, `[key]: 1`), and parameters other than constructor
  parameter properties;
- JSX: a closing tag's `/` starts what the scanner takes for a regular expression, so a `.tsx` file's
  brackets stop balancing; no anchor names a `.tsx` file today.

A brace it takes for an object literal although it is a block (`case x: { … }`) can lend a statement
a false member, which makes the check more lenient. A type literal among type arguments or parameters
before a body (`class C<T extends { a: 1 }> { … }`, `class C extends B<{ a: 1 }> { … }`,
`interface I<T extends { a: 1 }> { … }`) is taken for the body, so `C.a` resolves and a real member
such as `C.run` is reported missing; nothing in the package uses that shape today. `import type Foo
from "./x"` is read as declaring `Foo`. Members are found per chunk of a body's own text split at
`,`, `;`, newlines and nested blocks, which relies on the code being formatted as Biome formats it.

Run over the package source, it finds what a reader would: for `orchestrator/orchestrator.ts` the
top-level types and functions (`coalesce`, `planRound`, `blockedBy`, `annotate`, …) and every member of
`Orchestrator`, its `#private` fields and methods included; for `entries/index.ts` the 37 names of its
export clauses.

### Tests

`scripts/check-doc-anchors.test.ts`, 68 tests, no clock: an anchor that resolves; a missing file; a
missing symbol; a link that points at another file; the reported file, line and anchor; a bare anchor;
what is not an anchor (a placeholder, fenced code, a region include, a Markdown path); each
declaration kind above, one test each; each member kind; `Top.member` against the declaration's own
body, and its failures; and what declares nothing (a comment, a string, a template literal, a regular
expression, a function's local, a call), with a division and a regular expression containing `}`
before a declaration, and the scanner keeping every offset and line; and the repository reader, which
reads a listed file and refuses an unlisted one and a path that leaves the repository; titled,
reference and unreadable links, an anchor that is only part of a link's text, and a definition-shaped
line inside a paragraph; a `/` after a condition, an interpolation and a spread (a regular
expression) and after each kind of value, postfix operators and property names included (a
division, in fixtures where a misread would unbalance the brackets); and the line reported when the
brackets stop balancing. Each rule of the regex-or-division decision and the balance check was
mutated in turn (always a regular expression, no postfix rule, no property rule, no stray-closer
detection) and each mutation fails at least one test.

### Anchors fixed in today's site/

None. The check found all 71 anchors of `site/how-it-works/` resolving (`index.md` 34, `data-model.md`
28, `package-map.md` 9), and no other page has one.

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

- `bunx vitest run scripts/check-doc-anchors.test.ts`: 68 passed.
- `bun scripts/check-doc-anchors.ts` on the final tree: "doc-anchors: 156 anchors in 35 pages
  resolve" (71 before the tour, 85 on it).
- A deliberately broken anchor fails it. With the tour's `orchestrator.ts#coalesce` renamed to
  `#coalesceMisses` and its link pointed at `orchestrator/auth.ts`, `bun run docs:check` exits 1 with
  two problems on `site/how-it-works/code-tour.md:161`: "the link points to …/orchestrator/auth.ts,
  not …/orchestrator/orchestrator.ts" and "…/orchestrator.ts declares no coalesceMisses". The edit
  was undone, and the check passes again.
- `bun run docs:check` passes (`tsc -p site`, `tsc -p site/scripts`, the module-graph check, the
  anchor check).
- `bun run docs:build` builds the site; the tour page renders.
- `bunx biome check` and `bun run fallow` pass on the changed files (Fallow's complexity gate required
  splitting the scanner into small functions; it reports no finding).
- `bunx tsc -p .` type-checks `scripts/`.
- `~/code/tscache-reports/bin/heavy-run.sh "61 child: ci" bun run ci` on the final head: see the report.

## Not verified

- The tour page was not opened in a browser; the build renders it, and it has no diagram.
- The demo-hub scenarios were read from the hub's catalog and the examples' source, not run.
- The scanner was run over `packages/tscache/src/` and the site's anchors, not over other code bases;
  its limits above are from its design, with a test for each kind it accepts.

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
