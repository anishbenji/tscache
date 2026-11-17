# N80: Subscribing against a worker without the feature

Row N80 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 114 from the M7 design proposal (`docs/design/m7-change-events.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Nothing happens: the listener is registered but never called, `client.features` reports the gap, and a development build prints one `console.warn` per client.** No `subscribe` is posted to such a worker. An application that must follow changes checks `client.features.has('cacheChanged')` and polls otherwise. The page keeps working during a deploy skew (finding M5). Rejected: `on` throwing `TscacheError` (breaks a page during the very skew M5 describes); a client-scoped `featureMissing` event (another event for a transient state). User decision 65, row D10 option (a), 2026-11-16 (§2.7, §4.8, step 114)
