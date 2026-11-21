# Step 122 — the review checklist catches up with M7 and M3

Branch: `chore/122-checklist-m7-m3` · Reviewers: pre-review 1 (Claude Opus) · Status: pre-review 1 fixed, awaiting the director

## Scope

`docs/review-checklist.md` still described the repository from before M7 (change events, step 114, PR #146) and M3 (memory bounds, step 121, PR #150). Pre-review 1 of step 121 raised this as a P2 (`docs/reviews/step-121.md`, R1-5); the checklist is a protected path, so the fix comes as its own chore step, which the user merges.

- `docs/review-checklist.md` §1 and §4: the changes below; §3, §7, §9 and §12: the items added after pre-review 1.
- `docs/architecture.md` §1 and §4's module layout (after pre-review 1).
- `docs/INDEX.md`: the `docs/review-checklist.md` row's size goes from 15.1 KB to 17.0 KB (`wc -c` is 17,037 bytes) and the `docs/architecture.md` row's from 283.1 KB to 283.5 KB (283,502 bytes).
- This file.

Nothing under `packages/` or `site/` changes. The branch merged `origin/main` at `6716b4d` before the pre-review fixes.

## Changes

### §1: two roadmap items are approved

The roadmap-leak item listed "subscriptions (dirty notifications)" and "LRU/eviction". Both were approved by the user and built:

- **Subscriptions.** User decision 65 (2026-11-16) approved M7's change events: architecture §2.7, "Change events (N71–N84, step 114)", and `docs/roadmap.md`, "Design sketch: subscriptions (dirty notifications)", which now reads "Specified in `docs/architecture.md` §2.7 (decisions N71–N84, user decision 65 of 2026-11-16) and built in step 114". The entry is removed.
- **Eviction.** User decision 67 (2026-11-16) approved M3: architecture §2.9, "an application may now set a byte budget, which the engine enforces by evicting the least recently used pages that nothing pins", and the roadmap's eviction sketch, now marked "Specified in `docs/architecture.md` §2.9 (decisions N86–N105 …) and built in step 121". The entry "LRU/eviction" is replaced by a qualified one, since part of eviction remains deferred: "eviction beyond A§2.9's (a unit other than the page or an order other than least recently used, N91, N92; or evicted pages kept on disk, which needs lazy loading and a disk budget, A§4.10.10, N95)". Its wording follows:
  - N91 and N92: the page is the eviction unit, and the order is least recently used;
  - N95: "Rejected for now: keeping the record and loading it on demand (needs lazy loading, which amends N46 and N57, and a disk budget; a later design step)", which is row E11 option (b) of `docs/design/m3-memory.md`, whose recommendation reads "(b) now; (a), with a disk budget, as its own design step later";
  - architecture §4.10.9's eviction row, "Keeping evicted pages on disk needs lazy loading and a disk budget (M3, E11)", and §4.10.10, which lists "lazy loading of pages on first read (it would let an evicted page cost a disk read instead of a fetch, with a disk budget, N95)" as later work.

The item's closing sentence, which said IndexedDB persistence had left the list, now names all three features that have: "IndexedDB persistence, change events and the memory budget are no longer on this list: they are specified in A§4.10 (N45–N61, N66), A§2.7 (N71–N84) and A§2.9 (N86–N105)." Every other entry is kept as it was.

### §4: `bytes` in the `Segment` interface

The item listing the `Segment` interface now reads (`extent`, `size`, `bytes`, `lookup`, `slice`, `countIn`, `sliceInto`, `mergeFrom`, `transferPayload`). Architecture §4.2 declares `readonly bytes: number` third, after `extent` and `size` and before `lookup` ("Bytes the buffers have allocated: capacity × the bytes of one slot across the fields, plus the mask; spare capacity included (N90, step 121)"), and `packages/tscache/src/segment/types.ts` matches.

## Other items read against architecture §2–§4

The rest of the checklist was read once against architecture §2–§4 on `main` (`4507d6a`). No other item names a term or list that M7 or M3 renamed or extended. The following gaps needed judgement and were first left for the user; the director has since asked for all five to be added (below, "Pre-review 1"):

1. **§3 has no item for eviction's coverage withdrawal.** §2.9's safety rule (N96) is that evicting a page drops its segments and withdraws its whole slot range from coverage in the same synchronous step, so an evicted page never reads as a confirmed gap. The roadmap calls it "the one way eviction could corrupt answers". §3 checks coverage only for `put` and `invalidate`. A candidate item: "Eviction withdraws the page's whole slot range from coverage in the step that drops its segments; with a consistent backend a budgeted cache's coverage and points are a subset of an unbudgeted one's (A§2.9, N96)."
2. **§12 does not say an eviction is not a removal.** The removal item lists the removals that flush at once with strict durability; an eviction's record deletion is relaxed and no call waits for it (N95, the §4.10.9 eviction row). The item is not wrong, since it does not list eviction, but a diff that made eviction strict, or counted it as a removal, would draw no item. A candidate addition: "An eviction marks its page as a write does: its record is deleted by the next flush, relaxed, and it is not a removal (N95)."
3. **§9 says nothing of `cacheChanged`.** "Events use the three scopes" still holds (`cacheChanged` is cache-scoped), but the event's distinctive rules have no item: it goes only to subscribed connections (N74), once per mutating call, posted before the call's response (N73), with `evicted` kept apart from `removed` (N99). Whether these warrant items is a judgement on how much of §2.7 the checklist should repeat.
4. **The "costs nothing when off" rule is stated only for the overlap warning (§4).** Architecture §2.7 and §2.9 make the same promise for a cache nobody subscribes to and for an engine without a budget ("Without a budget, nothing per operation"). A general item, or one per feature, is a judgement.
5. **§7 "Memory and transfer"** concerns buffer ownership and transfer; it has no item for the memory budget. Items 1–2 above may be the better home for what a budget needs.

Outside the checklist, noted for the director at first and fixed after pre-review 1:

- Architecture §1 still lists "subscriptions" and "eviction" as out of scope for v1, and checklist §1 cites A§1 as one source of its roadmap list. §1 should name §2.7 and §2.9 as it names §4.10 for persistence.
- Architecture §4's module layout omits `engine/memory.ts` (`MemoryBudget`, described in §4.6), and its `segment/types.ts` line lists four of the interface's members ("lookup / slice / mergeFrom / transferPayload"), which predates `countIn`, `sliceInto` and `bytes`.

## Pre-review 1 (Claude Opus)

Three P2 findings, all accepted, and four further changes the director asked for with them.

| Id   | Severity | Finding                                                                                                   | Resolution                                                                                                                                                                                                        |
| ---- | -------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-1 | P2       | Architecture §1 still lists subscriptions and eviction as out of scope for v1, and checklist §1 cites A§1 | Fixed in `d8bb07b`: §1's last sentence now says, as for persistence, that change events are specified in §2.7 (step 114) and the memory budget with its eviction in §2.9 (step 121); the index row is re-measured |
| PR-2 | P2       | Checklist §12's removal item could be read as covering evictions                                          | Fixed in `f94455c`: the item ends "An eviction is not a removal: it marks its page as a write does, and the next flush deletes the page's record, relaxed, with no call waiting for it (A§4.10.9, N95)"           |
| PR-3 | P2       | Checklist §3 has no item for eviction's coverage withdrawal                                               | Fixed in `f94455c`: gap 1's item, worded as drafted above                                                                                                                                                         |

Asked for by the director in the same message:

- **Gap 3, §9** (`f94455c`): "`cacheChanged` carries ranges, never values, and goes only to connections subscribed to its cache or to every cache, at most once per cache per mutating call, posted when the call ends: after its `cacheCleared`, before its `mergeWarning` events and its response. An eviction's withdrawn coverage is listed in `evicted`, apart from `written` and `removed` (A§2.7, N71, N73, N74, N99)." It follows §2.7's payload, subscription and delivery paragraphs.
- **Gap 4, cost when off** (`f94455c`), one clause per feature. In §9: "With nobody subscribed to a cache, a change posts nothing, allocates nothing and computes no withdrawn coverage (with a budget, the evicted-coverage index is still kept, N104); like the overlap warning (§4), the feature costs nothing when off (A§2.7, Cost)." In §7, the last sentence of the budget item: "Without a budget it costs nothing per operation: nothing is counted, ordered or pinned, and the orchestrator's check is a field read (A§2.9, Cost)."
- **Gap 5, §7** (`f94455c`): one item for the budget's configuration (one per engine, a positive safe integer or `ConfigError`, no default, the first budget an engine without caches receives holds; N87–N89, N100, N103), its eviction (whole pages, least recently used, pinned pages skipped, enforced synchronously at the end of each mutating call, of `restore` and at each pin release, never between a call's write and its coverage; N91–N94, N97), and the cost sentence above. Each clause restates a bullet of architecture §2.9.
- **Architecture §4's module layout** (`d8bb07b`): `segment/types.ts` now lists every member of the interface (`extent / size / bytes / lookup / slice / countIn / sliceInto / mergeFrom / transferPayload`, §4.2), and `engine/memory.ts` has a line: `MemoryBudget`, the counted total, the use order of pages, the pins of pending gets and the enforcement (§2.9, §4.6).
- **This file's Verification table**: records the final `bun run ci` result.

