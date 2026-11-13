# N18: First version seen by an unversioned cache

Row N18 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Adopt without clearing**: when `config.version` is unset, the first `meta.version` a put reports becomes the cache's version and existing data is kept; later mismatches clear. The starter's "inert when unset" holds, since nothing is cleared, while a backend that reports a version still protects the cache. Rejected: ignore it (a reported version could never protect an unversioned cache); treat it as a mismatch (wipes the cache on the first versioned response). User-confirmed 2026-10-06
