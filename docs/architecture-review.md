# Post-build architecture review: agenda

The commit plan (starter §11, steps ①–⑭) is complete. Four questions were deferred to a review after
the build, each recorded where it arose. This document prepares that review: for each item, the
context with its sources, the decision points, the options with their pros and cons, and a
recommendation. The user decides; nothing here is settled. Decisions land as rows N34 onward in
`docs/architecture.md` §8, each with the alternatives it rejected, and as the steps listed at the end.

**Decided 2026-10-23:** the user took the recommended option at every decision point. The decisions are
rows N34–N44 in `docs/architecture.md` §8; the one point this agenda left open (D6, whether
`connection.ts` keeps seeding only the first client) is proposed in the step ⑮ architecture text.

The items, heaviest first:

1. A snapshot API over the segment payload, which also closes the seed race (R2-2).
2. A `tscache/vite` entry for the fetcher-URL plugin.
3. DC-1: the refresh snippet assumes a refresh issues a new access token.
4. DC-2: two ways a client can stop being served that N32 does not detect.

## 1. Snapshot API and the seed race

### Context

Server rendering hydrates the browser's cache through the public API only (step ⑬ decision,
2026-10-11): the server reads with an in-process client, writes the answer's present points and
coverage ranges into the page, and the browser puts each covered range back with that range. Two
copies of this helper exist, `examples/mock-backend/src/hydration.ts` (`putSeeds`, ⑬b) and
`integrations/shared/hydration.ts` (`putCovered`, ⑭), each with its own base64 encoding and
uncovered-range arithmetic. Both carry two recorded defects:

- **No version or watermark travels** (`docs/reviews/step-13.md`, ⑬b merge request). A seed is as old
  as the page. If the dataset version changed after the server's read, the browser puts restated
  history as covered, and nothing can notice: a `put` carries no version unless the app threads one,
  and threading one through `meta.version` would be worse, because a mismatch clears the cache and
  adopts the seed's older version (§4.5). The integrations therefore seed only the first client
  (`connection.ts`); a replacement after `workerLost` starts empty.
- **The coverage check and the put are two requests** (`docs/reviews/step-14.md`, R2-2, escalated).
  `putCovered` reads `get(range, { cacheOnly: true })`, subtracts, then puts. With a SharedWorker,
  another tab's fetch that lands between the two is replaced by the seed's ranged put (N11), so newer
  data is overwritten with older. The public API has no put that applies only where nothing is
  covered, so the browser side cannot close the window. Values change only when the backend changed
  covered history after the server's read, which is the first defect again; the two are one problem.

Two locked texts bear on the shape of the fix:

- **One format, three uses** (starter §3.7, architecture §3.4): the segment transfer payload is the RPC
  wire format, the persistence value and the SSR hydration payload. The current SSR path does not use
  it; it serialises a present-points read. The review decides the shape that honours the invariant.
- **The persistence sketch** (`docs/roadmap.md`) stores page records of segment payloads plus one cache
  record with the config, the version, the watermark and the coverage, and reconciles on load: a
  record whose version differs is discarded, and covered ranges whose page is missing are subtracted.
  The roadmap already asks for the snapshot API and persistence to be designed together. The apply
  rules proposed below are the load-time reconciliation the sketch describes.

Where atomicity comes from: the RPC server maps each request to one engine call (§4.7,
`rpc/server.ts`), and every call that writes a cache (`put`, `invalidate`, `clear`, `clearAll`,
`setFinalizedUntil`) is synchronous; an orchestrated `get` applies its response through the same
`engine.put` when its fetch resolves. Between two messages no other write runs. An op that subtracts
coverage and puts inside one engine call therefore cannot interleave with another tab's write. That is
what R2-2 needs and what the engine already provides; only the public surface is missing.

### Decision points

**D1. What a snapshot carries.**

