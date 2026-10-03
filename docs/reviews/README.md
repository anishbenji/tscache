# Step Reviews

One file per commit-plan step, `step-NN.md`, written by the implementer after each Codex review and committed on the step branch as `docs(review): step NN triage`. It is the audit trail the user reads before merging.

## Template

```markdown
# Step NN — <name>

Branch: `feat/NN-slug` · Reviewer: GPT-6.1 Sol (<effort>) · Rounds: <n> · Verdict after triage: <merge | blocked>

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| 1 | P1 | <title> | accepted | fixed in <sha> |
| 2 | P2 | <title> | rejected | <one sentence, citing the doc section> |

## Contract-test changes

None. — or — each Codex-authored test that was changed, and why.

## Decision concerns

None. — or — concerns raised by the reviewer, escalated to the user, and the user's answer.
```
