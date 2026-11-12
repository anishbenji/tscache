# tscache — Agent Working Rules

Shared rules for every coding agent on this repo: Claude (via T3 Code or Claude Code) and Codex (via T3 Code or the Codex CLI). `CLAUDE.md` imports this file; Codex reads it natively.

Read `docs/INDEX.md` first, then only the architecture sections and decisions your task touches; the index shows how to read one decision (`docs/decisions/`). Decisions in starter §3 and architecture §7–§8 are **locked — never relitigate silently**. Open or new decisions go to the user with alternatives and pros/cons; the user makes the call.

## Roles

| Role                 | Agent                 | Does                                                                                | Never                                                                    |
| -------------------- | --------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Implementer          | Claude                | Writes `src/` and non-contract tests; runs the review loop, triaging every finding  | Weakens or deletes a contract test without saying why in the review file |
| Contract-test author | Codex                 | Writes failing tests for each engine-logic change, before implementation            | Edits anything under `src/`                                              |
| Reviewer             | Codex, headless       | Reviews the branch against `docs/review-checklist.md`, a fresh session per round    | Edits, stages or commits anything                                        |
| Director             | Claude, when one runs | Plans the queue, delegates steps to children in worktrees, starts rounds, opens PRs | Builds a step itself                                                     |
| Approver             | The user              | Reads the pull request and its triage; merges it (see Merging)                      | —                                                                        |

The per-step pipeline, the review loop, copy-paste prompts and the adversarial-review schedule are in `docs/workflow.md`.

## Process

- **Steps:** the commit plan in starter §11 (①–⑭) is complete. Later work is numbered after the highest existing step number, never reusing one: one branch per step, `feat|fix|chore|docs|ci/NN-slug`, cut from `main`. Tooling and workflow changes go on their own `chore/` branch, never on a feature step's branch.
- **Merging:** when the review settles, the branch is pushed and a pull request opened. The user merges, with a merge commit. A director thread may instead set GitHub auto-merge, only as the director's brief and path checks allow (user decision 23, 2026-11-10) and never on a pull request that touches a protected path (listed in the director's `path-checks.md`, outside the repo, owned by the user). `main` is protected: no direct pushes, no force-pushes, and both required checks, `ci` and `bench`, must pass.
- **Review rounds:** when a director runs the project, start every round through its budgeted round script (`~/code/tscache-reports/bin/review-chain.sh` / `review-round.sh`); otherwise `scripts/codex-review.sh NN`.
- **TDD (hybrid, user-confirmed 2026-06-11; contract-test authorship added 2026-10-03):** strict test-first for engine logic (`grid.ts`, `coverage`, `segment/`, `engine/`, `orchestrator/`, `persist/`), in any step. Codex writes the failing contract tests from the architecture doc; Claude implements against them. Pragmatic tests-with-commit for scaffolding, RPC wiring and examples.
- **Commits:** small Conventional Commits; the subject starts lowercase and body lines are at most 100 characters (commitlint rejects both). The repo is green after every commit (`bun run ci`). Contract tests land in the same commit as the code that makes them pass. GitHub Actions runs `bun run ci` on every pull request and push to `main` (`.github/workflows/ci.yml`).
- **Never bypass git hooks** (`--no-verify`, `LEFTHOOK=0`). If a hook fails, fix the cause. On machines that use nvm, hooks need the current nvm Node first on `PATH` (else `env: node: No such file`): `d=$(ls -d ~/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1); [ -n "$d" ] && export PATH="$d:$PATH"`.
- **Releases:** an agent never creates an npm token, pushes a `v*` tag or publishes; the user does those steps. CI may only `npm stage publish`; the user approves each staged version. See `docs/releasing.md`.
- **Dependencies:** adding or upgrading one is a decision — ask first. Add a dependency in the step that first imports it (Knip and Fallow fail on unused dependencies).
- **Docs:** all repo artifacts (docs, ADRs, README, TSDoc) in normal professional prose regardless of chat output mode. Documentation debts (starter §8) ship in the step that touches their area. A new document gets a row in `docs/INDEX.md`.
- **code-review-graph:** when the MCP is available, refresh the graph after each commit step and explore graph-first.

## Toolchain hard rules

- **One heavy job at a time on this machine:** `bun run ci`, Playwright, a bench or stress run, a Codex review. When `~/code/tscache-reports/bin/heavy-run.sh` exists, run each through it (`heavy-run.sh "<label>" <command...>`); it waits for the lock, holds it and releases it.
- **Never `bun test`** — Vitest runs under Node (≥22.12). Use `bun run test` or `bunx vitest run`. Bun for everything else (workspaces, scripts).
- Build: tsdown (ESM-only, `isolatedDeclarations: true`). **tsup is EOL — do not use.** `tsc --noEmit` is the authoritative type check, on TypeScript 7 (the native compiler; user-confirmed 2026-10-23). TypeScript 7 ships no JS API: a tool that needs one gets TS 6 under an npm alias.
- Hook staging: pre-commit = Biome (staged) + gitleaks + commitlint (sub-second); pre-push = tsc + full Biome + build, then Knip and the integration snippets (`bun run check:integrations`) + Fallow (`bun run fallow`) + Vitest; `bun run ci` = superset incl. build + publint/attw + Playwright + bench smoke, plus gitleaks and commitlint over `main..HEAD` as the backstop for any skipped hook.
- Multi-tab tests: standalone Playwright, one `BrowserContext` + multiple pages (Vitest browser mode cannot share a SharedWorker across tabs).
- Tests follow `docs/testing.md`: no wall clock, no timing assertion, no sleep, no retries (`bun scripts/test-clocks.ts` in `bun run ci`). Hunt flakes with `scripts/flake-hunt.sh`.

## Resolved decisions

The resolved decisions are indexed in architecture §7 (starter §9, 2026-06-11) and §8 (N1 onward), one file each under `docs/decisions/`; read the files your task touches.

## Code Review Rules

Every review — automated or prompted — checks the diff against `docs/review-checklist.md` and reports in the output format defined there, most severe first. Prioritise violations of locked decisions and the invariants in that checklist over style. Only report issues tied to a specific line and a concrete failure scenario.
