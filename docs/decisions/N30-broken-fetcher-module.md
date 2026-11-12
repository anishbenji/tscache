# N30: When a broken fetcher module surfaces

Row N30 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**At `createClient`**: `init` imports the module and a failure answers `init-err`, so the client rejects at startup with a `TscacheError` naming the module. Rejected: lazily on the first miss (a broken fetcher would look like a flaky backend). User-confirmed 2026-10-08
