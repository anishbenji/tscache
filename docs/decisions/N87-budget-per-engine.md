# N87: What a memory budget bounds

Row N87 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**One budget per engine, shared by every cache of that engine.** In a SharedWorker that is every tab of the origin that reaches the same worker URL; in a dedicated worker one tab; in-process one `createClient`; on a server one `Engine`. One least-recently-used order runs across the caches, so a page any tab uses stays. Rejected: a budget per cache (`CacheConfig.maxBytes`: fifty caches times a per-cache budget is still unbounded, and it would be a structural field under N20) and both together (two interacting limits). Per-cache limits can be added later, additively, if asked for. User decision 67, row E2 option (a), 2026-11-16 (§2.9, step 121)
