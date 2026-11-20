# Step 131 — Triage of two possible M3 engine defects

Branch: `fix/131-m3-mutating-and-restore-evicted` · Status: triage done, awaiting the director's Codex gate · Verdict after triage: neither report is a defect under the spec as written; one decision concern for the user; three documentation fixes

## Scope

The parent thread's read-only walkthrough of the M3 code at `6716b4d` (step 121, PR #150) raised two possible defects, neither seen failing. This step checks each one against the spec and the code and writes a failing test where there is a defect. It also fixes three documentation nits the same walkthrough found. No engine code changed. §4.5's code sketches and the `grid.ts` header are left for step 129, as the brief asks.

## Report (a): enforcement that throws inside a mutating call

**The report.** `CacheState.#mutating` (`packages/tscache/src/engine/cache.ts:425`) calls `this.#memory?.settle()` first in its `finally` block. If enforcement throws, `onMutate` and `onReaderChange` are skipped, so readers and persistence could miss a change that did happen.

**Verdict: not a defect. The throw cannot happen.** The structure is as reported, but no input makes enforcement throw.

**What the spec requires.** The `onMutate` hook contract (`engine/cache.ts:227`) says it is "called once at the end of every mutating call … before it returns or rethrows". N73 says the engine "reports them once when the call ends, returned or thrown". So a mutating call that throws must still signal. Enforcement itself is specified as one synchronous step per page that cannot fail: §4.5 says "`evict(page)` runs §2.9's safety rule in one synchronous step".

**What happens when it does throw.** A probe (a scratch test, not committed) used the internal `observeCaches` seam with an observer whose `onEvict` throws. A put over page 1 under a one-page budget threw `boom`. The put had landed and covered `[4, 7]` and evicted page 0, but neither `onMutate` nor the reader change ran. So the report describes a real path, but only an observer that throws can reach it.

**Why it cannot happen.** Here is everything `MemoryBudget.settle` (`engine/memory.ts`) runs, and whether it can throw:

- `#pinned`, `#drop` and the use-order walk use only `Set`, `Map` and array operations. `holdsProvisional` and `pageBytes` call `SegmentStore.#onPage`, a binary search plus a scan. None of them throws.
- `CacheState.evict` calls:
  - `SegmentStore.evictPage`: one `splice`, no allocation of typed arrays.
  - `CoverageIndex.covered` and `subtract` over `pageRange(page, cap)`, then `#evicted.add` over the covered ranges. `assertSlotRange` throws only for a range whose endpoints are not safe integers or that is reversed. A page number comes from a stored slot, which the grid has already validated as a safe integer (§4.1), and `pageRange` multiplies it by the cap, staying inside that range. The covered ranges are sub-ranges of the index's own ranges, so they are valid.
  - `includeRange`, which is array arithmetic.
  - `onEvict`, through the engine, to every observer. The only observers in the package are the persister and the RPC server. `observeCaches` is internal; no package entry exports it (§4.6, checked with `grep` over `src/entries`). The persister's `#evicted` (`persist/persister.ts:398`) returns early for a cache it does not track, or one that is stopped or closed. It then marks pages (`addRange`, arithmetic) and calls `#quiet`, which reads `performance.now()`, queues a job and arms one `setTimeout`. The RPC server registers no `onEvict`.
- `flushEvicted`, which runs for each other cache once enforcement has ended, calls `hasReaders` (`Set` and `Map` lookups) and `onReaderChange`. That reaches the RPC server's `#changed` (`rpc/server.ts:504`). It calls `engine.configOf` (the cache exists, and caches are never deleted) and `toMs`, which is arithmetic. It then posts through `#send`, which catches every `postMessage` failure.

So only two things can make enforcement throw: a broken internal invariant (a programming error, which the property tests in `m3-memory-engine.test.ts` exercise) or running out of memory, which V8 does not deliver as a catchable error for allocations this small.

**No change.** Moving `settle()` into its own `try` would only harden against a future observer that throws. The brief allows no code change without a test, and a test could reach that path only through an observer that throws, which no production code installs. If a later observer can throw, the fix is to run `settle()` inside a `try` whose `finally` holds the `onMutate` and reader-report block. Its test would be the probe above, asserting `onMutate` once and a reader change that has the put's `written` and `evicted`.

## Report (b): pages a restore trims, and the evicted index

**The report.** Pages that enforcement trims during a `restore` still enter the evicted-coverage index. A later `invalidate` then reports them, although no reader was ever shown them.

**Verdict: the mechanics are confirmed. Whether this is a defect is not settled by the spec (Decision concerns, D1). Nothing is fixed.**

**Correction to the report.** A later `invalidate` reports the range in `removed`, not in `evicted`: `#withdraw` lists the part of its range that is in the evicted index (N104).

**What the code does.** `CacheState.evict` (`engine/cache.ts:664`) adds every covered range of the page to `#evicted` unconditionally. During `restore`, `#restoring` only keeps the range out of `#pendingEvicted`, and so out of any reader change. A scratch test (not committed) used a budget of two pages and restored three pages of `[0, 11]` from records. Enforcement evicted page 0. Afterwards `evictedIndex("a")` was `[[0, 3]]`, the restore had sent no reader change, and `invalidate("a", [0, 3])` sent `{ written: [], removed: [[0, 3]], cleared: false }`.

