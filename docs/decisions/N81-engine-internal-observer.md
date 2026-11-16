# N81: Whether the change event is part of the engine's public surface

Row N81 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 114 from the M7 design proposal (`docs/design/m7-change-events.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**No: the engine reports changes to an internal observer, and the RPC server builds the event.** `./engine`'s public `Engine` gains no event, so N21's split stays true of its public events (the engine emits only cache-scoped `cacheCleared`; the server sends the request-scoped ones), and a listener error cannot propagate out of a mutating call. Server-side `Engine` users (SSR, Node) that need the event use an in-process client. Rejected: `engine.on('cacheChanged')` (public surface to version, and a synchronous listener error would propagate out of the mutating call, as `cacheCleared`'s can). User decision 65, row D11 option (a), 2026-11-16 (§4.6, step 114)
