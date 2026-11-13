# N21: Who emits `mergeWarning`

Row N21 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The RPC server, from `put`'s result**: it knows the request id. The engine emits only cache-scoped `cacheCleared`; in-process callers get warnings from `put()` directly. Rejected: the engine with a made-up `engine:<seq>` id (carries request identity it does not need). User-confirmed 2026-10-07
