# N65: A fetch that never settles

Row N65 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The fetcher bounds its own requests** (§2.5, §4.9.1 rule 8). With subtraction, a hung fetch holds every `get` that needs one of its slots, from every tab, not only the gets of its identical range. The orchestrator adds no timer and cancels nothing. Rejected: a join deadline, or a maximum age for joinable fetches (a clock and a guess at what counts as hung, as under N32 and N44; the upgrade if hung fetches appear in practice); cancelling fetches (no abort exists, and a fetch serves other tabs). Director, 2026-10-30
