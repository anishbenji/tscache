@AGENTS.md

## Claude-specific notes

- `.claude/hooks/guard-bash.sh` blocks `bun test` and git-hook bypasses. If it blocks a command, use the correct command; do not work around it.
- **Claude Code CLI only:** the Codex plugin is enabled for this repo. Use `/codex:review --base main --background`, `/codex:adversarial-review --base main --background <focus>`, then `/codex:status` and `/codex:result`. Never enable the review gate (`/codex:setup --enable-review-gate`) — it loops and drains usage. In T3 Code the plugin is not used; the reviewer is a separate Codex thread (see `docs/workflow.md`).
- When triaging a Codex review, follow `docs/reviews/README.md` and escalate any "Decision concerns" to the user instead of acting on them.
