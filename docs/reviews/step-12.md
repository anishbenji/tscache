# Step 12 — Playwright multi-tab suite

Branch: `feat/12-multitab-e2e` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 2 · Status: in review · Verdict after triage: —

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

## Contract-test changes

None (no contract tests in this step). The cross-tab dedup spec from step ⑪ moved from `e2e/client.spec.ts` to `e2e/dedup.spec.ts` and was rewritten onto the gate: the 1.5 s fixture delay and the wall-clock comparison are gone; a get held at the backend, the second tab's get still unsettled after a round trip, and one backend request prove the shared fetch.

## Decision concerns

None.
