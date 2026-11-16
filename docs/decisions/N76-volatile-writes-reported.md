# N76: Whether writes in the volatile region are reported

Row N76 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 114 from the M7 design proposal (`docs/design/m7-change-events.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Yes: `written` lists every slot the call touched, provisional ones included.** A put's touched slots are its authority (N13) or, without one, its batch's span (N3); a hydrate's are its applied parts. They are the slots touched, not the slots whose values differed, and a write that fails part-way reports them too, since an ascending prefix may have landed (N70). The forming bar of a live feed is exactly what a chart follows, so the reader report is separate from the persistence hook, which still clips below the watermark (§4.10.4): a live tail costs no disk write and still notifies. Rejected: reporting only below the watermark, as the persistence hook does (a live tail would never notify). User decision 65, row D6 option (a), 2026-11-16 (§4.5, step 114)
