# Step 92 — Design spec for change notifications (M7)

Branch: `docs/92-m7-change-events-spec` · Reviewer: not yet run (the director runs the review) · Rounds: 0 · Status: awaiting review · Verdict after triage: pending

## Scope

The first of the three design steps of user decision 46 A (2026-11-13: after 0.1.0, M7, then M3, then M5; each a spec first, then the user's decision rows, then contract tests). It answers finding M7 of the review of 2026-11-10 (`docs/reviews/2026-11-review.md`, M7 and §3f): readers get no event when cached data changes.

Documentation only: no code, no tests, nothing under `packages/` changes.

| Commit (by subject)                                           | What                                                                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs: propose the change-notification design for finding m7` | `docs/design/m7-change-events.md`; a paragraph in the roadmap's subscriptions sketch linking to it; a `docs/design/` row in `docs/INDEX.md` |
| `docs(review): step 92 scope and verification`                | This file; the `docs/INDEX.md` sizes                                                                                                        |

**Where the design lives.** A proposal file, `docs/design/m7-change-events.md`, rather than a section of `docs/architecture.md`. The architecture document records approved contracts; this design has thirteen open decision rows, several of which would rewrite whole paragraphs. Once the user decides them, the contract-test step moves the approved text into architecture §2.7, §2.8, §3.1–§3.2 and §4.6–§4.8 and adds the decision files, as the persistence sketch became §4.10. The proposal file's first section says the same.

**What it covers,** as the brief asked: the event's shape and payload (notify-only, `written` and `removed` ranges, `cleared`, `requestId`); what counts as a change, per operation, including a version clear, `hydrate`, a persistence load, eviction later, and the calls that change nothing; delivery per mutating call, the order of events for one call and across calls, and the SharedWorker, dedicated and in-process hostings; the interactions with `cacheOnly`, orchestrated fetches, `mergeWarning`, `cacheCleared`, auth pending and persistence; zero cost without a subscriber and the cost per change with one; the public API (`client.on`, `cache.on`, the unsubscribe, `client.features`) and what the integrations do; an additive protocol change with `hello.features` and a compatibility rule offered to M5; and 23 contract and browser tests for the later step.

**Two findings the spec makes about the roadmap sketch.** (1) Re-reading with a fetching `get` on every event loops wherever a cache has a volatile region: the forming bar is never covered, so each fetching read fetches it, each fetch writes it, and each write notifies (§3.5 of the proposal). The proposal's rule is a `cacheOnly` re-read after a write and a fetching one only after coverage was withdrawn. (2) Per-macrotask coalescing in a worker rarely merges anything, since each message and each fetch completion runs in its own task; the proposal coalesces per mutating call, without a timer, and leaves per-frame coalescing to the integrations (D3).

**The persistence hook is not reusable as is.** `CacheState`'s `onChange` (`engine/cache.ts:113-146`) clips writes below the volatile region (`:321-329`), so a live tail reports nothing; reports a watermark withdrawal over `MAX_SAFE_INTEGER` slots (`:556-567`); and reports invalidations over slots never covered (`:457-464`). The proposal adds a reader-facing report beside it and leaves persistence's semantics unchanged (D6, D12).

**Claims checked against the code.** Every statement about the current engine in the proposal's §2 table and §3 cites a file and line on `main` at `98b7bbf`; each was read, not inferred. One claim was corrected while checking: an error thrown by a listener of a wire event is rethrown from the port's message handler (`engine/emitter.ts:31-43`, `client/client.ts:163-166`), not passed to `reportError`, which the client uses for `modeFallback` and `workerLost` only.

## Decisions for the user

All thirteen rows, D1–D13, are open and listed with options, pros, cons and a recommendation in §4 of the proposal. None is decided here; the proposal's §3 assumes each recommendation. Two rows touch the wording of locked decisions and need the user's explicit approval if taken as recommended:

- **D7** (`hydrate` sends `cacheChanged` for what it applied) amends the "No events" bullet of architecture §2.8 (N35, N36) for this one event.
- **D9** follows N37 (additive change, `PROTOCOL_VERSION` stays 1); its option (c), a protocol bump, would lean on N25 and reject `createClient` across a deploy skew.

## Verification

| Check                                                                                          | Result                                                                                                                                            |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run build`, then `bun run docs:check`                                                     | exit 0; `doc-anchors: 246 anchors in 42 pages resolve` (without the build, the site's snippets cannot resolve `@anishbenji/tscache` and it fails) |
| `~/code/tscache-reports/bin/heavy-run.sh "92 child: ci" bun run ci` on the step's first commit | see below                                                                                                                                         |
| Line references in the proposal                                                                | each read at the cited lines with `sed -n` or `grep -n` on `98b7bbf`                                                                              |
| `docs/INDEX.md` sizes                                                                          | re-measured with `wc -c` after the last edit (1 KB = 1,000 bytes)                                                                                 |

Not verified: nothing is built, so no behaviour in the proposal is tested; the cost estimates in its §3.6 are reasoned from the code, not measured.

## Contract-test changes

None.

## Decision concerns

None yet; the review has not run.
