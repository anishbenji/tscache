# N50: Flush triggers (P6)

Row N50 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**About 1 s of quiet, at most 5 s after the first unflushed change, plus a flush when the last connection goes; the SharedWorker is created with `extendedLifetime: true`**, which gives that last flush about 30 s to land. A worker sees no `pagehide`; the client's `dispose` on `pagehide` (§4.8) drops its connection. The 5 s cap was added by the design so a steady live feed is still written; removals are not debounced (N58). Rejected: a debounce only; a flush on every change. Director, 2026-10-30
