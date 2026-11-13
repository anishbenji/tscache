# N31: Dedup granularity

Row N31 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Subtract in-flight ranges** (built at step 44, §4.9.1): before fetching, a `get` subtracts the fetches in flight for its cache, from any tab, awaits them for the overlap and fetches only the rest; an identical range is the case where nothing is left. A fast scroll then asks the backend for each bar once instead of each read's whole miss (up to three times the bars, perf plan item 7). The locked guarantee (starter §3.5: dedup in the worker, one fetch serves all tabs) holds and now covers overlaps. First resolved as **exact coalesced range** (overlapping but different ranges fetched separately), deferred to the roadmap, not rejected; user-confirmed 2026-10-08. Rejected now: keeping exact-range dedup. Built under the user's standing grant (perf plan recommendation). Director, 2026-10-30
