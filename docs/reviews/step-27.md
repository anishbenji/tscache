# Chore 27 — Narrow the project's permission ask rules

Branch: `chore/27-narrow-ask-rules` · Reviewer: Codex (high) · Rounds: in progress · Status: under review

Requested by the user on 2026-10-30: the thread should run unattended while the user is away, and approval prompts kept stopping it. In Claude Code an `ask` rule prompts even in full-access mode, so routine commands on step branches (`git rebase main`, `git merge`, `git push` of a feature branch, `bun install --frozen-lockfile` in a fresh worktree) raised prompts.

## Scope

| Commit | What |
|---|---|
| (this branch) | `.claude/settings.json`: drop the ask rules for `git merge`, `git rebase` and `bun install`; narrow `git push*` to pushes that target `main` or use `--mirror` or `--delete`. Kept: `bun add`, `bun remove`, `bun update`, `git reset`, `git restore`, `git checkout`, `git clean`, `git branch -D`, `rm -rf`, and the `bun test` and dotenv denies |

## What still guards the dropped rules

- Pushes to `main`: branch protection on GitHub (pull request and CI required, no force-push) and the remaining ask rules.
- Force-pushes: denied in the user-level settings.
- Dependency changes: AGENTS.md requires asking first; `bun add`, `bun remove` and `bun update` still prompt. `bun install <package>` no longer prompts; Knip and Fallow fail on an unused dependency, and review checks `package.json` changes.
