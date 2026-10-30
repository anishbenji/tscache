# Chore 27 — Narrow the project's permission ask rules

Branch: `chore/27-narrow-ask-rules` · Reviewer: Codex (high) · Rounds: 2 + confirmation · Status: user decided (Option A, 2026-10-30)

Requested by the user on 2026-10-30: the thread should run unattended while the user is away, and approval prompts kept stopping it. In Claude Code an `ask` rule prompts even in full-access mode, so routine commands on step branches (`git rebase main`, `git merge`, `git push` of a feature branch, `bun install --frozen-lockfile` in a fresh worktree) raised prompts.

## Scope

| Commit | What |
|---|---|
| 83f9f6f, then the follow-up commit | `.claude/settings.json`: drop the ask rules for `git merge`, `git rebase` and `bun install`; narrow `git push*` to pushes that can reach `main` or destroy remote state: any argument containing `main` (round 1 replaced the per-form rules with `git push *main*`), a forced (`+`) refspec, `-d` or `--delete`, `--mirror`, `--all`, `--prune`, and a bare `git push`. Kept: `bun add`, `bun remove`, `bun update`, `git reset`, `git restore`, `git checkout`, `git clean`, `git branch -D`, `rm -rf`, and the `bun test` and dotenv denies |

## What still guards the dropped rules

- Pushes to `main`: branch protection on GitHub (pull request and CI required, no force-push) and the remaining ask rules.
- Force-pushes: denied in the user-level settings.
- Dependency changes: AGENTS.md requires asking first; `bun add`, `bun remove` and `bun update` still prompt. `bun install <package>` no longer prompts; Knip and Fallow fail on an unused dependency, and review checks `package.json` changes.

## Security review note

An automated security review of 83f9f6f flagged that the narrowed push patterns missed forms such as `+refspec`, `-d` and `refs/heads/main`. The follow-up commit adds them. Pattern rules stay a convenience layer: GitHub's branch protection on `main` is the enforcing control, and the hook guard (`guard-bash.ts`) is frozen, so it was not extended.

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | `Bash(git push * :*)` does not catch a deleting refspec such as `git push origin :feature` | Accept, with a different cause. The permissions documentation (code.claude.com/docs/en/permissions, "Wildcard patterns") reads a trailing `:*` as the legacy spelling of a trailing ` *` wildcard; the colon is not literal. So the rule never matched a leading `:`, and `Bash(git push * main:*)` had the same defect. No rule ending in `:*` can match a literal colon, and the documentation recommends a hook for argument-level checks; the Bash guard is frozen (CLAUDE.md), so no hook was added | Removed `git push * :*`. Deleting a branch other than `main` with the `:branch` form no longer prompts; `-d` and `--delete` still do. Deleting `main` prompts through `*main*`, and GitHub's branch protection blocks it. A deleted feature branch is restorable from the local branch |
| R1-2 | P1 | `git push origin feature:main` and `feature:refs/heads/main` match no ask rule | Accept. Valid: the rules listed fixed sources only | The four main-targeting rules became one, `Bash(git push *main*)`, which matches `main` anywhere in the arguments: a destination, `src:main`, `refs/heads/main`, `+main`, `:main`. A branch whose name contains `main` (for example `maintenance`) also prompts, which errs towards asking. No regression test: the matcher lives inside Claude Code and the repository has no way to run it; the cases were checked against the documented rules |

The user-level `~/.claude/settings.json` carries `Bash(git push * main:*)` with the same trailing-`:*` defect. It is outside the repository and the user's own file, so it is left for the user (noted in the director's pending decisions).

## Round 2 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P1 | Re-raises R1-1: `git push origin :feature` matches no ask rule; a deleted branch is not recoverable if its commits were never fetched locally | Escalated | See below |
| R2-2 | P1 | `git push origin` (and `git push origin HEAD`) with `main` checked out pushes to `main` implicitly and matches neither `*main*` nor the exact `git push` rule | Accept as valid; escalated | GitHub's branch protection rejects a direct push to `main`, so the gap loses the prompt, not the protection. See below |

**Convergence check (docs/workflow.md, review loop step 7):** the push ask patterns drew findings in rounds 1 and 2. Permission patterns match command text, cannot express "a refspec with an empty source" (a trailing `:*` is a wildcard) or "the current branch's upstream is main", and the documentation recommends a hook for argument-level checks. Further pattern patches would not converge, so the area is escalated to the user instead of patched again. Options put to the user: accept the documented residual gaps and merge; add a small PreToolUse hook that parses `git push` arguments (new tooling; the frozen Bash guard stays untouched); or keep asking on every push. Recorded by the director while the user was away; the branch is parked unmerged until the user decides.

## User decision (2026-10-30): Option A

The user chose Option A for the escalated push rules: accept the documented gaps, add fixed-form rules, merge. This is the user's decision, not one taken under the away grant.

- Added ask rules: `Bash(git push origin)`, `Bash(git push -u origin)` and `Bash(git push * HEAD)`. A push that names no refspec, or pushes `HEAD`, now prompts, which covers the usual implicit pushes to the current branch's upstream (R2-2).
- **Residual gaps, accepted:**
  - A colon-delete of a branch other than `main` (`git push origin :feature`) does not prompt. No permission pattern can match a leading colon, since a trailing `:*` is a wildcard. `-d` and `--delete` still prompt (R1-1, R2-1).
  - An implicit push to `main` in a form outside the fixed rules, for example `git push origin some-local-branch` whose upstream is `main`, does not prompt. GitHub's branch protection rejects any direct push to `main`, since a pull request and the `ci` check are required.
- One confirmation round follows. Per the user's instruction, findings that fall inside the accepted gaps are settled by this decision and do not reopen the loop.
