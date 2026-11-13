# N25: When a hosting fails over

Row N25 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Constructor throw, worker `error` before the handshake, or no `hello` within `handshakeTimeoutMs` (default 5 s, configurable)** step the chain down with a `modeFallback` event; a `ProtocolMismatchError` rejects instead. Rejected: no timeout (a loaded worker that never speaks, e.g. a stale service-worker-cached script, would hang `createClient`). User-confirmed 2026-10-08. Implementation note (step 68, 2026-11-09): the code ran the timer until `init-ok`, which also bounded the fetcher load; it now stops at `hello`, as this decision says. The decision is unchanged. Second implementation note (step 68, 2026-11-09; confirmed by the user 2026-11-10, decision 24): a shared-mode client queues on `hello.lock` from `hello`, and a grant before `init-ok` fails the hosting. It counts as a worker `error` before the handshake, which Chromium cannot report for a SharedWorker (N32), and restores the bound on that window that the old timer gave by accident. The decision text itself is unchanged
