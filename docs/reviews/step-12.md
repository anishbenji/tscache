# Step 12 — Playwright multi-tab suite

Branch: `feat/12-multitab-e2e` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 4 + adversarial · Status: settled · Verdict after triage: merge

Not an engine step: tests only, no contract tests and no change under `packages/tscache/src/`. Specs approved by the user on 2026-10-11: cross-tab dedup moved onto a request gate, a context-isolation control, version-mismatch clear propagation with the cross-tab N29 fence, `authInvalid` across tabs with a Web Locks refresh snippet, and a tab dying mid-fetch. The fixtures talk to an in-memory mock backend in the e2e server (user's choice over a worker-local fake), so a test holds a fetch in flight by gating it instead of sleeping, and counts requests on the server.

## Findings from the probes (before round 1)

Throwaway Playwright probes in Chromium, run before the specs were written:

- Chromium runs the SharedWorker in the renderer process of the tab that created it. A tab other than that one crashing mid-fetch (CDP `Page.crash`, no `pagehide`) leaves the worker running: it finishes the dead tab's fetch, applies it, and its broadcasts still reach the other tabs. This is the N28 case, and it behaves as decided.
- The host tab closing normally mid-fetch also leaves the worker to the other tabs, with the fetch applied.
- **The host tab's renderer crashing kills the worker.** The other tabs' clients get no signal (no `error` on the `SharedWorker`, no `close` on the port) and every pending and later request hangs. N28 assumed the worker outlives any crashed tab, so this case was undecided. A lock held by a SharedWorker was released 11 ms after its host renderer crashed, so Web Locks can detect it. Escalated as **N32**; the user decided on 2026-10-11 that the worker holds a per-instance Web Lock for its lifetime, clients queue on it after the handshake, and a granted lock means the worker is gone: the client rejects pending and later calls and emits a new client event so the app can create a new client. It lands as a separate pull request after this step; the specs here never crash the first tab.

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | The refresh snippet rotates again when a busy tab handles the queued `authInvalid` events of two recoveries another tab already completed: the first event adopts the current pair and updates `seen`, the second then matches it and refreshes | accepted (as P2) | Reproduced with a stand-in client that fires two queued events after the shared tokens moved on (`refreshes: 1`). Fixed in 8cfe1f0: each event keeps the token known when it fired, so stale events only adopt the current pair. Regression test `events queued behind earlier recoveries rotate nothing`. Severity lowered: the rotation always presented the current refresh token under the lock, so no spent token was ever reused; the cost was one needless rotation |

## Round 2 — reviewer verdict: merge after fixes

No new findings; CI passed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P2 | R1-1 still reproducible when the second stale event arrives after the first recovery's lock callback adopted the current pair: it captures the adopted token and rotates (re-raises R1-1) | accepted | Validated by reasoning and by the new regression, which the 8cfe1f0 snippet fails (`refreshes: 2`). Second round on this area, so redesigned rather than patched (ddbf7ab): the worker sends events and `updateAuth` answers on one port in order (`PortClient.#receive` settles both synchronously), so an event a tab receives before the answer to its own update concerns a token from before it. The snippet runs one recovery per tab and ignores events until that recovery's `updateAuth` is answered; the dispatch-time capture is gone. Regression: stale events back to back and after the recovery reached `updateAuth`, then one real refusal after the answer (`refreshes: 1`); it fails in under a second instead of hanging when recoveries pile up |

## Round 3 — reviewer verdict: merge

No findings. R1-1 and R2-1 confirmed fixed and covered by the regression; CI passed.

## Adversarial round — focus: tests passing for the wrong reason, flakiness, timing assumptions, the backend's gate and namespaces, the snippet's safety — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| A1-1 | P1 | The suppression introduced for R2-1 drops a real refusal: a version-fence retry right after the worker switched credentials can be refused, and its event is posted before the `updateAuth` answer, so the snippet ignores it and auth stays invalid with no further event | accepted | Reproduced by the reviewer against the real `RpcServer` and orchestrator. Port order says which event came first, not which credential was refused. Third review in a row on the snippet, so escalated: the user chose an exact fix in the library (N33 below) and, for this step, a snippet that is live rather than minimal. Fixed in 11b369a: the suppression is gone and the refused token is again taken when the event fires, so no refusal is lost; scenario `a refusal during a recovery's update is acted on` |
| A1-2 | P1 | If saving the rotated tokens fails, the lock is released with the spent refresh token still stored and the next tab presents it again | accepted | Fixed in 11b369a by failing closed (user's choice): the refresh token is cleared from storage before it is spent; a failure to load, refresh or store, or a cleared token found by another tab, ends the session through the new `onSessionLost` callback. Scenarios `a failed save ends the session instead of reusing the token` and `without storage the refresh token is never spent` |
| A1-3 | P2 | An asynchronous initial `load()` that resolves after another tab refreshed seeds the tab with the new token and rotates again | accepted | Fixed in 11b369a: the token a tab starts from is passed in (`access`, the token in the context its client was created with). Scenario `a tab installed after a refresh adopts the current tokens` |

R2-1 is now a documented limit rather than a fix: a stale event that arrives after a tab adopted newer tokens rotates once more, presenting the current refresh token (wasteful, never a reuse). The snippet's header says so; N33 removes it. Every scenario was checked against a mutant of the defect it covers (suppression, seeding from storage, no tombstone, tombstone ignored): each mutant fails its scenario. The fixture fetcher's error message no longer contains the token, since the message is broadcast to every tab.

## Round 4 — reviewer verdict: merge

No findings. A1-1 to A1-3 confirmed fixed and covered; the remaining extra rotation is the documented limit pending N33, and the host-renderer crash is deferred under N32. CI passed.

## Contract-test changes

None (no contract tests in this step). The cross-tab dedup spec from step ⑪ moved from `e2e/client.spec.ts` to `e2e/dedup.spec.ts` and was rewritten onto the gate: the 1.5 s fixture delay and the wall-clock comparison are gone; a get held at the backend, the second tab's get still unsettled after a round trip, and one backend request prove the shared fetch.

## Decision concerns

None raised by the reviewer. Decisions taken with the user during this step:

- **N32 (2026-10-11).** A crash of the SharedWorker's host renderer kills the worker and leaves other tabs' clients hanging. The worker will hold a per-instance Web Lock; clients queue on it and treat its grant as worker loss: pending and later calls reject and a new client event fires. Separate pull request after this step.
- **N33 (2026-10-11).** `authInvalid` cannot say which credential was refused, so the refresh snippet has to guess (the source of R1-1, R2-1 and A1-1). The event payload will carry the refused fetch's `context`; the snippet then refreshes exactly when the shared token is the refused one. Library change in the same follow-up pull request as N32; until then the snippet ships with the limit stated in its header.

## Merge request

**Scope.** Step ⑫ of the commit plan: the Playwright multi-tab suite (architecture §5), tests only. A mock backend in the e2e server (`scripts/e2e-backend.ts`: namespaced per test, bearer tokens, refresh-token rotation, request counters, and gates that hold a request until the test releases it) replaces sleeps and wall-clock comparisons. Specs: cross-tab dedup on the gate plus a separate-contexts control (`dedup.spec.ts`); version-mismatch clear propagation and the cross-tab N29 fence (`version.spec.ts`); `authInvalid` across three tabs with a Web Locks refresh, recovery by any tab's `updateAuth`, and the refresh snippet's own scenarios (`auth.spec.ts`); a tab crashing mid-fetch and the host tab closing mid-fetch (`tab-death.spec.ts`). The copy-pasteable refresh snippet (`e2e/pages/auth-refresh.js`) is what step ⑬ copies into the examples. No change under `packages/tscache/src/`.

**Decisions taken on this branch** (user-confirmed 2026-10-11). Spec list and the mock-backend fixture. N32: a crash of the SharedWorker's host renderer kills the worker and leaves other tabs hanging; detection with a per-instance Web Lock, reject and a new client event, in a separate pull request. N33: `authInvalid` will carry the refused fetch's `context` so the snippet can refresh exactly; same follow-up pull request. The snippet fails closed when storage fails (tombstone and `onSessionLost`).

**Review outcome.** Four rounds plus the scheduled adversarial pass. Every finding was in the refresh snippet: R1-1 and R2-1 (redundant rotation from stale events), then A1-1 (the R2-1 redesign could drop a real refusal), A1-2 (a failed save let another tab reuse the spent token) and A1-3 (asynchronous seeding). After the third review on that area the root cause, an event that cannot name the refused credential, went to the user as N33. Round 4 was clean. No finding concerned the specs themselves (pages versus contexts, flakiness, timing), which the adversarial pass targeted.

**Confidence: high.** Each proof is built so that a broken mechanism fails it: the dedup spec requires the second tab to be still waiting while the gate holds and one backend request in total, and the separate-contexts control shows two; event counts are taken after a round trip on the same port, so they are exact; the snippet scenarios were each run against a mutant of the defect they cover and fail it. The suite passed 360 of 360 runs at 30 repetitions on 10 workers before the review fixes, and the auth spec 70 of 70 at 10 repetitions after them. The only time-based code is the 5-second worker-alive check in the tab-death spec, which can only fail a test, never pass one.

**Blast radius: test infrastructure only.** The e2e server gains `/backend/` routes and no longer times out idle requests (held requests would be cut off after Bun's default 10 s). The fixture fetcher talks HTTP to the backend. `e2e/client.spec.ts` keeps its hosting tests on the shared helpers. 1047 Node tests and 17 browser specs pass under `bun run ci`.

**Known limits.** A crash of the tab whose renderer hosts the SharedWorker is not tested here (N32, follow-up). Until N33, the snippet can rotate once more than needed when a stale event arrives after a tab adopted newer tokens; the rotation presents the current refresh token. `e2e/` and `scripts/` are not type-checked by `bun run ci` (checked locally with a temporary configuration); adding them is a tooling change for a `chore/` branch. `e2e/pages/fetcher.js` carries one Fallow suppression for its import of `/dist/fetcher.js`, a URL the e2e server serves rather than a repository path.

## Follow-up: worker loss and refused context (`feat/12b-worker-loss`)

The two decisions taken during this step, N32 and N33, in one pull request after it (user's plan, 2026-10-11). It changes `packages/tscache/src/` and the public event surface, so the architecture text came first and was approved by the user on 2026-10-11 (f6b3fa9): §2.7 (`workerLost { reason }`, `authInvalid { error, context }`), §3.1 (optional `hello.lock`), §4.7 and §4.8 (module shapes, the worker-loss rule), §4.9 (the refused context), §8 (N32 and N33 rows). Both wire changes are additive and optional, so `PROTOCOL_VERSION` stays 1. Not an engine step: tests are written with the code.

- **N32 (cd994c4).** In a SharedWorker scope with Web Locks the worker holds an exclusive lock `tscache-worker:<uuid>` for its lifetime and says hello only once it is held, naming it in `hello.lock`. A shared-mode client queues on it in shared mode after the handshake; the grant means the worker is gone. A lost client rejects pending and later calls with `TscacheError`, releases what it owns and emits `workerLost` once. The same happens on a dedicated worker's fatal error (which used to reject pending calls silently and leave the worker running) and on a port closed or `bye` from the server after the handshake. `dispose()` withdraws the lock request and never emits the event. New module `rpc/lifetime.ts`; §4's layout gains it and the missing `client/hosting.ts` line.
- **N33 (e604077).** `authInvalid` carries the context the refused fetch was issued with. The refresh snippet compares it with the stored access token through a new `accessOf` option: it refreshes when they match and adopts the stored tokens otherwise. The `access` seed, the dispatch-time capture and the known-limit header are gone; the tombstone and `onSessionLost` stay. Harness scenarios name the refused token; the seed scenario became `lateStaleEvent` (the former R2-1 limit: a late event about a replaced token rotates nothing) and `twoTabsOneRefusal` was added.

Probe before review: a client's queued shared-mode lock request does not cost the page the back/forward cache. In full Chromium (`channel: 'chromium'`; the headless shell disables the cache for its embedder) a page with a pending request, and one with a tscache shared client, were both restored with `persisted: true` and no blocking reasons; after restore the request was still queued and was granted when the holder went. So no `pagehide`/`pageshow` handling was added.

Checked against mutants: with the client's lock watch disabled, `worker-loss.spec.ts` hangs until its timeout; with the snippet refreshing on every event, four auth specs fail (`queuedStaleEvents`, `lateStaleEvent`, `twoTabsOneRefusal` and the three-tab refresh). Review rounds of this follow-up are numbered from round 5 in `.reviews/step-12/`.
