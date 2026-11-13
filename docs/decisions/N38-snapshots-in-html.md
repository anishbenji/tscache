# N38: Snapshots in HTML

Row N38 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**`encodeSnapshot` and `decodeSnapshot` ship from the `.` entry** (and, since step ⑮ T6, from `./engine` too): base64 for buffers and the mask, JSON for the rest, with `btoa`/`atob` and no DOM, so `NaN` survives. Escaping for a `<script>` element stays with the app, since it depends on how the page is built. The page carries two forms: the server's read as columns for the hydration render, and the snapshot for the cache. A public reader that derives the columns from the snapshot can be added later without changing the format; it would bring the segment decoder into the page bundle. Rejected: leaving the encoding to the app (every server-rendering app would copy the same base64 and `NaN` handling, as the examples and the integrations do today). User-confirmed 2026-10-23
