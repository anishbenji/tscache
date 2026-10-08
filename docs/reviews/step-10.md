# Step 10 — SharedWorker, fallback chain and client facade

Branch: `feat/10-client` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 4 · Status: settled · Verdict after triage: merge

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

## Round 2 — reviewer verdict: merge after fixes

R1-1, R1-2, A1-2 confirmed fixed; N28 acknowledged.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P1 | `pagehide` with `persisted: true` (back/forward cache) disposed the client, so a restored page found its handles dead | accepted | Fixed in ab5ab5a: only a non-persisted `pagehide` disposes; test covers both. §4.8 updated |
| R2-2 | P1 | The webpack recipe (bare `new URL(...)`) emits the worker entry as one asset without its imported chunks, so the worker fails to start (R1-3 partly fixed) | accepted | Fixed in ab5ab5a: the guide explains why webpack cannot bundle a worker it does not see constructed and serves the whole `dist/` directory via `copy-webpack-plugin` instead |

## Round 3 — reviewer verdict: merge after fixes

R2-1 and R2-2 confirmed fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | `PortClient.connect` with an already-aborted signal called `finish` before it was declared (temporal dead zone): `ReferenceError` instead of the reason, port left open | accepted | Reproduced. Fixed in 8c5d128: cleanup declared before the aborted check; test asserts the reason and the port closure |
| R3-2 | P2 | The §2.1 `workerUrl` comment still advertised the bare webpack `new URL()` recipe (R2-2 partly unfixed) | accepted | Fixed in 8c5d128: points at the served-copy recipe |

## Round 4 — reviewer verdict: merge

No findings; R3-1 and R3-2 confirmed fixed.

## Contract-test changes

None (no contract tests for this step).

## Decision concerns

**Tab death without `pagehide` (from A1-3).** When a tab's renderer dies abruptly, no `pagehide` fires and browsers deliver no port-close event to the SharedWorker, so the dead connection stays in `RpcServer` until the worker itself is torn down (which happens once every tab is gone). Escalated to the user 2026-10-08 and decided the same day (N28): accept the bounded leak; a heartbeat stays on the roadmap.

## Merge request

**Scope.** Step ⑩ of the commit plan: `createClient` with the fallback chain (`client/client.ts`, `client/hosting.ts`), the `CacheHandle` facade (`client/cache.ts`), typed client events (`client/events.ts`), the SharedWorker connect path in `entries/worker.ts`, the public `.` entry, and the first Playwright suite (`e2e/`). Architecture §4.8 (new), N25–N28, §2.1 `handshakeTimeoutMs` and the `workerUrl` guidance; `docs/guides/worker-setup.md` (starter §8 debt: bundler/worker-entry guide). `PortClient` gained a cancellable handshake (`AbortSignal`) and `abort()`.

**Decisions taken on this branch** (user-confirmed 2026-10-08). N25: a hosting fails over on constructor throw, worker `error` before the handshake, or no `hello` within `handshakeTimeoutMs` (default 5 s); a protocol mismatch rejects. N26: Playwright in Chromium from this step (chore #17 added the install step and the e2e server). N27: one `Engine` per in-process client. N28: a tab that dies without `pagehide` leaves a bounded leak in the SharedWorker; a heartbeat stays on the roadmap. Settled by the implementer and recorded in §4.8: `modeFallback` events are delivered on the next macrotask (the chain runs before anyone can subscribe); a non-persisted `pagehide` disposes the client, a back/forward-cache hide does not.

**Review outcome.** Four rounds plus the scheduled adversarial pass. Round 1 + adversarial: four P1s (abandoned handshake after a timeout; dedicated-worker fatal error leaving requests hanging; throwing listener suppressing later fallback events; closed tabs staying registered — pagehide now, N28 for crashes) and the missing bundler guide. Round 2: back/forward-cache hide disposed the client; the webpack recipe would emit the worker without its chunks. Round 3: pre-aborted handshake signal hit a temporal dead zone. Round 4: no findings.

**Confidence: high, including the browser path.** 13 Node tests drive the chain with fake worker globals speaking the real protocol (every fallback signal, pinning, timeout, protocol mismatch, pagehide/bfcache, fatal worker error, late hello). Four Playwright specs run the built package in Chromium: a real dedicated `Worker`; a `SharedWorker` shared by two pages of one context (a put in one is read in the other); the in-process pin; and the no-`SharedWorker` fallback with its `modeFallback` event. Each review finding was reproduced by a test before its fix and confirmed by the reviewer.

**Blast radius: additive, first consumer-facing surface.** New `client/` modules and the `.` entry's exports; `PortClient.connect` gained an optional third parameter; no engine or RPC semantics changed. 1012 Node tests and 4 browser specs pass under `bun run ci`.

**Known limits, by design.** `get` is cache-only and `updateAuth` a no-op until orchestration (step ⑪). The SharedWorker path is verified in Chromium only (Firefox/Safari at step ⑫'s discretion). `lib` in `hello` is a placeholder version until the build injects it. Fallow reports `CacheHandle`'s methods as unused class members (warning, #15): they are the public API, reachable only through the entry.
