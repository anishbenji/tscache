# Step 133 — auth restore on a new tab, and RPC/client triage

Branch: `fix/133-auth-restore-and-client-triage` · Reviewer: the director's gate (not yet run) · Rounds: 0 · Status: built, awaiting review

## Scope

Read-only research at `6716b4d` raised three reports and some documentation drift. None had been seen failing. This step triages each one against the architecture and the code, pins what it found with tests, and documents what the code does where the specification is silent.

| Report                                                     | Verdict                                                         | Change                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| (d) A new tab may restore an invalid auth state            | Not reproduced as a defect: the behaviour is what §4.9 requires | Four regression tests; one sentence in §4.9; decision concern DC-1      |
| (e) `HostingError` is not exported                         | Confirmed as a public-API gap                                   | No code change (the exports are a Never path); decision concern DC-2    |
| (f) Listener errors surface differently by event           | Confirmed; the spec is explicit only on the part the code meets | §2.7 documents the behaviour as built; decision concern DC-3            |
| Doc drift: §4.7 and §4.9 code blocks, the M7 proposal refs | Confirmed                                                       | Code blocks brought in line; M7 references re-pointed at `main` (below) |

## (d) A tab joining while auth is invalid

**The report.** A newly opened tab with an object fetcher context may restore an invalid auth state to valid, so that fetches resume after `authInvalid` without anyone calling `updateAuth`.

**The code path.** Each tab's `init` reaches `RpcServer.#init` (`packages/tscache/src/rpc/server.ts:289-322`), which calls `Orchestrator.load` (`orchestrator/orchestrator.ts:311-342`). After the first load, a joining tab whose `config.context` is defined and not `Object.is` the context in place calls `this.updateAuth(config.context)` (`:336-341`). `updateAuth` runs the fetcher's hook, switches the context and the auth generation, and calls `AuthState.restore()` (`:379-401`, `orchestrator/auth.ts:62`). Through a SharedWorker every object context arrives as a structured clone, so it is never the identical value, and every tab that joins with one restores auth. A primitive context equal to the one in place is the identical value and changes nothing; so does a tab with no context.

**The specification.** Two sentences of §4.9 decide it, and they compose:

- Loading (N30): "A tab that joins with a context that is not the identical value takes the `updateAuth` path once the module is loaded (structured-cloneable values have no cheap, cycle-safe equality, so anything else is treated as new material)."
- Auth (design b/y, locked): "`updateAuth(context)` from any tab is applied in call order, one at a time: the fetcher's `updateAuth` hook runs, then the context and the auth generation switch together and the state flips to `'valid'`; the next `get` fetches again."

§2.5 says the same of `updateAuth` ("delivers new material and restores auth"). The joining-tab rule came from step 11 (R4-2, then R5-2 in `docs/reviews/step-11.md`): a joining tab's context had replaced the old one without advancing the generation, so an old fetch's late 401 invalidated the new credentials; the fix routed the join through `updateAuth`, and the next round narrowed "the same context" to the identical value. The restore is part of that path as the spec writes it. So the code does what the spec says. What the spec does not discuss is the case where the joining tab brings the same stale credential in a new object: that is DC-1.

**Is it a security problem?** No. The auth state decides only whether the worker asks the backend; the backend still checks every credential, and cached data is served whatever the auth state (`'auth-pending'` concerns only ranges that would need a fetch). The worst case is one fetch with a stale credential per tab opened with it, refused again, and one more `authInvalid` to every tab. The refusal flips the state back at once (`orchestrator/auth.ts:47`), so this cannot loop: each further fetch needs another tab to join.

**Hostings.** Only the SharedWorker hosting has joining tabs. A dedicated worker and the in-process hosting serve one client each (N27), so a new tab has its own worker or engine, starting valid.

