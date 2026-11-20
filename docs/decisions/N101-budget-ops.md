# N101: How the protocol carries the budget and the stats

Row N101 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Two additive ops, `memoryBudget { bytes }` and `memoryStats`; `PROTOCOL_VERSION` stays 1 (as N37), and the worker lists `'memoryBudget'` in `hello.features` (N79).** The client sends `memoryBudget` once after `init-ok` when the option is set, and `createClient` resolves only after its answer, which is the budget in force; a development build warns when it differs from the client's value. Against a worker without the feature the client sends nothing, warns once in development, `createClient` still resolves, and `memoryStats()` rejects with `TscacheError`. The locked handshake is untouched. Rejected: a field on `init` (changes the locked §3.1 handshake) and a protocol bump (every tab of an old deploy would reject `createClient`). User decision 67, row E18 option (a), 2026-11-16 (§3.2, step 121)
