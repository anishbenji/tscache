# Step 96 — merge.ts comments in N70's terms

Branch: `docs/96-merge-comments-n70` · Reviewer: GPT-6.1 Sol · Rounds: 0 · Status: awaiting review · Verdict after triage: pending

## Scope

Step 80 (N70) defined a write run: a maximal stretch of consecutive batch points, each on the same page as the one before it with at most K slots between them, counted on the batch alone. Three comments in `packages/tscache/src/engine/merge.ts` still used the older wording that N70 rejects, recorded in `docs/reviews/step-80.md` (Contradictions found, item 2, and pre-review finding 3). This step rewords them. It changes comments only: no code, test or behaviour.

Commits, by subject:

- `docs(merge): describe write runs in n70's terms`. Three comments in `merge.ts`:
  - `#insertChunks` said "a chunk is a run that shares a segment". It now says the batch is written one write run at a time in ascending slot order, defines the write run as N70 does, and says stored points never decide where a run ends.
  - `#together` said two batch points "certainly share a segment" and that stored points "can only narrow the gap". It now says the two points belong to the same write run and that stored points between them are not counted.
  - `#insert` said every stored segment within K slots of the chunk "belongs to the same run". It now says such segments are merged with the run into one segment but never decide where the run ends.
- `docs(review): step 96 scope and verification`. This file, and the review-file count and size in `docs/INDEX.md`.

The variable and parameter name `chunk` is unchanged, since this step changes no code; the `#insert` comment says that `chunk` is the write run.

## Verification

**The comments against the code.** `#together(a, b)` is `b - a - 1 <= K && page(a) === page(b)` on two consecutive batch slots, with no store lookup; `#insertChunks` walks the batch from index 0 upward and calls `#insert` each time `#together` is false, so each call receives one write run, in ascending order. `#insert` widens its search by K slots on each side, clipped to the page, and merges every stored segment it finds with the run; it does not change where the run was cut. The reworded comments say exactly this.

**Other comments.** `grep -rn "shares a segment\|same run\|share a segment" packages/tscache/src` before the change matched the three comments above and the file comment at `merge.ts:8`, which states the stored layout (N14, N15: two present points share a segment exactly when they are on the same page with at most K empty slots between them). That is the layout after a put, not the definition of a write run, so it stays. `engine/cache.ts:536` ("a run that reaches the split from both sides is one run of consecutive differing points") is about the overlap warning's run of differing points (§4.3), not the write run, so it stays. `segment/dense.ts:2` ("a run of consecutive slots") describes a segment's layout and stays.

| Command                                                             | Result                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `bunx tsc --noEmit -p packages/tscache`                             | exit 0                                                                                |
| `~/code/tscache-reports/bin/heavy-run.sh "96 child: ci" bun run ci` | exit 1 on `5b0ceab` (size budget, see below); rerun on the final head after the merge |

## Blocked, then cleared

The first `bun run ci` on `5b0ceab` failed one check: the size budget for `index (lazy)`, whose brotli size exceeded its budget of 12,464 B by at most 16 bytes. The comment changes did not change the code. They changed the content hashes in the names of the built chunks (`dist/` keeps comments), and the minified bundle carries those names in its `import()` paths, so the compressed size moved by a few bytes. `main` at `98b7bbf` measured within 16 bytes of the same budget. A comparison of the two builds found no other difference in `dist/` than the comments and the chunk names. The step did not raise the budget, since a child may not widen a bound, and did not reword the comments to get a smaller hash.

User decision 64 A raised the `index (lazy)` budget to 12,976 B (step 104, merged to `main` as `7c2e35d`). This branch merged `origin/main` afterwards. The conflicts in `docs/INDEX.md` were in the `docs/reviews/` row and the index's own row, which since step 103 (decision 70 A) carry no count or size; `main`'s text was taken for both. No other row of the index covers a file this step changes. On the merge commit, `bun run build` then `bun scripts/size.ts` passes: `index (lazy)` is 12.16 kB brotli against a budget of 12.67 kB.

## Contract-test changes

None.

## Decision concerns

None.