| Option | What it is | Pros | Cons |
|---|---|---|---|
| **A. Segment payloads, clipped to the range** (recommended) | `{ format, interval, alignmentOffset, fields, version?, finalizedUntil?, coverage: Range[], segments: DenseSegmentPayload[] }` for the request range: the grid and schema of the cache, the covered sub-ranges, the dataset version and the watermark in force, and the payloads of the present points inside the range | Honours §3.4 as written; the envelope is the persistence sketch's cache record and `segments` its page content; the grid and schema are checked against the receiving cache before anything is applied, so a snapshot that holds no segment (a confirmed gap) is checked too, and `segmentFromPayload` checks each payload again (mask, sizes, alignment); a snapshot from a cache with another config is refused with `TscacheError`; equal data gives equal payloads (N15) | Needs a range-clipped payload (today `transferPayload()` is whole-segment): build a temporary segment from `slice(range)` or add a clipped payload method; a dense payload carries absent slots as zeros, bounded by the K-gap split |
| B. The read result plus metadata | `GetResult` columns, coverage, version, watermark: today's seed with the two missing fields | Smallest change to the helpers that exist; compact for sparse data | A second serialised format next to the payload, which starter §3.7 locks against: the user would have to unlock it; persistence would still need the payload path, so two decoders |
| C. Whole segments that intersect the range | `transferPayload()` of each segment the range touches | No clipping code | A daily series keeps decades in one segment (cap 32 768 slots), so a 200-candle page would serialise everything the server ever fetched |

**D2. How a snapshot is applied: the `hydrate` op.** One engine call with these rules, proposed for
the architecture text:

- *Version precondition.* If the snapshot and the cache both have a version and they differ, nothing
  is applied and the result says so. A `put` with `meta.version` clears and adopts (§4.5); a seed must
  never do that, since a stale page would wipe a newer cache. An unversioned cache adopts the
  snapshot's version without clearing, as N18 does for the first versioned put.
- *Fill only where uncovered.* For each covered range of the snapshot, subtract the cache's coverage;
  the points inside each remaining part are put with that part as their range. Replacing inside an
  uncovered part is right: what is there is provisional or was never authoritative. Covered slots are
  left alone, so another tab's fetch is never overwritten (R2-2).
- *Watermark.* The snapshot's `finalizedUntil` travels as `meta.finalizedUntil` (forwards only, N17);
  the claim is clipped at the receiving cache's watermark by §4.5 and at the snapshot's own by N19, so
  a seed can neither cover a slot the browser calls provisional nor one the server did.
- *The snapshot's own provisional tail* (points outside its coverage), three choices:

| Option | Behaviour | Pros | Cons |
|---|---|---|---|
| **i. Drop** (recommended) | Not applied; the browser fetches the tail, as today | Matches the tested behaviour of ⑬b and ⑭; the integrations keep the server's answer on screen until the first live read, so nothing visible is lost | The first `get` after hydration always fetches the tail |
| ii. Fill absent slots only | Upsert into slots with no present point | Shows at once and never overwrites a newer provisional point from another tab | Needs a fill-absent primitive the engine lacks |
| iii. Plain upsert | `put` without a range | Simplest | Can replace a newer provisional point with an older one until the next `get` refetches it |

- *Result.* `{ applied: Range[]; skipped?: 'version-mismatch' }`: what was written, for tests and logs.
- *Errors.* A snapshot whose `format` is unknown, or whose grid or schema differs from the cache, throws
  `TscacheError` before anything changes: the envelope is checked first, so a snapshot with no segment
  cannot mark a range covered on another grid, then each payload by the `segmentFromPayload` rules
  (§4.2); an unknown cache throws `UnknownCacheError` as every op does.

**D3. Where it lives.**

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **A. A `get` option** (recommended) | `get(range, { snapshot: true })` resolves with the result and its `snapshot`, both taken from the one engine read that follows the fetches the read awaited (§4.9); `CacheHandle.hydrate(snapshot)`; `Engine.snapshot(cacheId, range)` and `Engine.hydrate` for persistence and tests; one new op, `hydrate` | The page needs both forms (below) and gets them from one call and one state, so the columns and the snapshot cannot disagree; the smaller surface: one option, one method, one op | `GetResult` gains an optional field, and the `get` transfer path carries payload buffers when asked |
| B. Two handle methods | `CacheHandle.snapshot(range)` next to `get`; ops `snapshot` and `hydrate` | Symmetric; `get` unchanged | The server shares one client across renders (`serverClient`), so another render's fetch, and with it a version change, can land between a render's `get` and its `snapshot`: the page then carries columns of one version and a snapshot of the next. The cache stays right, since the snapshot's own version applies, and the display catches up at the first live read, but the window has to be documented |
| C. Seeds at open | `cache(config, { seed })` or a `seeds` client option applies at open | Removes the ordering code in `connection.ts` (seed before the first handle) | Couples opening with data; hides the result; A can grow this later |

