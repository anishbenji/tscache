# N53: Record format (P9)

Row N53 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Records mirror the `Snapshot` envelope and the §3.4 payloads**: a page record holds the `Snapshot` of its page, and the cache record the envelope's dataset fields with the N20 config, so `validateSnapshot` checks a page and the `hydrate` rules apply it (one format, three uses, starter §3.7). Rejected: a format of its own. Director, 2026-10-30

## Amendment, 2026-11-21

User decision 83, row G9 option (a) (N114, step 129): a calendar cache's cache record is `format: 2`, whose `config` names the grid with one field, `grid`, in place of `interval` and `alignmentOffset` (architecture §4.10.2); its page snapshots are format 2 snapshots (N34). A fixed cache's records are unchanged. A cache applies only records of its own grid's format.
