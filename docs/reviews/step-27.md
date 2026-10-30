# Chore 27 — Narrow the project's permission ask rules

Branch: `chore/27-narrow-ask-rules` · Reviewer: Codex (high) · Rounds: in progress · Status: under review

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