**D4. Protocol version.** New ops are additive. A worker from before them (a stale cached script, N25)
answers `unknown op`, so `hydrate` rejects with `TscacheError` and the app fetches instead; the rest of
the API works. Recommended: `PROTOCOL_VERSION` stays 1, as N32 and N33 did for additive fields, and the
helper that applies a page's snapshot treats that rejection as "not seeded". The alternative, bumping
to 2, makes every tab of an old deploy reject `createClient` outright (N25: a mismatch never falls
back), which is harsher than the failure it prevents.

**D5. Text encoding.** A snapshot holds `ArrayBuffer`s and a `Uint8Array` mask; HTML needs text. Both
helpers today chunk `btoa` over the bytes so `NaN` survives (JSON turns it into `null`).

| Option | Pros | Cons |
|---|---|---|
| **A. Ship `encodeSnapshot`/`decodeSnapshot`** (recommended), base64 for buffers and JSON for the rest, from the `.` entry (`btoa`/`atob` exist in browsers and Node, no DOM) | The textual form is part of the API and tested once; every SSR app stops copying the same forty lines; a persistence layer does not need it (IndexedDB stores buffers) | Public surface for an encoding; the `<script>` escaping stays with the app, since it depends on how the page is built |
| B. Leave it to the app | No surface | Each app re-implements base64 and NaN handling; the integrations and the examples keep two copies |

**Two forms on the page.** The hydration render needs the server's answer as columns: the snippets
render from the seed's read on the server and again in the browser's hydration render
(`integrations/react/series.tsx`), before any client exists. The cache needs it as a snapshot. Either
the page carries both (about twice the bytes for the same points), or it carries the snapshot alone and
derives the columns with a public reader (`readSnapshot(snapshot, range): GetResult`), which brings the
segment decoder into the page bundle that the `.` entry keeps free of engine code today. Recommended:
both forms for now; a reader can be added later without changing the format.

**D6. Migration.** `putCovered`, `putSeeds`, `dehydrate`/`rehydrate` and the `Dehydrated`/`Hydration`
types go; the integrations' `Seed` carries the read and its snapshot; both SSR examples and the six integration
snippets move to `hydrate`. The seed-only-the-first-client rule in `connection.ts` can go too, since a
versioned snapshot is refused when stale, or stay as a belt for unversioned datasets; the review
decides. Callers migrate in the same step that adds the API, so no legacy path survives.

### What lands

An engine step, so strict test-first: architecture text first (a §2.8 "Snapshots" section, the §3.2
`Op` list, §4.5 and §4.6 contracts, rows in §8), approved by the user; then Codex contract tests from
that text; then the implementation, the migration of ⑬b and ⑭, and the guide's "Server rendering"
section rewritten. Suggested split: ⑮a library and wiring, ⑮b migration and docs, if the first review
loop runs long.

## 2. A `tscache/vite` entry

### Context

Vite bundles a `?worker&url` import as a worker entry without its exports (`docs/reviews/step-13.md`,
probe finding; `docs/guides/worker-setup.md`), so the fetcher module, which the worker `import()`s for
its default export, needs a plugin. The examples ship `fetcherUrl()` in
`examples/mock-backend/src/vite.ts`: a `?fetcher` import resolves to the module's URL with its exports
intact, served from source in dev and emitted as its own chunk with `preserveSignature: "strict"` in a
build, plus a `resolveFileUrl` hook that gives a server build a file URL. The guide reproduces it for
copying: about forty-five lines with three Vite-specific devices (a `\0`-prefixed virtual id,
`emitFile` of a chunk, the environments API in `resolveFileUrl`). The same file holds `ssrPage()`, the
examples' plain-Vite server-rendering harness.

### Decision points

**D7. Ship the plugin or document it.**

