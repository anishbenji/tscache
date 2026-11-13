# N64: `invalidate` and fetches in flight

Row N64 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**`invalidate` fences joins over its range**: fetches in flight that meet it can no longer be joined, so a `get` issued after an invalidate fetches the range anew (§4.9.1 rule 9). Their responses are still applied, as before. Rejected: no fence (with subtraction, a `get` after a restatement would rely on any overlapping fetch issued before it, where exact-range dedup exposed only the identical range); fencing the responses as well (a second fence beside N29 for a window that predates N31; decision concern DC-2 of step 44). Director, 2026-10-30
