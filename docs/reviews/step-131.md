# Step 131 — Triage of two possible M3 engine defects

Branch: `fix/131-m3-mutating-and-restore-evicted` · Status: phase B built; awaiting the director's Codex gate · Verdict after triage: report (a) is not a defect; report (b) is fixed under user decision 96 (B), 2026-11-21; three documentation fixes; pre-review 1 and security lane run 1 fixed

## Scope

The parent thread's read-only walkthrough of the M3 code at `6716b4d` (step 121, PR #150) raised two possible defects, neither seen failing. This step checks each one against the spec and the code and writes a failing test where there is a defect. It also fixes three documentation nits the same walkthrough found. Phase A (triage) changed no engine code. Phase B fixes report (b) after the user's decision 96 (section Phase B). §4.5's code sketches and the `grid.ts` header are left for step 129, as the brief asks.

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

**Verdict: the mechanics are confirmed. At triage the spec did not settle whether this is a defect (Decision concerns, D1). The user chose (B) in decision 96 (2026-11-21), and it is fixed in `44814eb0` (Phase B, below).** The rest of this section is the triage as written.

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
| `4393fb33` | Architecture §2.8 said to escape "every `<` as `<`". The shipped snippet (`site/snippets/snapshots-server.ts`) and the guides (`site/usage/snapshots.md`, `site/guides/ssr.md`) replace it with `\u003c`, which keeps the JSON valid. The text now says `\u003c`.                                                                                                                                                                      |
| `a82d90b1` | §4.2 said payload `fields` follow "the schema's declaration order". The encoder (`segment/dense.ts:70`) and decoder (`segment/payload.ts`) use `Object.entries`, and `validateFields` accepts names such as `"1"`, so integer-like names come first, ascending. The text now says JavaScript key order and explains it. The `DenseSegmentPayload.fields` TSDoc in `src/types.ts` had the same wording and is fixed in the same commit. |
| `0c26c227` | The `decodeSnapshot` comment in `src/snapshot.ts` had one overlong line. It is rewrapped, with the wording unchanged.                                                                                                                                                                                                                                                                                                                  |

## Pre-review (Claude), not the gate

The director relayed Fable pre-review 1 and security lane run 1 together. Item PR1-1 came from both. The relay did not say which review raised PR1-2 to PR1-4, so they are listed here. All four were validated and accepted.

| #     | Sev | Finding                                                                                                                                                                        | Decision | Resolution                                                                                                                                                                                                                                                                                                                                       |
| ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR1-1 | P2  | The `4393fb33` row of this file's Documentation fixes table showed a bare `<` in both places where the replacement is meant. Copying that escape would leave `</script>` open. | accepted | Validated with `od -c`: both places held `` `<` ``. The tool that wrote the file had decoded the JSON escape. Both now hold `\u003c`, checked again with `grep -o` and `od -c`. Fixed in the commit that adds this section. The commit body of `4393fb33` is left as it is; this row is the record.                                              |
| PR1-2 | P2  | The `docs/architecture.md` row of `docs/INDEX.md` gave 283.1 KB; the file is 283.2 KB.                                                                                         | accepted | `wc -c` gave 283,177 bytes, and 283,243 after PR1-4's edit; both are 283.2 KB. Fixed in `d528022d`.                                                                                                                                                                                                                                              |
| PR1-3 | P2  | The field order §4.2 now describes had no test pinning it, and two test titles still said "declaration order".                                                                 | accepted | `segment-payload.test.ts` gains a case with fields `{ b, "1", a, "0" }` that expects `0, 1, b, a`. The titles at `segment-payload.test.ts:143` and `cache-snapshot.test.ts:241` now say "schema key order"; no assertion changed. Fixed in `649b8031`. Today's code already gives this order, so this is a regression test, not a contract test. |
| PR1-4 | nit | "Integer-like names" is imprecise. Only canonical array-index names come first; `"-1"` and `"01"` keep insertion order.                                                        | accepted | §4.2 and the `DenseSegmentPayload.fields` TSDoc now say "canonical array-index names (`"0"`, `"12"`) first, ascending". Fixed in `ddf5019b`. The `a82d90b1` row above keeps its wording as the record of that commit.                                                                                                                            |

## Security lane

Run 1 raised PR1-1, the escape lost from this file's Documentation fixes row (above). It raised nothing else: no finding touched the engine, the protocol or the persistence code. Nothing is open.

## Phase B: report (b) fixed under decision 96 (B)

