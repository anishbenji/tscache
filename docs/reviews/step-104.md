# Step 104 — room in the index (lazy) size budget

Branch: `chore/104-lazy-budget` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: awaiting review

## Scope

The `index (lazy)` row of `bun scripts/size.ts` measured within about 12 B of its 12,464 B budget, so a change that only edits comments (step 96) failed the size check: built chunks keep their comments, and their hashed file names change the import strings that name them. User decision 64 A (2026-11-15) raises the budget now and queues a measurement that is stable against that noise for later.

User decision 64 A (2026-11-15), as recorded in the director's resolved decisions: "raise `index:lazy` to measured + 512 B now; a measurement stable against chunk-hash and comment noise is queued as a later step".

This step changes one value in `packages/tscache/bench/budgets.json`: `index:lazy` goes from 12,464 B to 12,976 B, the size of the current build plus 512 B as `bun scripts/size.ts --update` derives it (`budgetFor` in `scripts/size-budget.ts`). The update run would also have rewritten the other seven budgets from this build; they are left unchanged, because the decision covers only this row. `docs/benchmarking.md:35` says: "A deliberate change edits the budget in the pull request that needs it, with the reason in the commit message." The reason is in the commit message. The change has its own branch rather than riding on a feature step because `AGENTS.md` (Process, Steps) puts tooling changes on their own `chore/` branch, and decision 64 A asked for a small step. No source, test or other budget changes.

Other rows with little headroom are left as they are: `worker` has about 70 B and `engine` measures 9.86 of 10.03 kB. A later change that exceeds one raises that budget in the pull request that needs it (`docs/benchmarking.md:35`).

The step also updates the L7 row of `docs/reviews/2026-11-review-update.md` to cite this step and decision 64 A; `worker (lazy)` remains open there.

## Verification

- `bun scripts/size.ts` passes; `index (lazy)` measures 12.16 kB brotli against a 12.67 kB budget.
- `bun run ci` exits 0 on the branch head.

## Pre-review (Fable), not the gate

Run on `4b05566`. It confirmed the budget value, its derivation and the scope, and raised three documentation findings, each validated before fixing.

| #    | Sev | Finding                                                                                                     | Decision | Resolution                                                                                                                          |
| ---- | --- | ----------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| F1-1 | P2  | `2026-11-review-update.md` still shows L7 open with no budget changed, and lists it as having no step owner | accepted | Confirmed at lines 52 and 152; L7 now cites step 104 and decision 64 A, keeps `worker (lazy)` open, and leaves the unowned list     |
| F1-2 | P2  | Scope misquoted `docs/benchmarking.md` as asking for each budget change "in its own pull request"           | accepted | Confirmed against line 35; the scope quotes it exactly and justifies the separate branch with `AGENTS.md` (Steps) and decision 64 A |
| F1-3 | nit | Decision 64 A is cited but its text is recorded nowhere in the repository                                   | accepted | Scope quotes the decision's text                                                                                                    |

## Contract-test changes

None.

## Decision concerns

None.
