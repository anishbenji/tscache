# Step 122 — the review checklist catches up with M7 and M3

Branch: `chore/122-checklist-m7-m3` · Reviewers: none yet · Status: built, awaiting review

## Scope

`docs/review-checklist.md` still described the repository from before M7 (change events, step 114, PR #146) and M3 (memory bounds, step 121, PR #150). Pre-review 1 of step 121 raised this as a P2 (`docs/reviews/step-121.md`, R1-5); the checklist is a protected path, so the fix comes as its own chore step, which the user merges.

- `docs/review-checklist.md` §1 and §4: the changes below.
- `docs/INDEX.md`: the `docs/review-checklist.md` row's size goes from 15.1 KB to 15.3 KB (`wc -c docs/review-checklist.md` is 15,303 bytes).
- This file.

Nothing under `packages/`, `site/` or `docs/architecture.md` changes.

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

The rest of the checklist was read once against architecture §2–§4 on `main` (`4507d6a`). No other item names a term or list that M7 or M3 renamed or extended, so nothing else is changed. The following are gaps that need judgement, left for the user:

1. **§3 has no item for eviction's coverage withdrawal.** §2.9's safety rule (N96) is that evicting a page drops its segments and withdraws its whole slot range from coverage in the same synchronous step, so an evicted page never reads as a confirmed gap. The roadmap calls it "the one way eviction could corrupt answers". §3 checks coverage only for `put` and `invalidate`. A candidate item: "Eviction withdraws the page's whole slot range from coverage in the step that drops its segments; with a consistent backend a budgeted cache's coverage and points are a subset of an unbudgeted one's (A§2.9, N96)."
2. **§12 does not say an eviction is not a removal.** The removal item lists the removals that flush at once with strict durability; an eviction's record deletion is relaxed and no call waits for it (N95, the §4.10.9 eviction row). The item is not wrong, since it does not list eviction, but a diff that made eviction strict, or counted it as a removal, would draw no item. A candidate addition: "An eviction marks its page as a write does: its record is deleted by the next flush, relaxed, and it is not a removal (N95)."
3. **§9 says nothing of `cacheChanged`.** "Events use the three scopes" still holds (`cacheChanged` is cache-scoped), but the event's distinctive rules have no item: it goes only to subscribed connections (N74), once per mutating call, posted before the call's response (N73), with `evicted` kept apart from `removed` (N99). Whether these warrant items is a judgement on how much of §2.7 the checklist should repeat.
4. **The "costs nothing when off" rule is stated only for the overlap warning (§4).** Architecture §2.7 and §2.9 make the same promise for a cache nobody subscribes to and for an engine without a budget ("Without a budget, nothing per operation"). A general item, or one per feature, is a judgement.
5. **§7 "Memory and transfer"** concerns buffer ownership and transfer; it has no item for the memory budget. Items 1–2 above may be the better home for what a budget needs.

Outside the checklist, noted for the director rather than changed here (the brief scopes this step to the checklist):

- Architecture §1 still lists "subscriptions" and "eviction" as out of scope for v1, and checklist §1 cites A§1 as one source of its roadmap list. §1 should name §2.7 and §2.9 as it names §4.10 for persistence.
- Architecture §4's module layout omits `engine/memory.ts` (`MemoryBudget`, described in §4.6), and its `segment/types.ts` line lists four of the interface's members ("lookup / slice / mergeFrom / transferPayload"), which predates `countIn`, `sliceInto` and `bytes`.

## Verification

| Command                                      | Result                                       |
| -------------------------------------------- | -------------------------------------------- |
| `wc -c docs/review-checklist.md`             | 15,303 bytes, the 15.3 KB in `docs/INDEX.md` |
| `bun run docs:check` (after `bun run build`) | See the step report                          |
| `heavy-run.sh "122 child: ci" bun run ci`    | See the step report                          |

## Contract-test changes

None.

## Decision concerns

None.