**What the spec says.**

- For the mechanism, the literal text matches the code. Architecture §4.5 says "`evict(page)` … adds the recorded ranges to the evicted index". §2.7 rule (2) says "Each cache keeps the coverage it evicted in a second coverage index, also while nobody subscribes". Neither makes an exception for `restore`.
- For a restore's own trimmed pages, §4.5 says: "The pages a `restore` trims from its own cache are not reported (no reader has seen them, and a load sends nothing, §2.7)". In context, "reported" means the eviction's own reader change, but the reason it gives applies just as well to a later `removed`.
- For the purpose of the index, N104 says: "A view still showing an evicted range therefore hears a later restatement, and no event names a range that was never cached". The M3 design's E21 row (`docs/design/m3-memory.md`) lists as a benefit of option (a): "no spurious events for ranges never cached".

The restore-trimmed range was cached for the length of one synchronous call, so a strict reading of "never cached" does not cover it. But no view can show it: `cache()` resolves only after the load (§2.7, "What sends one"; §4.10.5), and the cache's own pages all come from the load, since a restore applies only into a cache that knows nothing. The spec therefore states both the mechanism (every eviction enters the index) and a purpose that this case does not serve. It does not say which wins.

**Cost of the current behaviour.** One spurious `removed` range per later removal over a trimmed range that no write has touched since. Under N84 it causes one fetching read in each subscribed view whose shown range overlaps it. A view that had already fetched the range wrote it, which removed it from the index (§4.5), so only views that never fetched there hear it. The data stays correct either way.

**Hydrate.** The brief also asks about pages trimmed while a snapshot hydrates. This is not a defect: `hydrate` is a mutating call, so its own trimmed pages go into its reader change's `evicted` alongside its `written` (§2.7 rule (1), "a put that evicts pages of its own cache sends that cache one event with its `written` and its `evicted`"; N77 gives `hydrate` the same event). A reader has therefore been told about them, and keeping them in the index is what N104 prescribes.

## Documentation fixes

| Commit     | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4393fb33` | Architecture §2.8 said to escape "every `<` as `<`". The shipped snippet (`site/snippets/snapshots-server.ts`) and the guides (`site/usage/snapshots.md`, `site/guides/ssr.md`) replace it with `<`, which keeps the JSON valid. The text now says `<`.                                                                                                                                                                                |
| `a82d90b1` | §4.2 said payload `fields` follow "the schema's declaration order". The encoder (`segment/dense.ts:70`) and decoder (`segment/payload.ts`) use `Object.entries`, and `validateFields` accepts names such as `"1"`, so integer-like names come first, ascending. The text now says JavaScript key order and explains it. The `DenseSegmentPayload.fields` TSDoc in `src/types.ts` had the same wording and is fixed in the same commit. |
| `0c26c227` | The `decodeSnapshot` comment in `src/snapshot.ts` had one overlong line. It is rewrapped, with the wording unchanged.                                                                                                                                                                                                                                                                                                                  |

## Contract-test changes

None. No test was added, changed or removed. Report (a) has no reachable failing case, and report (b) waits on D1. Neither probe test was committed.

## Decision concerns

**D1. Should the pages a `restore` trims from its own cache enter the evicted-coverage index (N104)?**

- **(A) Yes, as now.** The literal §2.7 and §4.5 text applies: every eviction enters the index.
  - Pros: no change; one rule for every eviction.
  - Cons: a later `invalidate` or watermark withdrawal over such a range sends a `removed` that no view needs. This is the spurious event E21 (a) was chosen to avoid, and it costs a fetching read in a subscribed view that shows the range without having fetched it.
- **(B) No.** `evict` skips `#evicted.add` while `#restoring` is set, a one-line change in `CacheState.evict`. §2.7 rule (2) and §4.5 would gain one sentence: "the pages a `restore` trims from its own cache stay out of the index, since no reader has seen them".
  - Pros: matches N104's stated purpose and §4.5's reason. No event names a range that no reader could have been shown.
  - Cons: a small exception to state in the spec and test. Other caches' pages evicted during a restore must still enter the index, since readers may have seen them.
- **Recommendation: (B).** The failing test to write first extends `m3-memory-accounting.test.ts:137`. Restore three pages under a two-page budget, then `invalidate` the trimmed page: assert that no reader change is sent, and that `evictedIndex("a")` is empty after the restore. A second assertion: evict another cache's page during the same restore, then `invalidate` it, and assert that its `removed` still lists the page.

## Verification

- `bun scripts/test-clocks.ts`: `test-clocks: 195 files clean`, exit 0.
- `~/code/tscache-reports/bin/heavy-run.sh "131 child: ci" bun run ci` on the branch head that adds this file: exit 0.
- The two probes for (a) and (b) ran as scratch Vitest files with `bunx vitest run`, and their output is quoted above. They were deleted afterwards.
- The bench was not run: no engine code changed. The only source edits are one TSDoc line in `src/types.ts` and one comment in `src/snapshot.ts`.
