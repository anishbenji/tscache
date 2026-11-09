# Step 68 — The handshake timeout bounds only the wait for hello

Branch: `fix/68-handshake-hello-timeout` · Reviewer: not yet reviewed · Status: implemented, awaiting review

## The defect

`handshake` in `packages/tscache/src/client/hosting.ts` kept its timer running until `PortClient.connect` resolved, that is until `init-ok`. N25 (`docs/architecture.md` §8) says the timeout bounds the wait for `hello`. The server answers `init` only after it has loaded the fetcher module (N30), so a fetcher `import()` slower than `handshakeTimeoutMs` (5 s by default) raised `HostingError` and stepped the chain down. The next hosting then loaded the same module again, and the tabs of one origin silently stopped sharing a SharedWorker. The user decided on 2026-11-09 to fix the code to match N25; the decision itself is unchanged.

## The fix

`PortClient.connect` takes an optional `afterHello` callback, called once a `hello` with the client's protocol arrives and before `init` is sent. `handshake` passes `() => clearTimeout(timer)`. Nothing else changes: the worker `error` listener still aborts the handshake at any point before `init-ok`, a protocol mismatch still rejects, and no message or public API changes.

## Tests

`packages/tscache/test/hosting-handshake.test.ts`, on fake timers (`setTimeout` and `clearTimeout` only; the ports are real `MessageChannel`s):

1. A SharedWorker that says hello at once and whose `init-ok` the test holds back past ten times the timeout connects in `'shared'` mode with no `modeFallback` event. This test failed before the fix (`expected 'in-process' to be 'shared'`).
2. A SharedWorker that never says hello rejects `openShared` with `HostingError("SharedWorker did not answer within 50 ms")`, and `createClient` steps down to `'in-process'`.
3. A dedicated worker that fires `error` before hello rejects `openDedicated` with `HostingError("Worker failed to start: script 404")`, terminates the worker and leaves no timer behind.

Tests 2 and 3 passed before the fix; they guard the behaviour the fix must keep.

## Decision for the user: a bound on the fetcher load

After the fix, nothing bounds what follows `hello`. A fetcher `import()` that never settles (a module server that accepts the connection and never answers, a top-level `await` that never resolves) leaves `createClient` pending forever. Before the fix, the handshake timeout bounded it, by accident and with the wrong outcome (a step down instead of a rejection).

Options:

- **A. No separate bound (status quo after this step).** Pros: no new option and no new decision; the browser's own network timeouts end most stuck module requests; a top-level `await` that never resolves is a bug in the fetcher module, which the application owns. Cons: a fetcher module that hangs hangs `createClient`, with no error to report, which is the failure N25 rejected for a silent worker.
- **B. A separate init timeout, client side.** After `hello`, a second timer (for example `initTimeoutMs`, default 30 s) rejects `createClient` with a `TscacheError` naming the fetcher module, without stepping down (consistent with N30: a broken fetcher surfaces at startup). Pros: every startup ends with a result; the error names the cause. Cons: a new public option and a decision record; a slow but healthy load on a poor connection fails where it would have succeeded; the worker keeps loading the module, so a later tab may connect at once while this one has already failed.
- **C. A load timeout in the worker.** The server bounds `import(module)` and answers `init-err` when it runs out. Pros: one place decides for every tab; the module is reported once. Cons: `import()` cannot be cancelled, so a late load still completes in the worker and later connections reuse it; the bound lives in the worker, where an application cannot see it per tab; it changes the server's handshake contract (§4.8 N30).

Recommendation: **A** for v0.1.0, with the hang named as a known limit in the workers guide once chosen, and revisit with **B** if a consumer reports a hang. A fetcher module is the application's own code, served by the application's own server, and the common failures (a 404, a syntax error, a missing `fetch` export) already reject at once through `init-err`. Not decided in this step; no bound is implemented.

## Not verified

- A real browser with a slow fetcher module. The Playwright suite has no gated fetcher import; the Node tests hold back `init-ok` instead, which exercises the same client path.
