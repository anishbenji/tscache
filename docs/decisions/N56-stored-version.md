# N56: A stored version at load

Row N56 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Applied only when it equals the cache's version, or when the cache has none, which then adopts it (as N18).** An unversioned record is not loaded into a versioned cache; a mismatch clears nothing, emits nothing, and the stored records are replaced at the next flush. Stricter than `hydrate` (N35), because a record written without a version may hold any version's data. Rejected: `hydrate`'s rule (loads unversioned records into a versioned cache); deleting mismatched records at load (destroys a still-running deploy's records for nothing). Design, 2026-10-30
