# Step 104 — room in the index (lazy) size budget

Branch: `chore/104-lazy-budget` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: awaiting review

## Scope

The `index (lazy)` row of `bun scripts/size.ts` measured within about 12 B of its 12,464 B budget, so a change that only edits comments (step 96) failed the size check: built chunks keep their comments, and their hashed file names change the import strings that name them. User decision 64 A (2026-11-15) raises the budget now and queues a measurement that is stable against that noise for later.

This step changes one value in `packages/tscache/bench/budgets.json`: `index:lazy` goes from 12,464 B to 12,976 B, the size of the current build plus 512 B as `bun scripts/size.ts --update` derives it (`budgetFor` in `scripts/size-budget.ts`). The update run would also have rewritten the other seven budgets from this build; they are left unchanged, because the decision covers only this row and `docs/benchmarking.md` asks that each budget change be deliberate and reasoned in its own pull request. The reason is in the commit message, as `docs/benchmarking.md` requires. No source, test or other budget changes.

## Verification

- `bun scripts/size.ts` passes; `index (lazy)` measures 12.16 kB brotli against a 12.67 kB budget.
- `bun run ci` exits 0 on the branch head.

## Contract-test changes

None.

## Decision concerns

None.
