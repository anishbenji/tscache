# N28: Tab death without `pagehide`

Row N28 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Accept the bounded leak.** A tab that crashes fires no `pagehide` and browsers deliver no port-close event to a SharedWorker, so its connection stays in the server until the worker is torn down with the last tab; cost: one map entry and one failed `postMessage` per broadcast. Rejected for now: a client heartbeat with server-side eviction (timers per tab and server, two wire messages, generous windows because hidden tabs throttle timers to once a minute) — roadmap if real-world tab churn shows a problem. User-confirmed 2026-10-08
