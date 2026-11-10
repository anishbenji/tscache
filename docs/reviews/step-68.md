# Step 68 — The handshake timeout bounds only the wait for hello

Branch: `fix/68-handshake-hello-timeout` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: settled · Verdict after triage: merge

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

## Decision concerns: the lock watch and a bound on the fetcher load

After the fix, no timer bounds what follows `hello`. Before it, the handshake timeout bounded that window, by accident and with the wrong outcome for a slow load (a step down instead of a wait).

**Confirmed by the user, 2026-11-10, decision 24 option A** (pre-review round 2, P1). It adds a step-down trigger beyond the wording of N25 (and the "after the handshake" of N32), so it needed the user's approval. The case: a SharedWorker that dies between `hello` and `init-ok`, for example because the renderer of the tab hosting it crashed while it loaded another tab's fetcher. No `error` or port `close` reaches the other tab (N32), so `createClient` would have hung. The client now queues on the worker's lifetime lock as soon as `hello` names it; a grant before `init-ok` fails the hosting with a `HostingError` and the chain steps down, as the old timeout did. The same request then watches the connected client, so there is still one lock request per client. The reading recorded as implementation notes on N25 and N32: a lifetime-lock grant before `init-ok` counts as a worker `error` before the handshake, which Chromium cannot report for a SharedWorker; it restores the bound the old timer gave by accident; the decision texts are unchanged. The alternatives the user did not choose were to drop the hello-time watch and accept the hang, or to bring back a bound on the whole handshake.

The second question: a fetcher `import()` that never settles while the worker stays alive (a module server that accepts the connection and never answers, a top-level `await` that never resolves). It leaves `createClient` pending forever.

Options:

- **A. No separate bound (status quo after this step).** Pros: no new option and no new decision; the browser's own network timeouts end most stuck module requests; a top-level `await` that never resolves is a bug in the fetcher module, which the application owns. Cons: a fetcher module that hangs hangs `createClient`, with no error to report, which is the failure N25 rejected for a silent worker.
- **B. A separate init timeout, client side.** After `hello`, a second timer (for example `initTimeoutMs`, default 30 s) rejects `createClient` with a `TscacheError` naming the fetcher module, without stepping down (consistent with N30: a broken fetcher surfaces at startup). Pros: every startup ends with a result; the error names the cause. Cons: a new public option and a decision record; a slow but healthy load on a poor connection fails where it would have succeeded; the worker keeps loading the module, so a later tab may connect at once while this one has already failed.
- **C. A load timeout in the worker.** The server bounds `import(module)` and answers `init-err` when it runs out. Pros: one place decides for every tab; the module is reported once. Cons: `import()` cannot be cancelled, so a late load still completes in the worker and later connections reuse it; the bound lives in the worker, where an application cannot see it per tab; it changes the server's handshake contract (§4.8 N30).

Recommendation: **A** for v0.1.0, with the hang named as a known limit in the workers guide once chosen, and revisit with **B** if a consumer reports a hang. A fetcher module is the application's own code, served by the application's own server, and the common failures (a 404, a syntax error, a missing `fetch` export) already reject at once through `init-err`. **Outcome: the user chose A on 2026-11-10 (decision 25).** No bound is implemented; the hang is a documented limit for 0.1.0, in §2.5 and §4.9 of `docs/architecture.md`, `site/guides/fetcher.md`, `site/guides/workers.md` and `site/troubleshooting.md`. B stays the candidate if a consumer reports a hang.

## Pre-review (director, round 1)

| ID  | Severity | Finding                                                                                                       | Resolution                                                                                                                                                             |
| --- | -------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P1       | A SharedWorker that dies between `hello` and `init-ok` hangs `createClient`: the lock watch began at init-ok. | Fixed: the watch starts at `hello`; a grant before `init-ok` is a `HostingError`, the request is handed to the connected client or withdrawn when the handshake fails. |
| 2   | P1       | No tests for the behaviour documented after `hello`.                                                          | Added: an `init-err` after the timeout rejects with a `TscacheError` and constructs no dedicated `Worker`; a worker `error` after `hello` is a `HostingError`.         |
| 3   | P2       | The §2.1 TSDoc of `handshakeTimeoutMs` still described the old behaviour.                                     | Fixed: it now matches `types.ts`.                                                                                                                                      |

The tests for finding 1 failed before the fix: the hello-time watch tests saw no lock request (`expected [] to deeply equal [ [ 'tscache-worker:w1', 'shared' ] ]`). The tests for finding 2 passed before and after: they cover behaviour the first commit already had.

## Pre-review (director, round 2)

No code bugs.

| ID  | Severity | Finding                                                                                                                                                                                       | Resolution                                                                                                        |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | P1       | The hello-time lock watch adds a step-down trigger beyond the wording of N25 and the "after the handshake" of N32, without recorded user approval.                                            | Code kept. Implementation notes on the N25 and N32 rows. Confirmed by the user, 2026-11-10, decision 24 option A. |
| 2   | P2       | Docs drift: §4.8 "Worker loss (N32)" said the client queues after the handshake; §4.7 `PortClient.connect` lacked `signal` and `afterHello`; the guides' trigger lists lacked the new reason. | Fixed in §4.8, §4.7, `site/guides/workers.md` and `site/troubleshooting.md`.                                      |

## Round 1 — reviewer verdict: merge

No findings (2026-11-10, head b0d08f2, rebased onto main 5635b56). The reviewer confirmed that the accepted pre-review findings are fixed and re-raised nothing. It ran the type check and 61 handshake, client and RPC tests; the full gate (`bun run ci`) had passed on the same head before the round (Vitest 2157, Playwright 163).

| #   | Sev | Finding | Decision | Resolution |
| --- | --- | ------- | -------- | ---------- |
| —   | —   | None    | —        | —          |

## Contract-test changes

None.

## Not verified

- A real browser with a slow fetcher module. The Playwright suite has no gated fetcher import; the Node tests hold back `init-ok` instead, which exercises the same client path.
