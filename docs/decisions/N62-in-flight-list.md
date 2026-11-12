# N62: The in-flight list, and what a `get` awaits

Row N62 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Per cache, the fetches in flight in start order; a round awaits the joinable ones that meet the slots it needs, with no cap** (§4.9.1 rules 1, 2, 12). An entry is joinable while its cache and auth generations are current and no `invalidate` has fenced it. It leaves the list in the step that decides its outcome, so no `get` joins a fetch that has already failed. A round scans the list linearly beside the step 36 sweeps, since ends are not ordered by start. Rejected: an interval tree (the objections of §6.1, for a list as long as the fetches outstanding); keeping the exact-range map beside the list (two structures to keep consistent); a cap on awaited fetches (its fallback is the duplicate fetch); awaiting fetches that meet only covered slots of the request (latency for nothing). Director, 2026-10-30
