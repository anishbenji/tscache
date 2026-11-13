# N45: Opting in to persistence (P1)

Row N45 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Per cache: `CacheConfig.persist`, default false, structural under N20**, so every tab agrees and one tab cannot turn persistence off under another, and per-user or sensitive caches stay in memory. Inert, without an event, where there is no IndexedDB or no persister (Node, `./engine`, and since 2026-10-31 the dedicated-worker and in-process hostings, N52, whose `clearAll` still empties the disk, N66), so a server render and a tab in any hosting can share one config; `client.mode` tells a consumer whether it persists (§4.10.1). Rejected: `ClientOptions.persist` (all or nothing per client); always on (sensitive data on disk by default). Director, 2026-10-30
