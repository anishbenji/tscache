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

Committed: two `it.todo` entries in `persister-load.test.ts`, "132: records survive a load timeout and a later session loads them (undecided)" and "132: records survive a read rejection and a later session loads them (undecided)", with no asserted outcome. The test above is ready to become their bodies if the user chooses (b) or (c), with the two contract tests above changed to match by the contract-test author.

## Decision concerns

**Should a cache that stops during its load delete its records?** (Escalated; no code changed.)

Today a load that times out with the store open, or whose read rejects, deletes every record of the cache (N59, §4.10.6). A load that times out while the store is still opening, or while the chunk is importing, deletes nothing. A loading cache has made no change (N57), so the cleanup's stated reason, a removal that never landed, does not apply to it. N46 measured the full load of a year at one minute at 6.8 ms, so a 5 s timeout means a stalled or contended disk far more often than a cache too large to read.

| Option                                                                                                                         | Data loss                                                                                                                                                                                                                                                  | Disk and later sessions                                                                                                                                                                                                                                                                                                 | Change                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Keep: every stop deletes (today)                                                                                           | A transient stall during the read (cold start, busy machine, the chunk import spending most of the 5 s) wipes the cache's history; the next session refetches it all, which the primary use (N11, fetch immutable history once per device) exists to avoid | Self-healing: a read that keeps failing or a cache too large to read in 5 s is emptied, so the next session starts cold, persists again and has fast loads until it grows back. Disk freed                                                                                                                              | None                                                                                                                                                                                    |
| (b) No cleanup for a stop while the cache is still loading (the load deadline and a read rejection); every other stop keeps it | None from the load: the records stay and the next session tries again                                                                                                                                                                                      | A read that fails or stalls every time stops that cache in every session (5 s of waiting on `cache()` for a stall, at once for a rejection) and the records stay until a `clearAll`, a load that succeeds, or the browser evicts them. No growth: a stopped cache writes nothing more, so the disk holds what was there | `#stop(cache, …, false)` on the two load paths; N59 and §4.10.6 gain a dated clarification; the two contract tests above change; the guide's Failures paragraph says which stops delete |
| (c) Keep the records after the load deadline only; delete after a read rejection                                               | None from a stall; a rejection deletes                                                                                                                                                                                                                     | A stall behaves as (b); a rejection that would repeat (an unreadable record) self-heals as (a). A transient rejection (an aborted transaction) still loses the records                                                                                                                                                  | As (b), on the deadline path only                                                                                                                                                       |

Recommendation: **(b)**. It loses nothing to a transient fault, matches the cleanup's own reason (a stop during the load has no withdrawn coverage to protect), and makes the load deadline behave the same wherever it was spent: today, whether the records survive depends on whether the opening or the read was slow. The repeated-failure case it leaves (a cache that cannot load stays off and keeps its records) costs a cold cache, which is what (a) gives as well, and an application can leave it with `clearAll`. The case behind (a)'s self-healing, a cache too large to load in 5 s, belongs to the lazy-loading and byte-budget work of §4.10.10. A stop raised by `restore` throwing (§4.10.5) comes after a read that succeeded, from a cache already running, and keeps its cleanup under every option.

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