**Tests** (`packages/tscache/test/orchestrator.test.ts`, "a tab joining while auth is invalid (step 133)", at the RPC-server level the existing auth tests use: one `RpcServer`, clients over `MessageChannel`, so contexts are structured-cloned as through a SharedWorker port):

1. A tab without a context leaves auth invalid: its get and the first tab's get answer `'auth-pending'`, nothing is fetched, the hook is not called, and no second `authInvalid` is sent (checked after a barrier on the first tab's port).
2. A tab with the identical context (a primitive) leaves auth invalid in the same way.
3. A tab with other material restores auth through the hook; the next fetches, from either tab, carry its context.
4. A tab with an equal but not identical stale context (`{ token: "old" }` again) restores auth; the next get makes one fetch, which is refused; a second `authInvalid` carries that context; and auth stays invalid afterwards.

All four passed on first run, before any change: nothing failed, so there is no fix. Tests 1 and 2 pin the safe behaviour; tests 3 and 4 pin the specified behaviour that DC-1 asks about, and change with it if the user decides otherwise.

**Documentation.** §4.9 Loading gains one sentence spelling out the consequence for a tab that joins while auth is invalid. No rule changed.

## (e) `HostingError` is not exported

**Facts.**

- `HostingError extends TscacheError` is defined in `packages/tscache/src/client/hosting.ts:14-16` and keeps its name through minification (`nameFor`, step 69; `test/errors.test.ts:65`). The `.` entry (`src/entries/index.ts`) exports `TscacheError`, `ConfigError`, `InvalidRangeError`, `UnknownCacheError`, `PutError`, `ProtocolMismatchError`, `AuthInvalidError` and `isAuthInvalidError`, not `HostingError`.
- It is thrown at `hosting.ts:70` and `:77` (worker `error` before the handshake, no `hello` in time), `:114`, `:122` and `:155` (no `SharedWorker`, its constructor throwing, the lifetime lock granted before `init-ok`), `:186` and `:192` (no `Worker`, its constructor throwing) and `:230` (the in-process chunk failing to load).
- `connect` (`client/client.ts:167-182`) steps down on a `HostingError` and rethrows it when there is no next hosting (`:177`). The chain runs from the pin to the end of `shared → dedicated → in-process` (`client.ts:31`, `:105`), so the last hosting is always in-process. `createClient` therefore rejects with a `HostingError` only when the in-process chunk cannot be loaded (`hosting.ts:226-233`, message `the in-process hosting could not be loaded: …`), whatever the pin.
- What the documentation promises: architecture §4.8 Chain, "when the last one fails, `createClient` rejects with that error"; `site/how-it-works/startup.md:33-34`, "`createClient` rejects with its `HostingError`"; the 0.2.0 changelog, "the `HostingError` that ends the fallback chain, keep[s] their documented `name` through minification". Architecture §2.6 and `site/usage/errors.md` do not list it.
- How a user tells it apart today: `error instanceof TscacheError` is true, and `error.name === "HostingError"`. There is no class to test with `instanceof` and no exported type.

The options are in DC-2. Nothing changed: the exports are a Never path.

## (f) Listener errors

**Facts.**

- The emitter (`engine/emitter.ts:26-43`) runs every listener of an emit and rethrows the first error after all ran.
- Wire events (`authInvalid`, `cacheCleared`, `persistStopped`, `cacheChanged`, `mergeWarning`) are emitted from `ClientEmitter.receive` (`client/events.ts:12-49`) inside the client's port listener (`client/client.ts:205-208`, `rpc/port-client.ts` `#receive`, registered with `addEventListener('message')` in `rpc/protocol.ts:126-140`). The rethrown error propagates out of the port's `message` listener, and the host reports it as an uncaught exception. Checked under Node 26: a throw in a `MessagePort` `message` listener reaches `process.on('uncaughtException')`, and the next message is still delivered.
- `modeFallback` (`client/client.ts:210-228`): every step is emitted in one `setTimeout` callback; the first error across all the steps goes to `report()` (`client.ts:38-43`), which calls `globalThis.reportError` when there is one and throws otherwise. Errors of later steps are not reported. Pinned by `test/client.test.ts` ("delivers every fallback step even when a listener throws").
- `workerLost` (`client/client.ts:324-335`): one emit inside `#lose`, its first error through `report()`. Pinned by `test/client.test.ts` ("a throwing workerLost listener is reported; the others still hear it").
- In a browser both routes reach the window's `error` event: an exception in an event listener is reported the same way `reportError` reports it.

