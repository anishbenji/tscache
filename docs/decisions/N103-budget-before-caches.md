# N103: A budget for an engine that already holds a cache

Row N103 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Only an engine that holds no cache takes a budget.** A SharedWorker's engine is created before any tab connects, so its budget arrives by op, which `createClient` sends after `init-ok` and before the application can open a cache. A budget that reaches an engine already holding a cache, even an empty one, is ignored like a second value (N88): a development build warns, and `memoryStats()` shows none in force. No budget ever switches on under state, so there is no use order to seed, no total to recompute and no pending get that started without its pin. A tab of an older deploy without the option that opened a cache first keeps the worker unbudgeted until it restarts (finding M5). Rejected: applying it by seeding the order (a pin per orchestrated get in every application) or without pins for pending gets (such a get could answer `uncached` for what it fetched). User decision 67, row E20 option (b), 2026-11-16 (§2.9, step 121)
