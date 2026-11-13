# N27: In-process engine scope

Row N27 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**One `Engine` per `createClient`** behind its own `MessageChannel` pair; matches the SSR use and needs no module-level state. Rejected: a page-wide singleton shared by every in-process client (worker-like semantics, but a global with a disposal story). User-confirmed 2026-10-08
