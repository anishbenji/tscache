# N87: What a memory budget bounds

Row N87 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**One budget per engine, shared by every cache of that engine.** In a SharedWorker that is every tab of the origin that reaches the same worker URL; in a dedicated worker one tab; in-process one `createClient`; on a server one `Engine`. One least-recently-used order runs across the caches, so a page any tab uses stays. Rejected: a budget per cache (`CacheConfig.maxBytes`: fifty caches times a per-cache budget is still unbounded, and it would be a structural field under N20) and both together (two interacting limits). Per-cache limits can be added later, additively, if asked for. User decision 67, row E2 option (a), 2026-11-16 (§2.9, step 121)

## Amendment, 2026-11-21

Decision concern DC3 of the M5 proposal (`docs/design/m5-deploy-skew.md` §8; step 135), built with its option (a) while the concern is with the user. The rule above is unchanged; one fact its text states is not. Since N125 a SharedWorker is found by its URL and its generation key (the tscache version and the fetcher module string, N126), so a SharedWorker's engine is shared by the tabs that pass the same worker URL and the same key, where the resolution says "every tab of the origin that reaches the same worker URL". While workers of two generations, or of two keys within one deploy (N140), run side by side, each has an engine and a budget of its own: the budgets are not shared and do not add up to one bound, so the origin may hold the sum of the two, and a worker without a budget stays unbounded beside a budgeted one.
