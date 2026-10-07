# Step 10 — SharedWorker, fallback chain and client facade

Branch: `feat/10-client` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 1 · Status: in review · Verdict after triage: blocked

Not an engine step: tests were written with the code (Node over MessageChannel with fake worker globals, plus the first Playwright suite in Chromium, N26).

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | A SharedWorker answering after the handshake timeout completed an abandoned connection whose port stayed open | accepted | Reproduced. Fixed in 401a7ca: `PortClient.connect` takes an `AbortSignal`; timeout and worker `error` abort it, which removes the listeners and closes this side's port. Test: late hello, no init sent, port closed |
| R1-2 | P1 | A throwing `modeFallback` listener stopped later steps from being delivered | accepted | Reproduced. Fixed in 401a7ca: every step is delivered, the first listener error goes to `reportError` (nobody awaits the macrotask). Test |
| R1-3 | P2 | The `workerUrl` example (`new URL('tscache/worker', import.meta.url)`) resolves wrongly without a bundler and no setup guide existed (starter §8 debt) | accepted | `docs/guides/worker-setup.md` added (Vite `?worker&url`, webpack `new URL`, no-bundler copy of dist/); TSDoc and §2.1 now point at it |

## Adversarial round 1 — focus: fallback order and pinning; tab death; the no-SharedWorker (Chrome Android) path — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| A1-1 | P1 | Abandoned handshake not cancelled (same as R1-1) | accepted | fixed in 401a7ca |
| A1-2 | P1 | A dedicated worker's fatal error after the handshake left pending requests hanging: the only error listener had been removed and a `Worker` has no port closure | accepted | Reproduced. Fixed in 401a7ca: the hosting keeps an `error` listener for its lifetime and aborts the `PortClient` (new `abort()`); test with a swallowed request and an injected fatal error |
| A1-3 | P1 | A tab that closes without disposing stays registered in the SharedWorker: Chromium fires no port `close` event (gated behind a test-only feature), so connections and broadcast work accumulate under tab churn | accepted in part | 401a7ca: the client disposes itself on the page's `pagehide` event, which covers closing and navigating away and is the standard signal. Abrupt renderer death (crash, OOM kill) needs a liveness mechanism: a decision, escalated below |
| A1-4 | P1 | Throwing listener suppresses later fallback notifications (same as R1-2) | accepted | fixed in 401a7ca |

## Contract-test changes

None (no contract tests for this step).

## Decision concerns

**Tab death without `pagehide` (from A1-3).** When a tab's renderer dies abruptly, no `pagehide` fires and browsers deliver no port-close event to the SharedWorker, so the dead connection stays in `RpcServer` until the worker itself is torn down (which happens once every tab is gone). Escalated to the user 2026-10-08 with the options: a client heartbeat the server uses to drop silent connections; or accept the leak for abrupt death only (bounded by the worker's lifetime).
