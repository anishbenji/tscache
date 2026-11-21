# N118: What changes for a protocol mismatch or a fetcher conflict at connect

Row N118 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 135 from the M5 design proposal (`docs/design/m5-deploy-skew.md`), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Nothing: both still reject (N25, N30); only the guide's advice changes.** With the generation name (N106) a running worker of an older deploy no longer causes either. What remains is a script served stale, for which a dedicated worker would load the same stale script, so a fallback does not help: the guide says to reload with the HTTP cache revalidated and to serve the worker script with revalidation. The fetcher-conflict guard stays for connections that arrive without the name. Rejected: stepping down to the dedicated worker on either refusal (it would amend N25 and N30). User decision 71, row F13 option (a), 2026-11-16 (§4.8, step 135)