| Option | Pros | Cons |
|---|---|---|
| **A. `tscache/vite` exporting `fetcherUrl()`** (recommended), `vite` as an optional peer dependency, a Node-platform tsdown entry, a Vitest test that runs a programmatic Vite build and checks the chunk keeps its default export and the server build gets a file URL; the examples import it, so the Playwright `examples` project exercises it too | Every Vite user with a fetcher needs exactly this; the Vite devices it relies on drift across majors and belong in one tested place; precedent N6 added `./fetcher` for the same kind of ergonomics; starter §5 allows subpath exports with optional peers | New public surface with semver; a supported Vite range to state (the environments API is Vite 6 and later); a Node entry in a browser package (two tsdown configs); Knip and Fallow configuration for the optional peer |
| B. Keep it in the guide | No surface | Forty-five lines with internals users cannot judge; nothing outside the examples tests the copy; a Vite change breaks users silently |
| C. A separate `@tscache/vite` package | Clean dependency story | Rejected: starter §5 locks exactly one published package |
| D. Remove the need | Document a second Rollup input and a manifest lookup instead | Manual and brittle; a fetcher as anything but a module the worker imports is locked out by starter §3.5 |

**D8. Scope of the entry.** `ssrPage()` stays in the examples: it encodes example choices (the
`index.html` placeholders, `/` only, `vite build --app`, `require()` of the server bundle in preview)
and the library has no opinion on page rendering. Only `fetcherUrl()` is library-worthy. webpack needs
nothing: its users serve `dist/` and the fetcher as plain files.

### What lands

Not an engine step: tests with the code. A `feat/16-vite-entry` branch: the entry, the peer, the build
config, the test, the examples and the guide switched to the import.

## 3. DC-1: the refresh snippet assumes a refresh issues a new access token

### Context

`e2e/pages/auth-refresh.js` (copied as `examples/react-lwcharts/src/auth-refresh.ts`) refreshes under
a Web Lock when the stored access token equals `accessOf(context)` of the refused context (N33), and
adopts the stored tokens otherwise. The adversarial reviewer of ⑫b noted (`docs/reviews/step-12.md`,
DC-1): if a refresh returned the **same** access token with a new refresh token, every tab hearing one
refusal would refresh in turn, since each finds the refused token still stored. The rotations are
safe: each presents the current refresh token, never a spent one, so no session is revoked. The cost is
one redundant refresh per extra tab. The realistic case is an opaque access token whose server-side
expiry a refresh renews in place: the string stays the same, the retry succeeds, and only the
redundant refreshes remain. The mock backend rotates both tokens
(`examples/mock-backend/src/backend.ts`), so no spec exercises this case.

### Decision point

**D9. What to do about the precondition.**

