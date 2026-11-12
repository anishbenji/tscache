# N37: Protocol version for the snapshot ops

Row N37 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Stays 1**: the new op and the `get` option are additive. A worker from before them (a stale cached script) answers `unknown op`, so `hydrate` rejects with `TscacheError`; the helper that applies a page's snapshot treats that as not seeded, and the app fetches instead. Rejected: bumping to 2 (every tab of an old deploy would reject `createClient` outright, since a mismatch never falls back under N25, which is harsher than the failure it prevents). User-confirmed 2026-10-23
