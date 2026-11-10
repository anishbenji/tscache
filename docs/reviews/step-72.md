# Step 72 — agent rules and document index

Branch: `chore/72-agent-rules-index` · Reviewer: not yet reviewed · Rounds: 0 · Status: built

## Scope

Documentation and agent rules only, from Part 6 (§6.2–§6.4) of the 2026-11-10 project review and the director's brief for this step. No code, test, script, workflow, hook or setting changed.

- `docs/INDEX.md` (new): one table of every document with when to read it, its size and its owner, and how to read single decision rows of `docs/architecture.md`.
- `AGENTS.md`: reading instruction, rules that bind every agent, merge rule, required checks, roles, decisions pointer. Size 6,489 bytes before, 6,828 after (`wc -c`).
- `CLAUDE.md`: the review-loop line.
- `docs/workflow.md`: stale statements and the agent-files table.
- `CODE_OF_CONDUCT.md`: contact route.
- `docs/releasing.md`: link to the supply-chain checklist.

## Rules added

| Rule                                                                                                                                                                                         | Where                                                                      | Source                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Read `docs/INDEX.md`, then only the architecture sections and decision rows the task touches (replaces reading the starter prompt and the whole architecture document, about 110,000 tokens) | `AGENTS.md` intro                                                          | Review §6.2; director's brief                                                                            |
| One heavy job at a time on this machine (`bun run ci`, Playwright, a bench or stress run, a Codex review), through `~/code/tscache-reports/bin/heavy-run.sh` when it exists                  | `AGENTS.md`, Toolchain hard rules                                          | Review §6.3 row 1                                                                                        |
| Commit subjects start lowercase; body lines are at most 100 characters                                                                                                                       | `AGENTS.md`, Commits                                                       | Review §6.3 row 2; `@commitlint/config-conventional` (`subject-case`, `body-max-line-length` 100)        |
| Hooks need the current nvm Node first on `PATH`, with the command                                                                                                                            | `AGENTS.md`, git hooks                                                     | Review §6.3 row 3                                                                                        |
| The commit plan ①–⑭ is complete; later work is numbered after the highest existing step, never reusing a number, one branch per step `feat\|fix\|chore\|docs\|ci/NN-slug`                    | `AGENTS.md`, Steps; `docs/workflow.md` intro                               | Review §6.3 row 4                                                                                        |
| No npm token, no `v*` tag, no publish; CI may only `npm stage publish`; the user approves each staged version                                                                                | `AGENTS.md`, Releases                                                      | Review §6.3 row 5; user decision of 2026-11-09 (director's brief, Release rules)                         |
| Who merges: the user; a director may set auto-merge only as its brief and path checks allow, never on a protected path                                                                       | `AGENTS.md`, Merging; `docs/workflow.md`, GitHub                           | Review §6.3 row 6; user decision 23 (2026-11-10)                                                         |
| Both required checks, `ci` and `bench`, must pass                                                                                                                                            | `AGENTS.md`, Merging; `docs/workflow.md`, GitHub                           | Review §6.4; confirmed with `gh api repos/anishbenji/tscache/rules/branches/main` (prints `ci`, `bench`) |
| Review rounds go through the director's budgeted round script when a director runs the project, `scripts/codex-review.sh` otherwise                                                          | `AGENTS.md`, Review rounds; `CLAUDE.md`; `docs/workflow.md` intro          | Review §6.3 row 7                                                                                        |
| Codex writes failing contract tests for every engine-logic change (`coverage`, `segment/`, `engine/`, `orchestrator/` and persistence logic), in any step                                    | `AGENTS.md`, TDD and Roles; `docs/workflow.md`, per-step loop and prompt A | Review §6.3 row 9                                                                                        |
| A new document gets a row in `docs/INDEX.md`                                                                                                                                                 | `AGENTS.md`, Docs                                                          | Director's brief (keeps the index complete)                                                              |
| Director role: plans the queue, delegates steps to children in worktrees, starts rounds, opens pull requests; never builds a step itself                                                     | `AGENTS.md`, Roles                                                         | Review §6.3 row 7 and §6.5 (director's brief: children do the building)                                  |

## Sentences removed or replaced

| File                 | Removed                                                                                                                               | Why                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`          | "Read `starter-prompt.md` (normative design register) and `docs/architecture.md` (approved API surface, signed off) before any work." | About 110,000 tokens before any work; contradicted `child-rules.md` rule 1 (review §6.2). The lock on starter §3 and architecture §7–§8 is kept                  |
| `AGENTS.md`          | "Commit plan: starter §11, steps ①–⑭. One branch per step (`feat/NN-slug`, or `chore/NN-slug` for tooling)"                           | The plan is complete and numbers 17–23 were each used twice (review §6.3 row 4); replaced by the numbering rule                                                  |
| `AGENTS.md`          | "When the review settles, Claude pushes the branch …; the user merges it" and "the CI check must pass"                                | Replaced by the single merge rule and the two required checks                                                                                                    |
| `AGENTS.md`          | Roles: "merges it on GitHub once CI is green"; reviewer "via `scripts/codex-review.sh`"; contract tests "for engine-logic steps"      | Contradicted the merge rule, the review-round rule and the contract-test rule                                                                                    |
| `AGENTS.md`          | "strict test-first for engine logic (`coverage`, `segment/`, `engine/` — steps ③–⑧). For those steps …"                               | Left persistence and orchestration logic outside the rule (review §6.3 row 9)                                                                                    |
| `AGENTS.md`          | The "Resolved decisions (user-confirmed 2026-06-11)" paragraph                                                                        | Every item is recorded in architecture §7 (rows 1–8) and §8 (N1–N8, N67, which also keeps the IndexedDB name, log prefix and auth marker); replaced by a pointer |
| `AGENTS.md`          | "GitHub Actions runs the same `bun run ci` …" shortened to "runs `bun run ci` …"                                                      | Size only; meaning unchanged                                                                                                                                     |
| `CLAUDE.md`          | "run the review loop … with `scripts/codex-review.sh NN`" as the only route                                                           | Bypassed the director's budget gate (review §6.3 row 7)                                                                                                          |
| `docs/workflow.md`   | "one Claude thread per step, plus a Codex thread for contract tests"; "the Claude thread runs Codex headless"                         | A director with children in worktrees runs the project (review §6.4)                                                                                             |
| `docs/workflow.md`   | "How each step of the commit plan (starter §11) is built"                                                                             | The plan is complete; pointer to the numbering rule added                                                                                                        |
| `docs/workflow.md`   | "`main` accepts changes only through a pull request whose `ci` check passed"; "wait for the CI check"                                 | Two required checks                                                                                                                                              |
| `docs/workflow.md`   | Per-step loop column "Engine steps ③–⑧"; prompt A "engine steps only"                                                                 | Contract tests cover every engine-logic change                                                                                                                   |
| `docs/workflow.md`   | "Consider Fable 5.1 for steps ⑨–⑪ …"                                                                                                  | Names a retired model and finished steps (review §6.3 row 10); replaced by a pointer to the director's model routing                                             |
| `docs/workflow.md`   | "the no-SharedWorker (Chrome Android) path"                                                                                           | Chrome for Android has SharedWorker from 148 (N52); now "Samsung Internet, Opera Mobile, and Chrome for Android before 148", as `site/guides/workers.md` says    |
| `CODE_OF_CONDUCT.md` | "contact the maintainer through their GitHub profile, <https://github.com/anishbenji>"                                                | User decision 28, option A (2026-11-10): private vulnerability reporting only                                                                                    |

## Decisions taken

- Sizes in `docs/INDEX.md` are kilobytes of 1,000 bytes from `wc -c`; `docs/reviews/` and `site/` are one row each with totals (for `site/`, its Markdown pages, excluding `node_modules`).
- `docs/benchmarks/` is named in the brief but does not exist; it has no row. Benchmark documentation is `docs/benchmarking.md`.
- `SUPPORT.md` and `CHANGELOG.md` were not in the brief's list and have no row; `CODE_OF_CONDUCT.md` has one because this step edits it.
- Commit body lines: the rule says "at most 100 characters", which is what commitlint enforces; the brief said "under 100".
- Review §6.3 row 5 also lists "repository settings change only in steps 65 and 66". The brief's item 5 leaves it out, so `AGENTS.md` does not carry it; it stays in the director's brief.
- The Roles table gains a Director row so the merge and review-round rules have a role to point at; its cells were shortened to keep `AGENTS.md` under 7 KB once Biome pads the table.
- The model-choice line keeps Opus 5.5 as the default, which is current; it no longer names a retired model.

## Not verified

- No Codex review has run on this branch (the brief forbids it).
- `.github/workflows/ci.yml` still says, above the `bench` job, "The check is not required in branch protection yet"; the ruleset requires it. That file is a protected path and was not edited.
- `starter-prompt.md` keeps the stale statements of review §6.4; `docs/INDEX.md` marks those sections as historical instead of editing the file.