| Option | Pros | Cons |
|---|---|---|
| **A. State it** (recommended) in the snippet header, the copy in the examples, and `docs/guides/patterns.md`: "a refresh must issue a new access token; otherwise each tab may refresh once, always with the current refresh token" | Cheap; the snippet is source the app adapts, and the app knows its backend | The redundant rotations stay possible on such a backend |
| B. A rotation stamp in the context: `toContext` adds a per-rotation id (a counter or the refresh token's digest stored beside the tokens) and the snippet compares ids, not access tokens | Snippet-only change; handles a reissued access token exactly | The stored tokens gain a field, the context carries a value the fetcher does not need, and every app's `toContext`/`accessOf` pair grows |
| C. An auth generation number in `authInvalid` | Exact at the library level | N33 considered and did not take it: the snippet would map generations to tokens; a library change for a snippet concern |

### What lands

A docs commit under A (snippet headers and the guide); under B, a snippet change with a harness
scenario in `e2e/pages/refresh-harness.js`.

## 4. DC-2: what N32 does not detect

### Context

N32 detects a worker whose global is gone: the SharedWorker holds a lifetime Web Lock, shared-mode
clients queue on it, and a grant means loss (§4.8, `rpc/lifetime.ts`). The ⑫b adversarial reviewer
named two cases outside it (`docs/reviews/step-12.md`, DC-2):

- **(i) A stolen lock.** A same-origin script can read the lock's name with `navigator.locks.query()`
  and take it with `steal: true`. Every client is then told `workerLost` while the worker runs on. The
  worker never requests its lock again (nothing tells it the lock went), so once the thief releases it
  the name is free: every client that connects to that worker afterwards, including the replacement the
  app creates on `workerLost`, is granted the lock at once and reports loss too. A recovery loop as in
  `docs/guides/worker-setup.md` then reconnects without end until the last tab closes the worker,
  whose cache stays intact throughout.
- **(ii) A dedicated worker that closes itself.** Only code running inside the worker can call
  `self.close()`, which means the fetcher module. The worker fires no `error`, so the client's calls
  hang. Dedicated and in-process hostings hold no lock by design (§4.8).

### Decision points

**D10. The stolen lock.**

| Option | Pros | Cons |
|---|---|---|
| **A. Record the assumption in §4.8** (recommended): same-origin scripts are inside the trust boundary (one can already connect to the worker and call `clearAll`, or terminate a dedicated worker); `steal` on a name read from `query()` is deliberate | Nothing to build; consistent with N28's "accept what is bounded" | A deliberate steal breaks every tab's recovery loop for the worker's lifetime |
| B. Verify before declaring: on the grant, send a `ping` op with a short deadline; an answer means a false alarm and the client watches again | No false positives from a steal | A new op and a timeout constant, which N32 avoided; a wedged worker that still answers pings is called alive |
| C. Check before watching: after `hello`, the client calls `navigator.locks.query()` and watches only if the named lock has a holder; otherwise detection is off for that client, as without Web Locks | No new op or timeout; ends the reconnect loop (a freed lock has no holder) | One asynchronous query per connection; a thief that keeps holding still causes one false loss per client when it lets go |

**D11. The self-closing dedicated worker.**

| Option | Pros | Cons |
|---|---|---|
| **A. Record the assumption** (recommended) in §4.8 and one sentence in the fetcher contract (§2.5): a fetcher must not close its worker | A self-inflicted programming error with an obvious cause; nothing to build | Such a fetcher hangs its tab's calls |
| B. Extend the lifetime lock to dedicated workers: the worker entry holds a lock in a dedicated scope too, `hello` names it, the client watches in dedicated mode; `close()` ends the realm and releases the lock | About twenty lines in known modules; uniform detection across hostings; a test with a fetcher that calls `close()` | Extends N32 beyond its approved scope; one Web Lock per tab for the life of the page, to catch a bug in the app's own module |
| C. Request timeouts | Catches every hang | Rejected under N32: a guess at what counts as dead, and an orchestrated `get` can legitimately take long |

### What lands

A docs commit under A for both (§4.8 assumptions, §2.5, a note in `docs/guides/worker-setup.md`);
under D11-B, a small library change with its tests on its own branch.

## Not on this agenda

Listed so the review can schedule them, not prepared with options here: N28 (a heartbeat for tabs that
die without `pagehide`) and N31 (subtracting in-flight ranges from new fetches), both deferred in
`docs/roadmap.md` until real usage shows the need; IndexedDB persistence, whose decision points the
roadmap lists and whose format item 1 settles; the reference clients (roadmap); and the tooling chores
in the backlog (the review watchdog in `scripts/`, `FALLOW_AUDIT_BASE` in `scripts/ci.sh`,
`check:integrations` in pre-push, type-checking `e2e/` and `scripts/`).

## Suggested sequence after the decisions

| Order | Work | Branch | Kind | Suggested model |
|---|---|---|---|---|
| 1 | DC-1 and DC-2 as documented assumptions (items 3 and 4 under their A options) | `docs/14b-assumptions` | docs only, one review round | Opus 5.5 medium |
| 2 | Item 1: architecture text for the snapshot API, for approval | `feat/15-snapshot` | design text | Fable 5.1 xhigh |
| 3 | Item 1: Codex contract tests, then implementation, migration of ⑬b and ⑭, guide | `feat/15-snapshot` (or ⑮a/⑮b) | engine step, strict TDD, review loop | Opus 5.5 high |
| 4 | Item 2: the `tscache/vite` entry | `feat/16-vite-entry` | tests with the code, review loop | Opus 5.5 medium |

The reference clients (roadmap) follow item 1, since their hydration shape depends on it.
