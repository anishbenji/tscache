# Step 127 — M5 deploy skew, the spec reconciled for the contract tests

Branch: `docs/127-m5-spec-reconcile` · Reviewer: none yet (the director starts the review rounds) · Rounds: 0 · Status: built, not reviewed

## Scope

User decision 71 (2026-11-16) approved the deploy-skew design, `docs/design/m5-deploy-skew.md` (finding M5, step 100): F1–F4, F6–F10 and F12–F16 option (a), F5 (a) with its amendments to locked N52 and architecture §4.10.7, and F11 (b), the relay, with its amendments to locked N54, N66 and §4.10.7's last paragraph. It asked for one reconciliation: the spec avoided the handshake, but M7's D9 (a), approved the same day, added `hello.features` (N79), so M5 builds on that field.

Since the spec was written, M7 (step 114, pull request #146) and M3 (step 121, #150) changed `rpc/`, `client/`, `persist/`, the engine and the architecture. The next M5 step is Codex writing the contract tests from the approved text. This step makes the spec correct against `main` at `6716b4d5`, so that the round is spent on tests.

Documentation only. Nothing under `packages/` changes, no decision file changes, and the sixteen decision rows of the spec's §5 are byte-identical to `main` (checked below).

| File                            | What                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/design/m5-deploy-skew.md` | The status line; every claim and reference checked against `main`; `hello.features` and `hello.lib`; the M3 fold-in; §6's tests; a new §8       |
| `docs/reviews/step-127.md`      | This file                                                                                                                                       |
| `docs/INDEX.md`                 | The `docs/design/` row: its text for `m5-deploy-skew.md`, and its size, 538.1 KB to 592.7 KB (`cat docs/design/* \| wc -c` gives 592,708 bytes) |

The spec grew from 92.7 KB to 147.3 KB, of which about 10 KB is the padding Biome's formatter adds to keep table columns aligned (136.9 KB before the pre-commit hook formatted it). The rest is the fold-in the brief asks for: §4.7 (what reads `hello.lib`), §4.10 (M7 and M3), ten more tests and §8.

## What was read

Architecture §2.1, §2.7, §2.9, §3.1–§3.2, §4.8 and §4.10.6–§4.10.9; decisions N29, N37, N78–N80, N84, N87, N88, N101 and N103; the design files of M7 (row D9, §3.8) and M3 (rows E3, E18, E20); and, under `packages/tscache/src/`, `rpc/protocol.ts`, `rpc/server.ts`, `rpc/port-client.ts`, `rpc/lifetime.ts`, `client/hosting.ts`, `client/client.ts`, `client/events.ts`, `client/dev.ts`, `client/in-process.ts`, `entries/worker.ts`, `persist/hosted.ts`, `persist/clear-only.ts`, `persist/persister.ts`, and the cited parts of `persist/idb-store.ts`, `engine/engine.ts`, `engine/cache.ts`, `engine/restore.ts`, `orchestrator/orchestrator.ts` and `types.ts`.

## Changes, each with its source

Section numbers are the spec's unless they say "architecture".

### Status and framing

| Change                                                                                                                                                          | Source                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Status line: decided by user decision 71, the options taken, contract tests next; the reconciliation of step 127 and where its record is                        | The brief; `docs/INDEX.md` (the `docs/design/` row already said "decided by user decision 71")         |
| "Why a proposal file": the claim that §3.1 "is left as it is by every recommended option" is replaced by what changes (one name in `hello.features`)            | N79 (`hello.features`, the amended §3.1); decision 71                                                  |
| §1's last sentence: the design "adds no message to the handshake" now also says it adds one feature name                                                        | As above                                                                                               |
| §2's base commit: checked at `2fc4308` when written, and again at `6716b4d5`                                                                                    | `git log`                                                                                              |
| §4's heading and §5's introduction say "decided"; §5's rows are untouched, and a note gives the one line reference inside them that moved (`types.ts:315-321`)  | Brief: an approved row is not changed. `types.ts:351-363` holds the `persistStopped` contract F6 cites |
| §4.6: "the recommended protocol" is "the decided protocol"; §4.8: "the recommendation keeps N25" is "F13 (a) keeps N25"; §6 test 10 keeps F11 (b)'s expectation | Decision 71                                                                                            |
| Mentions of "0.1.0" workers and tabs now say "an earlier release (0.1.0, 0.2.0)"                                                                                | `rpc/protocol.ts:27` (`LIB_VERSION` is `"0.2.0"`); 0.2.0 creates its SharedWorker without a name too   |

### File and line references

Every `path:line` reference outside the decision rows was read against the file at `6716b4d5`. The ones that moved:

| Was                                                                    | Is                                                          | What it names                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| `client/client.ts:97-103`                                              | `:116-123`                                                  | `fetcherOf`: the fetcher module as a string                |
| `client/client.ts:134-149`, `:143-144`                                 | `:167-182`, `:177`                                          | The fallback chain; only a `HostingError` steps down       |
| `client/client.ts:172-186`                                             | `:210-228`                                                  | `modeFallback` on the macrotask after `createClient`       |
| `client/events.ts:12-43`                                               | `:11-49`                                                    | `ClientEmitter.receive`                                    |
| `e2e/support.ts:27`                                                    | `:28`                                                       | The fixed worker URL of the end-to-end suite               |
| `test/version.test.ts:7-10`                                            | `packages/tscache/test/version.test.ts:7-10`                | The path was not under `src/`, as §2 says paths are        |
| `rpc/server.ts:146-153`                                                | `:191-199`                                                  | The hello, which now carries `features`                    |
| `rpc/server.ts:242-259`, `:247-258`                                    | `:289-306`, `:294-305`                                      | The server's protocol check                                |
| `rpc/server.ts:260-270`, `:261`                                        | `:307-317`, `:308`                                          | The fetcher load at `init`                                 |
| `rpc/server.ts:311-315`                                                | `:358-362`                                                  | `unknown op`                                               |
| `rpc/server.ts:408-412`                                                | `:554-558` (and `:504-530` for `cacheChanged`)              | `#broadcast`; `#changed`                                   |
| `rpc/port-client.ts:162-178`, `:162-166`                               | `:180-197`, `:181-184`                                      | `onHello`; its protocol check                              |
| `orchestrator/orchestrator.ts:298-303`                                 | `:311-316`                                                  | `Orchestrator.load`'s refusal of a second module           |
| `entries/worker.ts:93-110`                                             | `:93-111`                                                   | The SharedWorker path                                      |
| `engine/engine.ts:53-69`, `:117-123`                                   | `:62-100`, `:229-239`                                       | N20's structural fields and check; `cache()`               |
| `engine/restore.ts:115-121`, `:147-167`, `:171-182`, `:191-199`        | `:114-121`, `:145-168`, `:171-188`, `:191-198`              | The record checks of a load                                |
| `persist/idb-store.ts:206-217`                                         | `:205-221`                                                  | `open`                                                     |
| `persist/persister.ts:227-229`, `:562-568`, `:578-597`, `:679`         | `:228-230`, `:577-584`, `:593-613`, `:694` (and `:689-700`) | `#failure` at open; `#openFailed`; `#stop`; `#clearFailed` |
| `persist/persister.ts:945-952`, `:946-948`, `:950`                     | `:960-968`, `:961-963`, `:965`                              | `#plan`                                                    |
| `persist/persister.ts:243`, `:483-502`, `:1059-1063`, `:900-915`       | `:244`, `:498-527`, `:1060-1079`, `:915-941`                | The eager load; the timer; `#attemptFlush`                 |
| `persist/clear-only.ts:70-105`                                         | `:88-108`                                                   | The clear waits for the chunk                              |
| `docs/architecture.md:1705-1710`, `:1707`, `:1723`                     | `:1855-1860`, `:1857`, `:1873`                              | §4.10.7                                                    |
| `site/guides/workers.md:132-178`, `:146-147`, `:169-178`, `:176-180`   | `:135-206`, `:150-173`, `:184-206`, `:179-182`              | Stale scripts after a deploy                               |
| `site/guides/persistence.md:84-86`, `docs/guides/patterns.md:167-171`  | `:91-93`, `:167-177`                                        | The documented limits                                      |
| `docs/design/m7-change-events.md:156`, `docs/design/m3-memory.md` §3.2 | N79; architecture §2.9 and N87                              | The proposals are built; their decisions are cited         |

Unchanged and still right: `client/hosting.ts:28-38`, `:117-120`, `:120`; `rpc/protocol.ts:21`, `:27`; `rpc/lifetime.ts:36-54`; `persist/persister.ts:166`; `persist/idb-store.ts:15-16`, `:113-114`; `engine/restore.ts:117-121`; `examples/react-lwcharts/src/client.ts:9-10`; `site/troubleshooting.md:17-25`; `docs/guides/patterns.md:149-156`; `docs/guides/worker-setup.md:204-205`; `site/guides/vite.md:92`.

Facts that changed with the references: `LIB_VERSION` is `"0.2.0"` (§2.1); the guides and architecture §4.10.7 no longer say a hashed worker URL gives each deploy a worker of its own, since step 101 corrected them (§2.3, §7's last paragraph, which said the correction was still to be made); the troubleshooting page and the workers guide now advise a retry with `mode: 'dedicated'` for a page that is the newer side (§1, §4.8).

### New rows in §2.1 (facts M7 and M3 added)

| Fact                                                                                                                             | Source                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| The hello carries `features`, one constant for every hosting; the client keeps the names it knows and exposes `client.features`  | `rpc/protocol.ts:48-52`, `:66-75`; `rpc/server.ts:191-199`; `rpc/port-client.ts:58-63`; N79      |
| `cacheChanged` goes only to subscribed connections; every other event to every ready one                                         | `rpc/server.ts:504-530`, `:554-558`; N74                                                         |
| An event that arrives before the client is constructed reaches nobody; with a budget that window spans the budget op             | `rpc/port-client.ts:313-314`; `client/client.ts:205-208`, `:386-396`                             |
| The budget arrives by op after `init-ok`; the first one an engine without a cache receives holds; the two ops skip persistence   | `client/client.ts:363-372`; `engine/engine.ts:213-218`; `rpc/server.ts:419-425`; N88, N101, N103 |
| `Engine.clearAll()` keeps the caches and sends `cacheCleared` and `cacheChanged { cleared: true }` for each, empty ones included | `engine/engine.ts:327-344`; `engine/cache.ts:757-775`; N78                                       |
| The server hands its memory clear to the persistence                                                                             | `rpc/server.ts:451-458`; `persist/hosted.ts:124-145`; `persist/clear-only.ts:71-112`             |
| An eviction marks a page only for a cache whose persistence is live                                                              | `persist/persister.ts:207`, `:398-403`, `:411-415`; N95                                          |
| A hosting in a realm without IndexedDB has no persistence                                                                        | `entries/worker.ts:49`; `client/in-process.ts:31-39`                                             |

### `hello.features` and `hello.lib` (§4.1, §4.7, §4.12)

- **§3.1 "unchanged" is replaced by what changes.** No message and no field of the handshake changes. The `features` list N79 added gains `'superseded'`, and `WorkerFeature` gains the member (public, `types.ts:317`). Step 121 added `'memoryBudget'` the same way under N101, which records that the locked handshake is untouched by it, and decision 71 asked for this use of the field.
- **`PROTOCOL_VERSION` stays 1, and §4.12 says why.** The proposal's additive argument holds by N79's rule: what a peer from the other side of a skew can ignore or detect keeps the version. An older client ignores an unknown event name (`client/events.ts:11-49`) and an unknown feature name (`rpc/port-client.ts:58-63`); a newer client facing an older worker sees no `'superseded'` in `client.features`. No op, message or field is added.
- **What reads `hello.lib` (the director's addition to the brief).** Nothing reads it on `main`: the server writes it (`rpc/server.ts:194`), the type declares it (`rpc/protocol.ts:69`), and `onHello` drops it (`rpc/port-client.ts:180-197`; `PortClient` has no member for it, `:110-134`). The spec said "the client compares `hello.lib`" and §7 said "`rpc/port-client.ts` (keep `hello.lib`)" as if a reader were there to keep; both now say the reader is new. §4.7 names exactly three uses once M5 is built: `PortClient.connect` stores it as `PortClient.lib` and never acts on it; the client compares it with its own `LIB_VERSION` when it is built and warns once in development when they differ (F12 (a)); and the development note for `superseded` names it. It is not public, and it is used for neither the generation key (the page's own `LIB_VERSION`), nor the rank (each worker's `lib` on the channel), nor any capability.
- **How it sits beside `hello.features`.** The development warning of F12 is keyed on `lib`; capabilities are keyed on `features` only (whether `subscribe` is sent, whether the budget op is sent, whether `superseded` can arrive). §4.7 has the table, and test 17 pins that `client.features` does not depend on `lib`.

### The M3 fold-in (§4.4, §4.5, §4.10)

- **E3 (N88), two generations.** Each worker has an engine, so each takes the first budget its own tabs send; the superseded worker keeps its budget and goes on evicting under it; the origin may hold the sum of the two; a deploy that changes only the budget joins the running worker and waits, as N88 says; two workers of one generation (F16) have a budget each. Source: architecture §2.9, N87, N88, `engine/engine.ts:213-218`.
- **E18 (N101), the two ops.** Neither changes with `superseded`, neither crosses the channel, neither waits for the persistence (`rpc/server.ts:419-425`); `memoryStats()` reports one worker; a clear from the channel empties the count and keeps the budget (`engine/engine.ts:327-344`, architecture §2.9 Interactions). The order at connect to a superseded worker is fixed: the event precedes the budget answer, which is why the port client must keep it (§4.5).
- **E20 (N103), a budget reaching a superseded worker.** The engine applies N88 and N103 as any engine does: it takes the budget when it has none and holds no cache, and otherwise answers the one in force. `createClient` neither fails nor waits for being superseded.
- **Eviction and the stop (§4.4).** An eviction after `supersede()` writes nothing (`persist/persister.ts:398-403`, `:411-415`), and a pending relaxed deletion is dropped with the dirty state.
- **Eviction and the relay's proof (§4.10).** Premise 2 of §4.6.2 holds with a budget: an eviction's flush request is held by the barrier like a write's (`persist/persister.ts:453-459`).

### The M7 fold-in (§3.2, §4.4–§4.6, §4.10)

- Superseding is not a mutating call, so it sends no `cacheChanged`; `superseded` and `persistStopped` go to every ready connection, subscribed or not (N73, N74; `rpc/server.ts:206-214`, `:554-558`).
- A clear that arrives by the channel sends `cacheCleared` and then `cacheChanged { cleared: true }` for each cache, with no `requestId` (N73, N75, N78), once for each message the worker acts on; the server needs an entry for it, since today's `clearAll` path runs under a request's id (`rpc/server.ts:451-458`).
- `cacheChanged` does not cross from one worker to the other; §3.2 lists it among the costs of two workers side by side.
- The relay's cost paragraph gains the read rule's cost, which is DC1.

### §6, the contract tests

Tests 1–24 keep their numbers. Who writes what is now a table: tests 1–10 and 25–28 are Codex's, first (`persist/`); 11–17 and 29–32 (`rpc/`, `client/`, `entries/`) and 18–24 and 33–34 (browser) are written with the code. The seams as they stand on `main` are named for Codex (`persist/persister.ts:190-209`, `persist/hosted.ts:79-90`, `persist/clear-only.ts:42-53`, `rpc/server.ts:116`).

| Test  | Change                                                                                                                                                              | Why                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 4     | "A failed one stops the caches it tracks … with that failure's reason" is replaced: it reports no cache again                                                       | After `supersede()` no tracked cache is running, and a cache is reported once (N59; `persist/persister.ts:594`) |
| 7     | Adds an open waiting for the chunk at `supersede()`, and a chunk that failed before it                                                                              | `persist/hosted.ts:104-110`, `:189-213`: both states exist on `main` and the text covered only "not loaded"     |
| 8     | The first post is in the step that clears memory; a clear held behind the chunk posts when it runs; `clearMemory` still runs once; F11 (a)'s alternative is dropped | `persist/hosted.ts:125-128`; the `clearMemory` argument of step 114 (`rpc/server.ts:451-458`); decision 71      |
| 10    | Keeps the F11 (b) expectation only                                                                                                                                  | Decision 71                                                                                                     |
| 13    | Cites where the options are passed                                                                                                                                  | `client/hosting.ts:109-126`                                                                                     |
| 15    | The payload's `lib` is the newer worker's; the event needs no subscription and precedes the stop's `persistStopped` events                                          | N74; §4.5                                                                                                       |
| 16    | Subscribed tabs also get `cacheChanged`; a hosting without IndexedDB opens no channel                                                                               | N78; `client/in-process.ts:31-39`                                                                               |
| 17    | Pins the three uses of `hello.lib` and that `features` does not depend on it                                                                                        | §4.7                                                                                                            |
| 18    | Both clients' `features` hold `'superseded'`                                                                                                                        | §4.7                                                                                                            |
| 22    | A `cacheChanged` listener in one tab hears the other's put, unchanged                                                                                               | N74                                                                                                             |
| 25–28 | New, Codex first: superseding changes no cache (M7); eviction after superseding (M3); superseding beside another failure; the relay under a budget (M3)             | §4.4, §4.10                                                                                                     |
| 29–32 | New, with the code: the feature name; the event before the client exists; budget and stats on a superseded worker; a channel clear's events                         | §4.5, §4.7, §4.10                                                                                               |
| 33–34 | New, browser: two generations, two budgets; a view across a relayed clear                                                                                           | §4.10, DC1                                                                                                      |

Tests 1–3, 5, 6, 9, 11, 12, 14, 19–21, 23 and 24 were checked against M7's events and M3's eviction and stand as written. The "Bench" line now says "the performance suite's … memory gates", so that it is not read as M3's `memoryBudget`.

### §7

The code list names today's files: `client/dev.ts` (the development messages live there since step 114), `rpc/protocol.ts` (the feature name), `types.ts` with its lines, `PortClient.lib` as new, the second fetcher and worker URLs of the end-to-end server. The documentation list gains architecture §2.9, §3.1, §4.7 and §4.10.9, `site/concepts/events.md`, `site/guides/patterns.md` (Memory), the decision files (N106 onward) and the dated notes, and the roadmap's sketch, which still calls the rows open.

## Choices made without a decision row

Each is the simplest reading of the approved text, and each is stated in the spec where it applies. The first four are also raised as decision concerns, because the approved rows do not settle them; the rest are details.

- The four recommended options of the decision concerns below are taken in §4 and §6 (child rule 8).
- The server sends `superseded` before the `persistStopped` events of the same stop, so a `persistStopped` listener finds `client.superseded` set (§4.4, §4.5).
- `supersede()` after an earlier persister failure reports no cache again and makes `'superseded'` the reason later opens stop with (§4.4, test 27): "once set, `'superseded'` is kept" read as taking precedence from then on.
- A `clearAll` held behind the persistence chunk posts when it runs, the literal reading of "once after it has started its own clear" (§4.6.1, test 8).
- A hosting without a persistence (a realm without IndexedDB) posts nothing, since the approved text has the persistence make the posts; a SharedWorker there still clears its memory on a message (§4.6.2, test 16).
- A missing or malformed `hello.lib` counts as differing, and the comparison runs in every hosting (§4.7, test 17).
- The development note for `superseded` names `hello.lib` as this side's library (§4.5).

## Contract-test changes

None. No test exists for M5 yet; §6 is the text Codex writes them from.

## Decision concerns

Four, in the spec's §8 with their options, pros and cons. No approved row is changed for any of them.

| #   | Question                                                                                                                                                                                                                                                          | Recommendation                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| DC1 | F11 (b) makes each worker clear about k + 1 times for one `clearAll`. As M7 is built, each clear sends `cacheChanged { cleared: true }` (N78) and the read rule answers it with a fetching read (N84), whose stated bound is one such read per view for each call | (a) Accept it as decided, with a dated note on N84 and a sentence in the guide                        |
| DC2 | Which workers list `'superseded'` in `hello.features`, and does a listener without it warn in development?                                                                                                                                                        | (a) Only a worker that takes part in detection lists it; no warning                                   |
| DC3 | F1 (a) changes two facts the locked N87, N88 and N103 state (which tabs share an engine; that a new deploy's budget waits for a restart). The rules stand                                                                                                         | (a) Dated notes on the three files when the design is built, and the scope sentence of §2.9 corrected |
| DC4 | A tab that joins a superseded worker is sent the event right after `init-ok`; with a `memoryBudget` that is before its client exists (M3), so the event would be lost                                                                                             | (a) The port client keeps it; the property is set at resolve; the event follows on the next macrotask |

Only DC1's option (c) would change a Codex-first test (8 and 10); the others touch tests written with the code (29, 30, 34).

## Verification

- `bun run docs:check` (after `bun run build`, which the site's type check needs in a fresh worktree): passes; `doc-anchors: 246 anchors in 42 pages resolve`.
- Every `path:line` reference in the spec outside the decision rows resolves to an existing file and line range, and each was read against its claim: a scratch script listed 108 distinct references with the first and last line of each, with no file missing and none out of range; references that follow a file's first one after other text (`:318-321` of `rpc/server.ts`, `:41-45` of `client/events.ts`, `:317` and `:358-363` of `types.ts`, `:91-103` of `site/guides/persistence.md`, `:50` of `site/guides/patterns.md`) were read by hand.
- The decision rows are unchanged: `git show main:docs/design/m5-deploy-skew.md | grep '^| F[0-9]' | shasum` and the same over the working file give one digest.
- `git diff --stat main -- packages/` is empty.
- `bun run ci` runs on the final head through the heavy-job lock; its result is in the child's report, since recording it here would move the head.

Not verified: the behaviour the spec describes for code that does not exist yet. The claims about what `main` does today were read from the code, not run. No Codex round was run (child rule 7).
