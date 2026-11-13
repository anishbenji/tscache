# N23: Where `clientId` comes from

Row N23 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The worker assigns it in `hello`** (one server numbers its connections), so request ids `clientId:seq` are unique across tabs by construction with no client-side randomness. Rejected: a client-generated random id (uniqueness by luck, server must trust it). User-confirmed 2026-10-07
