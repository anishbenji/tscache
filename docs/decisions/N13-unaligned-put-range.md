# N13: Unaligned `put` range

Row N13 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Snaps inward**: `options.range` covers the grid points inside it and no others (`snapIn` in `grid.ts`); a range holding no grid point claims nothing. `get`/`invalidate` snap outward because reading or forgetting too much is safe; claiming too much is not, since a claimed slot without a point is a confirmed gap that is never refetched. Rejected: snap outward (consistent with `get`, but vouches for slots the caller never named); reject an unaligned range (unambiguous, but every caller passing a chart range must align it first). User-confirmed 2026-10-05