## Verification

| Command                                                         | Result                                                                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wc -c docs/review-checklist.md docs/architecture.md`           | 17,037 and 283,502 bytes, the 17.0 KB and 283.5 KB in `docs/INDEX.md`                                                                                                   |
| `bun run docs:check` (after `bun run build`)                    | Exit 0 on `f94455c` plus this file; `doc-anchors: 246 anchors in 42 pages resolve`                                                                                      |
| `heavy-run.sh "122 child: ci" bun run ci` (before pre-review 1) | Exit 0 on `fd0992c` and on `30dd3bd`: Vitest 156 files, 3,058 passed; Playwright 193 passed; bench smoke `ok`                                                           |
| `heavy-run.sh "122 child: ci" bun run ci` (final)               | Exit 0 on `b1fda15`, every change of the step in place: Vitest 156 files, 3,058 passed; Playwright 193 passed; bench smoke `ok`. The commit after it adds only this row |

## Contract-test changes

None.

## Decision concerns

The checklist additions of pre-review 1 (PR-2's §12 clause, PR-3's §3 item, and gaps 3–5: the §9 and §7 items with their two cost-when-off clauses) add review rules in the builder's wording, each restating approved architecture text (§2.7, §2.9, §4.10.9) and its decisions. The checklist is a protected path that the user merges: the user may strike or reword any of them at merge, and nothing else in the step depends on them.

## Round 1 (Codex) — reviewer verdict: merge

Head `c7a53fa`. No findings; the reviewer confirmed pre-review 1's three fixes and the five additions. The review settles at round 1. The user merges (protected path) and may keep, reword or strike any of the five checklist additions.
