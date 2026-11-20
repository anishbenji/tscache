# N110: How weekends and holidays are modelled (G5)

Row N110 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 129 from the calendar grid design proposal (`docs/design/calendar-grid.md`, row G5), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Every calendar day is a slot.** A day without a session is an empty slot that a fetch confirms as a gap, exactly as a weekend is on a fixed daily grid today: the fetcher's response covers it and holds no bar for it. The numbering is stable, and no exchange data lives in the library. A weekend is two empty slots and a long weekend three or four, within the default `gapSplitK` of 4; a longer closure splits the segment (N14). Rejected: a weekday mask in the descriptor (holidays are still empty slots, and one more structural field); a holiday list (every new holiday renumbers the later slots, so records under the old list misplace points). The cost: weekend slots cost capacity, about 2/7 of a daily cache's slots. User decision 83, row G5 option (a), 2026-11-21 (§2.2, step 129)
