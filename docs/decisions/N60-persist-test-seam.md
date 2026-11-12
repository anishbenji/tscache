# N60: Test seam

Row N60 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A narrow `PersistStore` interface.** The logic is contract-tested against `MemoryStore`, a test helper with failure injection, gates and a call log, deterministic under fake timers; the IndexedDB adapter is held to the same contract by a conformance suite over `fake-indexeddb` (dev dependency; Apache-2.0, no dependencies). Rejected: `fake-indexeddb` under every test (it has no quota to exceed and no way to hold a transaction, and its `setImmediate` scheduling is captured by fake timers); the fake alone (the adapter's key ranges and atomic abort would first run in a browser). Design, 2026-10-30; user-confirmed 2026-10-30. **Amended after review round 2:** a `FakeLockManager` beside `MemoryStore`, with a log, a way for the test to hold the lock, and the Web Locks abort rule, so the deadline on lock acquisition (N61) is pinned by the contract tests. Redesign, 2026-10-30. **That amendment was retired 2026-10-31 (user decision #8: SharedWorker only):** the persister takes no lock (N52, N61).
