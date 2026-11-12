# N8: Auth-failure signal

Row N8 of the decision table in `docs/architecture.md` §8 (N1–N8 user-confirmed 2026-06-11). The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

Fetcher **throws `AuthInvalidError`** (idiomatic, composes with fetch wrappers). Rejected: result code on `FetchResponse` (bifurcates return shape). Single mechanism only
