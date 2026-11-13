# N4: `cache()` config conflict

Row N4 of the decision table in `docs/architecture.md` §8 (N1–N8 user-confirmed 2026-06-11). The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Get-or-create; structural mismatch rejects** with `ConfigError`; identical config returns existing cache. All tabs are expected to request identical config. Rejected: last-writer-wins reconfigure (silently destructive cross-tab)
