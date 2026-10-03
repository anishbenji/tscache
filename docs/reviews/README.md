# Step Reviews

One file per commit-plan step, `step-NN.md`, written by the implementer during the review loop (`docs/workflow.md`) and committed on the step branch after each round as `docs(review): step NN round K triage`. It is the audit trail the user reads before merging, and the reviewer reads it in later rounds to check fixes and contest rejections.

Add one table per round; keep earlier rounds unchanged. Number findings across rounds (`R2-1`, `R2-2`, …) so a re-raised finding can point at its original. A rejection states how the finding was validated and cites the doc section that decides it. Raw reviewer output stays in `.reviews/step-NN/` (gitignored).

## Template

```markdown
# Step NN — <name>

Branch: `feat/NN-slug` · Reviewer: GPT-6.1 Sol (<effort>) · Rounds: <n> · Status: <settled | escalated> · Verdict after triage: <merge | blocked>

## Round 1 — reviewer verdict: <block | merge after fixes | merge>

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | <title> | accepted | fixed in <sha> |
| R1-2 | P2 | <title> | rejected | <how validated; one sentence citing the doc section> |

## Round 2 — reviewer verdict: <…>

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P2 | <title> (re-raises R1-2) | rejected | <answer to the reviewer's reason> |

## Contract-test changes

None. — or — each Codex-authored test that was changed, and why.

## Decision concerns

None. — or — concerns raised by the reviewer, escalated to the user, and the user's answer.
```
