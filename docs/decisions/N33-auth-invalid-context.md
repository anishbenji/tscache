# N33: What `authInvalid` says

Row N33 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The refused fetch's `context`.** Port order says which event came first, not which credential was refused, so the refresh snippet had to guess (step ⑫ R1-1, R2-1, A1-1). With the context in the payload, the snippet refreshes exactly when the shared access token is the refused one and adopts the current tokens otherwise. It needs no seed token and never rotates more than once. The context reaches every tab of the origin, which supplied it. The change is additive, so `PROTOCOL_VERSION` stays 1. Not taken: an auth generation number (the snippet would have to map generations to tokens). User-confirmed 2026-10-11