The user answered D1 (director queue #96) with option (B) on 2026-11-21: the pages a `restore` trims from its own cache stay out of that cache's evicted-coverage index.

**Contract tests (phase A, Codex).** Codex wrote three tests, a new `describe` block "M3 restore-trimmed coverage (step 131)" in `packages/tscache/test/m3-memory-accounting.test.ts`. They were committed unchanged with the code, as `AGENTS.md` requires.

1. "keeps a restore's own trimmed page out of the evicted index and later reader changes": restores three pages under a two-page budget. It asserts that the trimmed page `[0, 3]` is not in the index. It then checks that `invalidate([0, 2])` sends nothing and that `invalidate([3, 4])` sends `removed: [4]` only, the one surviving covered slot. Without the fix this test fails; I confirmed it by putting the old line back temporarily: 1 failed, 9 passed.
2. "remembers another cache's page evicted during restore and reports it on removal": cache `old`'s page evicted by the same enforcement is still indexed, is reported once in `evicted`, and is reported in `removed` by a later `invalidate`. It passes with and without the fix.
3. "reports the page hydrate trims in its own reader change": `hydrate` sends `written: [0, 11]` and `evicted: [0, 3]` in one event. It passes with and without the fix.

**Code.** One condition in `CacheState.evict` (`engine/cache.ts`): `if (!this.#restoring) this.#evicted?.add(range);`. `#restoring` is set only on the cache `restore` runs on, so another cache evicted by the same enforcement indexes its pages as before (test 2). The `evict` TSDoc names the exception. No other line was needed.

**Spec.**
- Architecture §2.7 rule (2) gains: "The pages a `restore` trims from its own cache stay out of that cache's index, since no reader has seen them (user decision 96, 2026-11-21, narrowing N104); another cache's pages the same enforcement evicts enter that cache's index as any eviction does."
- §4.5 gains, after the sentence on not reporting those pages: "Nor do they enter the evicted index: `evict` skips the index while `restore` runs on its own cache, so a later removal over them lists only the coverage it withdrew (user decision 96, 2026-11-21, narrowing N104)."

**How decision 96 is recorded.** As a dated amendment to N104 (`docs/decisions/N104-evicted-coverage-index.md`, "Amendment, 2026-11-21"), not as a new decision file. `docs/INDEX.md` gives the rule: "A new decision gets a file `N<next>-<slug>.md` and one index line in §8; an amendment edits the file, adds a dated note and updates the index line if the first clause changes". Decision 96 narrows N104 without changing its first clause, so N104's §8 line is unchanged. The precedent is N70's amendment under user decision 52.

**Index.** `docs/architecture.md` is now 283,710 bytes (283.7 KB), and `docs/decisions/` 176,890 bytes (176.9 KB); both rows of `docs/INDEX.md` are updated.

## Contract-test changes

- `44814eb0` adds Codex's three phase A contract tests (Phase B, above), unchanged. No existing contract test was changed or removed.
- `649b8031` adds one regression test and retitles two existing tests without changing what they assert (PR1-3).
- Report (a) has no reachable failing case. Neither triage probe test was committed.

## Decision concerns

**D1. Should the pages a `restore` trims from its own cache enter the evicted-coverage index (N104)?** Answered: (B), user decision 96, 2026-11-21. Built in `44814eb0`. The options below are kept as raised.

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
- Phase A only: the bench was not run: no engine code changed. The only source edits are the `DenseSegmentPayload.fields` TSDoc in `src/types.ts` and one comment in `src/snapshot.ts`.
- After the pre-review fixes: `bunx vitest run packages/tscache/test/segment-payload.test.ts packages/tscache/test/cache-snapshot.test.ts` passed 127 tests. On that head (`830d62ba`), `bun scripts/test-clocks.ts` and `~/code/tscache-reports/bin/heavy-run.sh "131 child: ci" bun run ci` both exited 0.
- Phase B: `bunx vitest run packages/tscache/test/m3-memory-accounting.test.ts` gave 1 failed, 9 passed without the fix, and 10 passed with it; all six `m3-memory-*` files passed 100 tests. `bunx tsc --noEmit -p packages/tscache` exited 0. On the final head, `bun scripts/test-clocks.ts`, `~/code/tscache-reports/bin/heavy-run.sh "131 child: ci" bun run ci` and `~/code/tscache-reports/bin/heavy-run.sh "131 child: bench" bun run bench` all exit 0 with no gated bench case failing.
