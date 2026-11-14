# Step 98 — Design spec for memory bounds (M3)

Branch: `docs/98-m3-memory-spec` · Reviewer: not yet run (the director runs the review) · Rounds: 0 · Status: awaiting review · Verdict after triage: pending

## Scope

The second of the three design steps of user decision 46 A (2026-11-13: after 0.1.0, M7, then M3, then M5; each a spec first, then the user's decision rows, then contract tests). It answers finding M3 of the review of 2026-11-10 (`docs/reviews/2026-11-review.md`, M3 and §3c): nothing bounds or reports the memory the cache holds, and a SharedWorker holds it for every tab and outlives the tab that opened it.

Documentation only: no code, no tests, nothing under `packages/` changes.

| Commit (by subject)                                     | What                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `docs: propose the memory-budget design for finding m3` | `docs/design/m3-memory.md`; a paragraph in the roadmap's eviction sketch linking to it; a `docs/design/` row in `docs/INDEX.md` |
| `docs(review): step 98 scope and verification`          | This file; the `docs/INDEX.md` sizes                                                                                            |

**Where the design lives.** A proposal file, `docs/design/m3-memory.md`, rather than a section of `docs/architecture.md`. The architecture document records approved contracts; this design has eighteen open decision rows, and three of them would amend approved §4.10 text (E11, E12) or the M7 draft (E16). Once the user decides them, the contract-test step moves the approved text into architecture §2.1, a new §2.9, §3.2, §4.3–§4.6, §4.9 and §4.10 and adds the decision files, as the persistence sketch became §4.10. Step 92 made the same choice for M7 and creates `docs/design/` on its own branch; this branch creates it too, so the two `docs/INDEX.md` rows for `docs/design/` merge into one row naming both files.

**What it covers,** as the brief asked: what is counted (segment bytes at allocated capacity, per dtype and presence mask) and what is not (coverage, warnings, read results, transient put and persistence buffers, object overhead), and why; the budget's scope (one per engine: per origin and worker URL under a SharedWorker, per tab otherwise, per `Engine` on a server) and its configuration (`ClientOptions.memoryBudget`, first value wins); the eviction policy (least recently used pages, where a use is a read or a write of points by any tab); what is never evicted (a pending orchestrated `get`'s request, pages holding a provisional point, dirty pages of a persisted cache until flushed, the triggering call's pages); the safety rule (an evicted page's whole slot range leaves coverage, so it reads as `uncached`, never as a confirmed gap); persistence (evict from memory only, the record stays, the next worker's eager load brings it back; lazy loading stays later), with a table showing why no stale record survives a later change; the interactions with `cacheOnly`, orchestrated gets, `mergeWarning`, `restore`, `hydrate`, auth pending and `clearAll`; M7's change event; zero cost without a budget and the cost per operation with one; the public API, an additive protocol change and the version; and 21 contract and browser tests for the later step.

**Two findings the spec makes about earlier text.** (1) The M7 draft (step 92) reports an eviction in `removed`, and its read rule makes every view showing a removed range refetch it. After an eviction that causes thrash across tabs whenever the views' ranges exceed the budget: each refetch evicts another view's pages. The proposal reports eviction in a separate `evicted` list that needs no re-read (E16), to be decided with M7. (2) The §4.10.9 eviction row asks a full rewrite to keep evicted pages' records; every cause of a rewrite (a clear, a version change, an abandoned load, an invalid record) makes them stale or unverifiable, so the proposal recommends deleting them (E12).

**Claims checked against the code.** Every statement about the current engine in the proposal's §2 table and §3 cites a file and line on `main` at `98b7bbf`; each was read at those lines, not inferred. The architecture and decision citations (§4.10.2 at line 1371, §4.10.6 property (a) at 1685, the §4.10.9 eviction row at 1777, §4.10.10 at 1781; N46, N57) were read in full.

## Decisions for the user

All eighteen rows, E1–E18, are open and listed with options, pros, cons and a recommendation in §4 of the proposal. None is decided here; the proposal's §3 assumes each recommendation. Four rows need the user's explicit approval because they amend approved text, if taken as recommended:

- **E11 (c)** (evict from memory only; the record stays; reloaded by the next worker) amends §4.10.2 "Canonical records" and §4.10.6 property (a): the disk may hold the records of evicted pages besides `recordsOf(S)`. Option (a), lazy loading, would amend N46 and N57 instead.
- **E12 (a)** (a full rewrite deletes evicted pages' records) replaces the last clause of the §4.10.9 eviction row.
- **E16 (a)** (an `evicted` list in `cacheChanged`) amends the eviction row of the M7 draft (§3.2 of `docs/design/m7-change-events.md`), and is best decided together with M7's D2 and D12.
- **E18 (a)** follows N37 (additive ops, `PROTOCOL_VERSION` stays 1) and leaves the locked §3.1 handshake untouched; option (b) would change it.

## Verification

| Check                                                               | Result                                                                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `bun run build`, then `bun run docs:check`                          | exit 0; `doc-anchors: 246 anchors in 42 pages resolve`                                                   |
| `~/code/tscache-reports/bin/heavy-run.sh "98 child: ci" bun run ci` | recorded in the step's report to the director (a result written here would change the head it describes) |
| `bunx biome check` on the changed files                             | clean after `bunx biome format --write`                                                                  |
| Line references in the proposal                                     | each read at the cited lines with `cat -n`, `awk` or `grep -n` on `98b7bbf`                              |
| `docs/INDEX.md` sizes                                               | re-measured with `wc -c` after the last edit (1 KB = 1,000 bytes)                                        |

Not verified: nothing is built, so no behaviour in the proposal is tested; the cost figures in its §3.9 are reasoned from the code, not measured.

## Contract-test changes

None.

## Decision concerns

None yet; the review has not run.
