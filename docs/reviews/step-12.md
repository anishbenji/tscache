# Step 12 — Playwright multi-tab suite

Branch: `feat/12-multitab-e2e` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 3 + adversarial · Status: in review · Verdict after triage: —

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

## Contract-test changes

None (no contract tests in this step). The cross-tab dedup spec from step ⑪ moved from `e2e/client.spec.ts` to `e2e/dedup.spec.ts` and was rewritten onto the gate: the 1.5 s fixture delay and the wall-clock comparison are gone; a get held at the backend, the second tab's get still unsettled after a round trip, and one backend request prove the shared fetch.

## Decision concerns

None raised by the reviewer. Decisions taken with the user during this step:

- **N32 (2026-10-11).** A crash of the SharedWorker's host renderer kills the worker and leaves other tabs' clients hanging. The worker will hold a per-instance Web Lock; clients queue on it and treat its grant as worker loss: pending and later calls reject and a new client event fires. Separate pull request after this step.
- **N33 (2026-10-11).** `authInvalid` cannot say which credential was refused, so the refresh snippet has to guess (the source of R1-1, R2-1 and A1-1). The event payload will carry the refused fetch's `context`; the snippet then refreshes exactly when the shared token is the refused one. Library change in the same follow-up pull request as N32; until then the snippet ships with the limit stated in its header.
