# N48: `navigator.storage.persist()` (P4)

Row N48 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The app calls it**, documented in §4.10.1; the library never does, since some browsers prompt the user. Rejected: the library requesting it; never. Director, 2026-10-30
