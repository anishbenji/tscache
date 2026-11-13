# Step 85 — A persistence section in the review checklist

Branch: `docs/85-checklist-persistence` · Reviewer: pending · Rounds: 0 · Status: open · Verdict after triage: pending

## Scope

The review checklist lost its only persistence item when step 81 removed IndexedDB persistence from the roadmap-leak list of §1 (`61d380b`, "docs(checklist): drop persistence from the roadmap-leak list"). Step 81's security lane found that nothing then told a reviewer what to check in a persistence change. User decision of 2026-11-13, on that finding: add a persistence section covering at least records written by another version (decoding, the schema version and its migration or rejection) and two deploys writing one database (the deploy-skew limit documented in step 82).

This step adds §12, "Persistence (A§4.10, N45–N61, N66)", to `docs/review-checklist.md`, thirteen `- [ ]` items in the checklist's style, each citing its section or decision. Nothing else in the checklist changes and no item moves: the persistence-related items already present (§1's note that IndexedDB persistence is specified in A§4.10, §5's payload invariant, which names the IndexedDB value as one of its three uses) stay where they are, and §12 refers to §5 rather than repeating it. The section is appended after §11 so that §1–§11 keep their numbers, which earlier review files cite (`§10 Tests` and so on). Documentation only: nothing under `packages/` changes and no dependency is added.

`docs/review-checklist.md` is a protected path, so the user merges this pull request. `docs/INDEX.md` records the checklist's new size and the review file count.

| Commit (by subject)                                        | What                                        |
| ---------------------------------------------------------- | ------------------------------------------- |
| `docs(checklist): add a persistence section`               | §12 of the checklist, `docs/INDEX.md` rows. |
| `docs(review): step 85, the checklist persistence section` | This file.                                  |

## Verification

Every item restates rules already in the architecture or a decision; none is new. The sources, item by item (the brief's required topics marked):

| #   | Item (short)                                                                   | Brief topic                 | Source                                                                                                                                 |
| --- | ------------------------------------------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `persist` per cache, structural, inert outside the SharedWorker; never rejects | —                           | A§4.10.1 (Validation, Where it acts, Protocol); N45, N52, N59                                                                          |
| 2   | Dependency rule and the lazy chunk                                             | —                           | A§4.10 introduction (dependency rule), A§4.10.8 (Lazy loading)                                                                         |
| 3   | A version on every stored layer; migration or rejection per layer              | Version and schema          | A§4.10.2, Format and versioning table; N51, N53                                                                                        |
| 4   | Records reuse the snapshot format and hold exactly `recordsOf(S)`              | Version and schema          | A§4.10.2 (Canonical records, consequences); N53, N55; starter §3.7 via checklist §5                                                    |
| 5   | `restore` decodes records as untrusted input                                   | Decoding as untrusted input | A§4.10.5 (`restore(stored: unknown)`, steps 2 and 5, property (d))                                                                     |
| 6   | Stored version applied only on equality or adoption                            | Records of another version  | N56; A§4.10.5 step 3                                                                                                                   |
| 7   | Memory is canonical                                                            | —                           | A§4.10.5 rules 1, 2 and 4; A§4.10.6 (Flush); N57                                                                                       |
| 8   | Two engines writing one database; deploy-skew limit stays documented           | Two deploys or two hostings | A§4.10.7; N52, N55, N56; `site/guides/workers.md` (Known limit: deploy skew), `site/guides/persistence.md` (Sensitive data and logout) |
| 9   | Removals flushed at once, strict, and acknowledged only when durable           | —                           | N49, N50, N58; A§4.10.1 (When calls wait for the disk)                                                                                 |
| 10  | `clearAll` empties storage, the barrier, the clear-only call                   | Clear and logout            | A§4.10.6 (`clearAll`: a barrier), A§4.10.7 (The clear-only call); N54, N66                                                             |
| 11  | Eager load at open, `cache()` within `timeoutMs`, one deadline per job         | Load-time behaviour         | N46, N59, N61; A§4.10.6 (Open, The writer)                                                                                             |
| 12  | Quota stop, retries, cleanup; the app calls `navigator.storage.persist()`      | Quota behaviour             | N47, N48, N59; A§4.10.6 (Failures)                                                                                                     |
| 13  | Test seam and pinned properties                                                | —                           | A§4.10 introduction (strict test-first), A§4.10.3; N60                                                                                 |

Items 1, 2, 7, 9 and 13 are the must-checks of A§4.10 the checklist lacked beyond the brief's list: the scope of `persist` and its failure mode, the dependency rule and lazy loading, the two carrying rules of the section (memory is canonical; one deadline), removal durability, and the test seam that strict test-first applies to. N50's flush triggers appear only as the reason removals are not debounced (item 9); its timings are behaviour a test pins, not something a reviewer checks separately.

Checks run:

- `~/code/tscache-reports/bin/heavy-run.sh "85 child: ci" bun run ci` on the final head (result in the director's report).
- Each cited section and decision was read in this step: A§4.10 (all subsections), N45–N61 and N66, `site/guides/persistence.md` and the deploy-skew warning in `site/guides/workers.md`.

## Contract-test changes

None.

## Decision concerns

None.
