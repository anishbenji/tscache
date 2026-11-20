# Step 132 — DECISION: a failed or slow load deletes the records it could not read

Branch: `fix/132-load-timeout-cleanup` · Reviewer: the director's Codex gate · Rounds: 0 (built by a child; no review round run here) · Status: escalated (Decision concerns) · Verdict after triage: merge the documentation; the behaviour waits for the user

## The report

The parent thread's read-only persistence research at `6716b4d` raised a possible data-loss defect, not seen failing: a persisted cache's load can time out (5000 ms, counting the chunk import; N46, §4.10.6) or its read can fail, and in either case the cleanup that follows the stop deletes the very records the load could not read. A cache whose IndexedDB read takes over 5 s (cold disk, large cache, busy machine) would then lose its persisted data instead of trying again next session.

## Verdict

**Reproduced, and it is the specified behaviour.** Both paths delete every record of the cache. Decision N59 (locked, user-confirmed 2026-10-30) and architecture §4.10.6 say a stopped cache's records are deleted, and that a load beyond the deadline and a failed read are stops; two existing contract tests assert the deleting write. The code therefore does what the spec says, and the code is unchanged. Whether a stop during a load should delete is a design question for the user (Decision concerns, below). The reproducing tests are kept as `it.todo` entries with no asserted outcome, as step 121 handled its open question.

## The code path

`packages/tscache/src/persist/persister.ts` at `6716b4d`:

- The load deadline, armed by `open` (lines 237–243). It counts from `startedAt`, which the hosting sets to its own call time, so the chunk import counts against it (`hosted.ts`, `open`, `loaded.open(cacheId, startedAt)`):

  ```ts
  cache.loadTimer = setTimeout(
    () => {
      if (cache.status === "loading") this.#stop(cache, "unavailable");
    },
    Math.max(0, this.#timeoutMs - elapsed),
  );
  ```

- The read failure (lines 502–508):

  ```ts
  try {
    stored = await store.read(cache.id);
  } catch (error) {
    if (cache.status === "loading") {
      this.#stop(cache, "error", failureOf(error));
    }
    return;
  }
  ```

- A late read after the deadline is ignored (lines 510–511): `if (cache.status !== "loading") return;`.
- Both call `#stop` with the default `cleanup = true` (line 593), which queues the cleanup whenever a store is open (lines 606–608):

  ```ts
  if (cleanup && this.#store !== undefined) {
    const now = this.#now();
    this.#queue.push(this.#job("cleanup", cache, now, now + this.#timeoutMs));
  }
  ```

- The cleanup deletes every record of the cache, strict (lines 1011–1016):

  ```ts
  await store.write(cache.id, {
    deletePages: [{ ...EVERY_PAGE }],
    putPages: [],
    putCache: null,
    strict: true,
  });
  ```

What the cleanup does with records that were not applied: it deletes them all. Nothing distinguishes a cache that stopped during its load (which has changed nothing, since any mutation abandons the load, §4.10.5 rule 2) from one that stopped after a removal failed to land.

Where the deadline is spent decides the outcome, which the report did not note:

- **The read is slow** (the store is open): the cleanup is queued. In IndexedDB its read-write transaction waits for the pending read-only one and then commits, so the records go even when the cleanup's own deadline passes first, since an abandoned store call still completes (§4.10.6, the writer).
- **The store's opening is slow**: at the deadline `#store` is still undefined, so no cleanup is queued, and when the opening later resolves `#load` returns at `cache.status !== "loading"` (line 500). The records stay.
- **The chunk import is slow** (`persist/hosted.ts`, `#start`): its own timer turns persistence off with no persister and no store, and `#stopUnloaded` deletes nothing. The records stay.
- **The read rejects**: the store is open, so the cleanup runs. With a lost connection the cleanup fails too (`InvalidStateError`), and the records stay; with any other rejection they go.

## What the spec says

- N59 (`docs/decisions/N59-persistence-failures.md`): "The store failing to open, or a load beyond 5 s, stops the cache with `'unavailable'`; a failed read with `'error'` … A stopped cache's records are deleted with one strict write under its own deadline, since the disk may cover what memory withdrew; when that deletion fails as well, the records stay, the one way a removal can outlive its call."
- §4.10.6, Open: "Then one `store.read(id)` for every page; a rejection stops the cache with `'error'`." and "`open` resolves after the restore, or when `timeoutMs` passes first (the store's opening and the read counted together): the cache then stops with `'unavailable'` and the read's result, should it come, is ignored."
- §4.10.6, Failures: "**Stopping** a cache, for any reason: … and, when a store is open, one _cleanup_ job follows: a `write` of `{ deletePages: [{ start: -Infinity, end: Infinity }], putPages: [], putCache: null, strict: true }`, due at once, with its own deadline and no retry. … The disk may still cover what memory has withdrawn (a removal that never landed), and a later session must not load that".
- N61: "the cleanup that follows a stop" is a job of the writer; N46 bounds `cache()` at 5 s and says nothing about the records after it gives up; N57 makes a mutation abandon the load, so a cache still loading has changed nothing. N52 and N95 do not bear on it. §4.10.1 "When calls wait for the disk" says `cache()` resolves "after the load gave up (5000 ms, §4.10.6)" and is silent about the records.
- `site/guides/persistence.md`, Failures: "The cache stops persisting, its records are deleted".

