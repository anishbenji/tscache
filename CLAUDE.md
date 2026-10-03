@AGENTS.md

## Claude-specific notes

- `.claude/hooks/guard-bash.sh` blocks literal `bun test` and git-hook bypasses (threat model in `guard-bash.ts`). If it blocks a command, use the correct command; do not work around it. Its gaps are not permission: the rules bind regardless, and `bun run ci` re-checks every commit on the branch. The guard is frozen; change it only for an accident actually observed.
- **Reviews are automated:** run the review loop in `docs/workflow.md` with `scripts/codex-review.sh NN` (run it in the background; a round takes several minutes). Validate every finding before fixing it, re-review while rounds raise P0/P1, redesign or escalate when an area draws findings two rounds running, and stop when settled or after four rounds. Escalate any "Decision concerns" to the user instead of acting on them.
- **Claude Code CLI only:** the Codex plugin is also enabled (`/codex:review`, `/codex:adversarial-review`, `/codex:status`, `/codex:result`) for one-off reviews. Never enable the review gate (`/codex:setup --enable-review-gate`) — it loops and drains usage.