**The specification.** §4.8 Events: "`evt` messages re-emit as `ClientEvents` … and the client-made `modeFallback` and `workerLost`. Listeners run on the page; a throwing listener does not break the port (the emitter's rule)." §4.6 gives the emitter's rule. Both are explicit, and the code meets them on every path. Neither says by which route an error that nobody can catch is surfaced, nor whether `modeFallback` reports one error per step. That part is silent, so this step documents the behaviour as built (§2.7, "A listener that throws") and changes no code. The M7 proposal (`docs/design/m7-change-events.md` §3.7, "Listener errors") already described the wire route for `cacheChanged`.

## Documentation drift

- **§4.7 code block.** `RpcServer` gains `persistStopped(payload)` and `connections`; `PortClient` gains `features`, `pendingCount`, `pendingOp(id)` and `abort(error)`, and `dispose()` its one-line contract. Checked against `rpc/server.ts:202-219` and `rpc/port-client.ts:110-291`.
- **§4.9 code block.** The `Caused` type, the constructor's optional `caused` parameter (it wraps the put that applies a fetch, `orchestrator.ts:697`, and the release of a get's pin, `:429`) and the `authWaiters` getter (`:506`).
- **`docs/design/m7-change-events.md`.** Its §2 says every claim was checked at `98b7bbf`. A script compared each of the 56 referenced spans at `98b7bbf` with `main` at `6716b4d`: 10 were unchanged, 21 had moved and 25 had changed. Each moved or changed reference now names the span on `main` that holds the same construct, except `persist/hosted.ts:113-128` (cited twice), which still holds the same `durably` and the head of `clearAll`, whose signature alone changed. Where a later step changed what a claim describes, the reference says "at `98b7bbf`" and names the current place: the live-feeds guide and the reference client's live feed (§1), which step 114 rewrote; the observers of the engine (the RPC server observes too since step 114); and the `hello` fields the client reads (`features` since step 114). §2 now says so in one sentence. No decided text changed. The file was then formatted with Prettier, which realigned the table columns.
- **`docs/INDEX.md`.** `docs/architecture.md` goes from 283.1 KB to 285.9 KB (285,907 bytes); `docs/design/` from 538.1 KB to 539.7 KB (539,650 bytes).

## Decision concerns

For the user. Nothing here was acted on.

### DC-1 — a tab that joins while auth is invalid, with the same stale credential in a new object

Through a SharedWorker, a tab that joins with an object context restores auth (§4.9 Loading and Auth, above). When that object carries the credential already refused (a tab that reads the same expired token from storage at startup), the next fetch is refused again and every tab hears `authInvalid` a second time.

| Option                                                                                                                           | Pros                                                                                                                                                                                | Cons                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Keep, as documented now                                                                                                      | A tab opened after a fresh sign-in brings working credentials at once; the joining tab never heard the earlier `authInvalid` and needs no special handling; no code or rule changes | One extra refused fetch, and one extra `authInvalid` to every tab, per tab opened with the stale credential; an app whose handler prompts the user may prompt again                                                                                                           |
| (b) A join delivers its material (hook, context, generation) but does not restore auth while it is invalid                       | No fetch with material nobody vouched for; `authInvalid` is sent once per refusal                                                                                                   | A tab with fresh credentials still gets `'auth-pending'` until some tab calls `updateAuth`, and it joined after the broadcast, so it must treat an `'auth-pending'` miss as the signal; changes a §4.9 rule (`updateAuth` and the join would differ); new tests and site text |
| (c) Treat a joining context as the same when it is structurally equal, for plain JSON-like values only (no `Map`, `Set`, cycles) | Removes the extra fetch in the common `{ token }` case; fresh material still restores                                                                                               | Reopens step 11's R5-2, which chose identity over structural comparison; a second rule to explain; still conservative for other values                                                                                                                                        |