No sentence says unread records must survive. "For any reason", together with N59 naming the load timeout and the read failure as stops, settles that they are deleted. The stated reason for the cleanup, though, is a removal memory made that the disk may not have; a cache stopped during its load has made none.

The contract tests pin the current outcome: `persister-load.test.ts`, "read rejection emits error details once and one strict cleanup" (asserts the one write is the delete-all plan) and "a gated read times out at 5000ms; a late result is ignored" (asserts one write after the timeout, the cleanup).

## The test

Reproduction at the level of the persister tests, `Persister` over `MemoryStore` under fake timers (`docs/testing.md`: no sleep, no wall clock). It was run from a scratch file and failed on both cases:

```ts
it("timeout: records survive and a later session loads them", async () => {
  const h = harness();
  h.engine.cache(config());
  const seeded = fixture();
  h.store.seed("persist", seeded);
  const gate = h.store.gate("read");
  const opening = h.persister.open("persist");
  await tick();
  await gate.entered;
  await tick(5000);
  await opening;
  gate.release();
  await tick();
  await h.persister.durable("persist");
  expect(h.store.records("persist")).toEqual(seeded);
  const next = harness({}, h.store);
  next.engine.cache(config());
  await next.persister.open("persist");
  expect(next.engine.get("persist", all).misses).toEqual([]);
});
it("read failure: records survive and a later session loads them", async () => {
  const h = harness();
  h.engine.cache(config());
  const seeded = fixture();
  h.store.seed("persist", seeded);
  h.store.fail("read", 1, "UnknownError", "read failed");
  await h.persister.open("persist");
  await tick();
  await h.persister.durable("persist");
  expect(h.store.records("persist")).toEqual(seeded);
});
```

Observed: after the timeout the store held `{"pages":[]}` (no cache record, no page), and a second persister over the same store loaded 0 points; after the read failure the store held `{"pages":[]}`. Both `expect(…).toEqual(seeded)` failed.

Committed: two `it.todo` entries in `persister-load.test.ts`, "132: records survive a load timeout and a later session loads them (undecided)" and "132: records survive a read rejection and a later session loads them (undecided)", with no asserted outcome. The test above is ready to become their bodies if the user chooses (B), (C) or (D), with the contract tests above changed to match by the contract-test author, and only with the user's explicit OK; this step leaves them as they are.

## Decision concerns

