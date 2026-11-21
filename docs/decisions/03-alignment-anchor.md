# 3: Alignment anchor

Row 3 of the decision table in `docs/architecture.md` §7 (the open decisions of starter §9, user-confirmed 2026-06-11). The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

per-cache `alignmentOffset`, default 0

## Amendment, 2026-11-21

User decision 83, row G4 option (a) (N109, step 129): `alignmentOffset` applies to fixed intervals only. With a calendar interval it must be absent or 0, since the interval's `zone` and `at` place the slots, and the resolved config holds 0.