**Recommendation: (a).** The cost is bounded (one refused fetch per tab opened, no loop), the backend checks every credential, and (a) is the only option under which a tab opened after a sign-in works without the application calling `updateAuth` itself.

### DC-2 — `HostingError` is not exported, yet `createClient` can reject with it

| Option                                                                                    | Pros                                                                                                                                                                                                                           | Cons                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (A) Export the class from `.` (and list it in §2.6 and `site/usage/errors.md`)            | `instanceof` works like every other error `createClient` can reject with; the type is importable; matches the changelog's "documented name"; no size cost (the client already bundles the class); additive, so a minor release | Commits to the class as public API; its meaning ("a hosting could not be established") must stay stable                                                                                                                              |
| (B) Keep it unexported; document `error.name === 'HostingError'` in §2.6 and the site     | No new export; the name is already kept through minification                                                                                                                                                                   | The one error a user cannot test with `instanceof`; a string comparison instead of a type                                                                                                                                            |
| (C) Fold it into an existing exported error: rethrow the last failure as a `TscacheError` | No new public name                                                                                                                                                                                                             | A behaviour change: `error.name` changes from `HostingError` to `TscacheError`, contradicting the changelog and `site/how-it-works/startup.md`; the user loses the only way to tell "no hosting started" from a fetcher-load failure |

**Recommendation: (A).** It closes the gap with one export line and two table rows, and it is additive.

### DC-3 — how a listener error that nobody can catch is surfaced

The emitter's rule (all listeners run, the first error is rethrown) holds everywhere. The route differs: wire events let the error escape the port's `message` listener; `modeFallback` and `workerLost` call `reportError`, or throw where it is missing; and `modeFallback` reports only the first error across all its steps.

| Option                                                                                      | Pros                                                                                                       | Cons                                                                                         |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| (a) Keep, as documented in §2.7                                                             | No change; in a browser both routes reach the window's `error` event; in Node both are uncaught exceptions | Two routes to describe                                                                       |
| (b) Route wire-event listener errors through `report()` too                                 | One route in the code and the docs                                                                         | A code change with no effect a user can observe in a browser; one more wrapper on a hot path |
| (c) As (a), but `modeFallback` reports every step's first error, not only the first overall | No listener error is dropped                                                                               | Up to two reports for one chain; a small behaviour change                                    |

**Recommendation: (a).** The routes are equivalent where the library runs, and the behaviour is now written down.

## Contract-test changes

None. No existing test changed.

## Verification

| Command                                                                           | Result                                                                             |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `bunx vitest run test/orchestrator.test.ts -t "step 133"` (in `packages/tscache`) | 4 passed, 38 skipped, before any source change (nothing failed, so nothing to fix) |
| `bun scripts/test-clocks.ts`                                                      | `test-clocks: 195 files clean`                                                     |
| `~/code/tscache-reports/bin/heavy-run.sh "133 child: ci" bun run ci`              | Filled in after the run                                                            |

## Not verified

- (d) in a real browser with two pages of one `BrowserContext`: the tests run the same `RpcServer` and `Orchestrator` the SharedWorker runs, over `MessageChannel` ports that structured-clone the context as a SharedWorker port does, so no Playwright test was added.
- (f) in Chromium: the claim that both routes reach the window's `error` event rests on the HTML standard's "report the exception" for event listeners and `reportError`; only the Node behaviour was run.