**Should a cache that stops during its load delete its records?** (Escalated; no code changed. Confirmed independently by the director's fact-check at `6716b4d`: the path is real whenever a store is open, which it always is once the read has been issued.)

Today a load that times out with the store open, or whose read rejects, deletes every record of the cache (N59, §4.10.6). A load that times out while the store is still opening, or while the chunk is importing, deletes nothing. A loading cache has made no change (N57), so the cleanup's stated reason, a removal that never landed, does not apply to it. N46 measured the full load of a year at one minute at 6.8 ms, so a 5 s timeout means a stalled or contended disk far more often than a cache too large to read. Under every option a stopped cache stays stopped for the rest of the worker's life (N59): "retry" below means a later session's load.

- **(A) Keep the current behaviour: every stop with a store open deletes.**
  - Data loss: a transient stall during the read (a cold start, a busy machine, the chunk import spending most of the 5 s) or a transient rejection (an aborted transaction) wipes the cache's history. The next session refetches all of it, which the primary use (N11: fetch immutable history once per device) exists to avoid.
  - Disk growth: none; the disk is freed.
  - Retry: none of the stored data. The next session starts cold, loads fast, refetches and persists again. A cache that keeps growing past what loads in 5 s alternates: one session pays the 5 s wait and the deletion, the next starts cold.
  - Change: none.
- **(B) A load timeout or a rejected read stops without a cleanup; the records stay for the next session.** Every other stop (a write's deadline, a quota error, `restore` throwing) keeps its cleanup.
  - Data loss: none from the load.
  - Disk growth: none. A stopped cache writes nothing more, so the disk holds what it held; records that never load again stay until a `clearAll`, a later load that succeeds and rewrites them, or the browser evicts the origin.
  - Retry: every later session tries the load again, without a bound. A stall costs that session up to 5 s on `cache()` (the existing bound) and leaves the cache cold and unpersisted; a rejection stops it at once. An application can leave the loop with `clearAll`.
  - Change: `#stop(cache, …, false)` on the two load paths (`persister.ts` lines 240 and 506); a dated clarification of N59 and §4.10.6; the two pinned contract tests change, by the contract-test author with the user's OK; the guide's Failures paragraph says which stops delete.
- **(C) As (B), plus a bounded number of failed loads across sessions before a cleanup.**
  - Data loss: none from a transient fault that clears within the bound; after the bound, as (A).
  - Disk growth: as (B) until the bound, then freed.
  - Retry: bounded, for example three sessions, so a store that can never load stops costing every session its wait.
  - Change: the count must survive the session, so it needs a persisted field or record (a format change of §4.10.2, a decision of its own) and a write from a cache that has stopped, which N59 forbids today. That write queues behind the stalled read in IndexedDB, as the cleanup does, so it lands only when the read ends; a worker that dies first loses the count. The most design and the most new rules of the four.
- **(D) A load timeout keeps the records; a rejected read (a corrupt or unreadable store) cleans up.**
  - Data loss: none from a stall. A rejection deletes, including a transient one (an `AbortError`, an I/O `UnknownError`): IndexedDB's error names do not separate a corrupt record from a passing fault.
  - Disk growth: as (B) for a stall; freed after a rejection.
  - Retry: a stall retries as (B); a rejection does not retry the stored data. A rejection that would repeat in every session self-heals.
  - Change: as (B), on the timeout path only; only the timeout contract test changes.

Recommendation: **(B)**. It loses nothing to a transient fault, matches the cleanup's own reason (a stop during the load has no withdrawn coverage to protect), and makes the load deadline behave the same wherever it was spent: today, whether the records survive depends on whether the opening or the read was slow. The case it leaves, a cache that cannot load in any session, costs a cold cache, which (A) also gives, plus at most the existing 5 s wait per session, and `clearAll` ends it. (C) buys the self-healing of that case at the price of a format change and a write from a stopped cache; it can follow (B) later if the repeated case is ever observed. (D) still loses data to transient rejections, which cannot be told apart from corruption. The case behind (A)'s self-healing, a cache too large to load in 5 s, belongs to the lazy-loading and byte-budget work of §4.10.10. A stop raised by `restore` throwing (§4.10.5) comes after a read that succeeded, from a cache already running, and keeps its cleanup under every option.

## Documentation changes

Each statement was checked against the code at `6716b4d`, then confirmed with a scratch test under fake timers (deleted after the run; four cases, all passed):

- **An open failure stops every tracked cache.** `#openFailed` stops every tracked cache, not only the one opening, with `'unavailable'` and no cleanup (`persister.ts`, lines 577–584). §4.10.6 Open said "this cache and every persisted cache opened later"; it now says every tracked cache, names the running caches that includes, and says no cleanup follows. The guide's Failures paragraph says such a stop covers every persisted cache and deletes nothing.
- **`flush(id)` waits for a job that is already running.** With nothing dirty and the cache's flush job running, `#flushOne` returns that job's settling (lines 267–274). §4.10.6 Scheduling said it "resolves … at once when nothing is dirty"; it now says it waits for the running job, and that `flush()` does so for every running cache.
- **A repeated `close()` waits for the first one.** `close()` returns the first call's promise (`this.#closing ??= …`, lines 325–342). §4.10.6 Close said "later calls resolve at once"; it now says they resolve when the first one does.
- **The `cacheId` check on the cache record.** `acceptRecord` rejects a record whose `cacheId` is not the cache's (`engine/restore.ts`, line 177), as `acceptPage` does for pages. §4.10.5 step 2 listed every other check of the cache record; it now lists this one too.
- **A lost connection reports `'error'`.** After the browser closes the connection or the store closes itself on `versionchange`, every store call rejects with `InvalidStateError` (`idb-store.ts`, `#database()`), and the persister never opens the store again. A load stops with `'error'`, a flush is retried until its deadline and stops with `'error'`, and the cleanup fails, so the records stay. A new bullet in §4.10.6 Failures says so, and the guide's Failures paragraph says it in one sentence.

`docs/INDEX.md`: `docs/architecture.md` re-measured at 284.1 KB (was 283.1 KB); `site/` at 272.0 KB of Markdown over its 42 tracked pages (`git ls-files 'site/*.md'` without `site/api/`, `wc -c`; was 271.8 KB).

## Contract-test changes

None. Two `it.todo` entries were added to `persister-load.test.ts`; no test or assertion was changed or removed.

## Verification

At the step's final head:

| Command                                                               | Result                                                                                                     |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `bunx vitest run` on the scratch reproduction (since deleted)         | 2 failed, as expected: the store held `{"pages":[]}` after each stop, and the next session loaded 0 points |
| `bunx vitest run` on the scratch documentation checks (since deleted) | 4 passed                                                                                                   |
| `bunx vitest run packages/tscache/test/persister-load.test.ts`        | 9 passed, 2 todo                                                                                           |
| `bun scripts/test-clocks.ts`                                          | `test-clocks: 195 files clean`                                                                             |
| `~/code/tscache-reports/bin/heavy-run.sh "132 child: ci" bun run ci`  | runs on the head that adds this file; its result is reported to the director                               |
