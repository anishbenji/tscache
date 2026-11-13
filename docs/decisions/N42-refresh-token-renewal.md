# N42: Refresh snippet with an access token renewed in place (DC-1, step ⑫)

Row N42 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**State the precondition**: a refresh must issue a new access token; otherwise each tab that heard the refusal may refresh once, always with the current refresh token, so no session is revoked and the cost is one redundant refresh per extra tab. Stated in the snippet header (`e2e/pages/auth-refresh.js`), its copy in `examples/react-lwcharts/src/auth-refresh.ts` and `docs/guides/patterns.md`. Rejected: a rotation stamp in the fetcher context (every app's `toContext`/`accessOf` pair grows and the context carries a value the fetcher does not need; the upgrade if a backend needs it); an auth generation number in `authInvalid` (considered at N33; a library change for a snippet concern). User-confirmed 2026-10-23
