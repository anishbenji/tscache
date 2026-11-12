# N5: Event surface

Row N5 of the decision table in `docs/architecture.md` §8 (N1–N8 user-confirmed 2026-06-11). The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Three scopes** — client (`authInvalid`, `modeFallback`), cache (`cacheCleared`), request (`mergeWarning` with `requestId = '<clientId>:<seq>'`, unique across tabs). Wire envelope carries a scope discriminator; `cache.on(...)` is cacheId-filtered sugar; initiating calls also get request-scoped results directly (`put()` returns its warnings). `modeFallback` addition accepted
