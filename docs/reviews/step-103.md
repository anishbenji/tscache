# Step 103 — `docs/INDEX.md` stops counting the review files

Branch: `docs/103-index-reviews-row` · Reviewer: GPT-6.1 Sol (<effort>) · Rounds: 0 · Status: awaiting review

## Scope

User decision 70, option A (2026-11-15). Since step 72 every step has added `docs/reviews/step-NN.md` and updated the `docs/reviews/` row's file count and size, and the index's own size, in `docs/INDEX.md`. Every merge to `main` therefore put every open branch in conflict on those two rows. This step drops the count and size from those two rows only:

- The `docs/reviews/` row says "One file per step, growing; never read them all" in place of the count, and its size cell is a dash.
- The `docs/INDEX.md` row's size cell is a dash.
- The sentence under the heading, which states how sizes are measured, now says that these two rows carry no size or count and why.

Every other row keeps its size, measured as before; they change rarely.

No document tells authors to re-measure the two rows: `docs/workflow.md`, `docs/reviews/README.md`, `AGENTS.md`, `CLAUDE.md` and `scripts/` were searched (`grep -rn 'INDEX\|files; never\|wc -c'`), and the convention was never written down. Nothing else needed to change. Earlier review files that mention re-measuring the row (for example `step-99.md`) are left as written.

| Commit (by subject)                                        | What                       |
| ---------------------------------------------------------- | -------------------------- |
| `docs(index): stop counting and sizing the reviews row`    | The `docs/INDEX.md` change |
| `docs(review): step 103, the index stops counting reviews` | This file                  |

## Contract-test changes

None.

## Decision concerns

None.
