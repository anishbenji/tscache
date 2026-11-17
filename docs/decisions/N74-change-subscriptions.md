# N74: How the worker knows who listens

Row N74 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 114 from the M7 design proposal (`docs/design/m7-change-events.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Two ops, `subscribe` and `unsubscribe`; `cacheChanged` goes to subscribed connections only.** Their params are `{ cacheId }` or `{ all: true }`. A client sends `subscribe` for the first `cacheChanged` listener of a cache (`cache.on`) or of every cache (`client.on`) and `unsubscribe` for the last one; both are fire-and-forget, so `on` stays synchronous. A connection's subscriptions go with it (dispose, `pagehide`, `bye`). With no subscriber a change costs one check besides the persistence hook (§3.6 of the proposal): no message, no allocation, no coverage lookup. A subscription is asynchronous, which "subscribe, then read" handles: both are messages on one port, so every change after the read is reported. `cacheCleared` keeps going to every ready port. Rejected: broadcasting to every ready port with the client filtering, as for `cacheCleared` (a `postMessage` per change per tab for every application, listening or not). User decision 65, row D4 option (a), 2026-11-16 (§3.2, §4.7, step 114)
