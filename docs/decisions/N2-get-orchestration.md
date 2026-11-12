# N2: `get` orchestration

Row N2 of the decision table in `docs/architecture.md` §8 (N1–N8 user-confirmed 2026-06-11). The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

With a fetcher configured, `get` **awaits the deduplicated fetches** for its misses (machine-speed waits only; auth-pending/failures degrade to misses immediately). `{ cacheOnly: true }` skips orchestration. Rejected: fire-and-forget + immediate partials — forces consumers into re-poll loops
