# N136: What the client does with `hello.lib`

Row N136 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 135 from the M5 design proposal (`docs/design/m5-deploy-skew.md`), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**It warns once in a development build when the worker's library version is not its own.** The port client keeps `hello.lib` when it is a string. When the client is built it compares that with its own `LIB_VERSION`; when they differ, in either direction, or the worker sent none, a development build prints one `console.warn` naming both, and a production build prints nothing. No value of `lib` fails a connection, steps the chain down or changes what is sent, and no capability is derived from it (N79). With the generation name (N125) the two differ only when the script at the worker URL is not the page's: a fixed URL whose script was replaced under an old page, or a script served stale. Rejected: nothing, as before (the field stays unread); rejecting (refuses compatible pairs, harsher than N37 allows); a public `client.workerVersion` (public API for a diagnostic). User decision 71, row F12 option (a), 2026-11-16 (§4.7, §4.8, step 135)
