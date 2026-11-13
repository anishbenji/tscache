# Step 81 — The checklist's roadmap list and the bench comment

Branch: `chore/81-checklist-roadmap` · Reviewer: GPT-6.1 Sol · Rounds: — · Status: — · Verdict after triage: —

## Scope

User decision 45 A (2026-11-13; `docs/reviews/2026-11-review-update.md`, row 45) corrects two stale statements. Both files are protected paths, so the user merges this pull request. No library code changes.

| Commit (by subject)                                            | What                                                                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs(checklist): drop persistence from the roadmap-leak list` | `docs/review-checklist.md` §1: IndexedDB persistence removed from the roadmap-leak list, four missing roadmap items added, citation corrected.                              |
| `ci: say that the bench check is required`                     | The comment above the `bench` job in `.github/workflows/ci.yml`, three sentences of `docs/benchmarking.md` that said the same, and the two files' sizes in `docs/INDEX.md`. |
| `docs(review): step 81 scope and verification`                 | This file, and the review-file count in `docs/INDEX.md`.                                                                                                                    |

### The roadmap-leak list

Every item of the list was checked against `docs/roadmap.md`, the starter prompt (`docs/history/starter-prompt.md`) and the decision files on 2026-11-13.

| Item                                | Kept, removed or added | Justification                                                                                                                                                                                                                      |
| ----------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TTL                                 | kept                   | Rejected in core, a consumer-side pattern: starter §3.3 ("TTL rejected in core"), architecture §2.4 ("TTL is deliberately not in core"). It is not on the roadmap, but a leak is still out of scope; the citation now names S§3.3. |
| Aggregation/resampling              | kept                   | `docs/roadmap.md`, Deferred features: "Aggregation and resampling across intervals".                                                                                                                                               |
| SharedArrayBuffer                   | kept                   | `docs/roadmap.md`, Deferred features: "SharedArrayBuffer as an opt-in".                                                                                                                                                            |
| `ColumnarSegment`                   | kept, widened          | `docs/roadmap.md`, Deferred features: "`ColumnarSegment` for sparse data …, and a third segment layout for irregular timestamps". The list now names the second half too.                                                          |
| IndexedDB persistence               | removed                | Specified in architecture §4.10 (decisions N45–N61, N66) and shipped (pull requests #78, #82, #86); `docs/roadmap.md`, Design sketch: IndexedDB persistence: "It shipped as slice (a) … then slice (c)".                           |
| LRU/eviction                        | kept                   | `docs/roadmap.md`, Design sketch: eviction and memory limits; architecture §1 lists eviction as out of scope for v1.                                                                                                               |
| `i64`/`u64`/`f16`                   | kept                   | Decision N7 (`docs/decisions/N7-dtype-set.md`): "Excluded: `i64/u64` … roadmap if demanded, `f16`".                                                                                                                                |
| `worker_threads` hosting            | kept                   | `docs/roadmap.md`, Deferred features: "Node `worker_threads` hosting".                                                                                                                                                             |
| Subscriptions (dirty notifications) | added                  | `docs/roadmap.md`, Design sketch: subscriptions (dirty notifications), under "Work deliberately left out of v1"; starter §10; architecture §1. Not in the source today (no `cacheChanged`).                                        |
| Per-field presence masks            | added                  | `docs/roadmap.md`, Deferred features: "Per-field presence masks"; starter §10; architecture §1.                                                                                                                                    |
| Elected auth handler                | added                  | `docs/roadmap.md`, Deferred features: "An elected auth handler, design (c) in architecture §6.2"; starter §10; architecture §1.                                                                                                    |

The citation was `(S§10, A§8 N7)`. It is now `(S§3.3, S§10, A§1, A§8 N7; docs/roadmap.md)`: S§3.3 for TTL, S§10 and A§1 for the deferred features, N7 for the dtypes, and the roadmap file for the current list. The line also says why persistence left the list, so a reader of an older review sees the change.

### The bench comment

`.github/workflows/ci.yml` said above the `bench` job "The check is not required in branch protection yet: the user decides." The `main` ruleset `protect-main` has required `ci` and `bench` since 2026-11-09 (`docs/supply-chain.md`, checklist item "The `ci` and `bench` status checks are both required"). The comment now says so; nothing else in the workflow changed.

A search of the repository outside `docs/reviews/` and `docs/history/` (`git grep -niE "branch protection|not (yet )?required|required (status )?check"`, then every `required` in `docs/benchmarking.md`, `docs/workflow.md`, `docs/supply-chain.md`, `CONTRIBUTING.md` and `README.md`) found three more stale sentences, all in `docs/benchmarking.md`, which this step corrects:

- "The gate" bullet: "The `bench` check is not yet required in branch protection."
- The calibration section: "Making the `bench` check required is one line in branch protection, and the user's decision."
- Next, item 1: "… and whether the `bench` check becomes required."

`docs/workflow.md`, `docs/supply-chain.md`, `CONTRIBUTING.md` and `AGENTS.md` already state both required checks. Older step files (`step-43.md`, `step-45.md`, `step-72.md`) and the 2026-11 review files record the old state as history and are left unchanged.

## Verification

- `git grep -niE "not (yet )?required|becomes required|required is one line"` outside `docs/reviews/` and `docs/history/`, after the edits: no match.
- The gate: `~/code/tscache-reports/bin/heavy-run.sh "81 child: ci" bun run ci` on the final head; the result is in the child's report to the director.

Not verified: the ruleset itself (`gh api repos/anishbenji/tscache/rules/branches/main`) was not queried in this step; the claim rests on `docs/supply-chain.md` and the 2026-11 review update.

## Decisions

- **TTL stays on the list.** It is not a roadmap item but a rejected one (starter §3.3). A TTL in a diff is still out-of-scope behaviour, which the severity table makes a P0, so removing it would weaken the check.
- **Persistence in the dedicated-worker and in-process hostings is not added.** `docs/roadmap.md` says those hostings "do not persist until combining several engines' records is designed (§4.10.10)", and architecture §4.10 records the design as retired on 2026-10-31. That is a constraint of locked decision N52, which the checklist's first item already covers, rather than plainly stated future work.
- **The deferred decision N28 (heartbeat) is not added.** It is a deferred decision, not a feature, and adding it before real tab churn shows the need is what N28 itself defers.

## Contradictions found

- `docs/benchmarking.md` contradicted `docs/supply-chain.md` and `docs/workflow.md` on whether `bench` is required; fixed here.
