# tscache — Agent Working Rules

Shared rules for every coding agent on this repo: Claude (via T3 Code or Claude Code) and Codex (via T3 Code or the Codex CLI). `CLAUDE.md` imports this file; Codex reads it natively.

Read `starter-prompt.md` (normative design register) and `docs/architecture.md` (approved API surface, signed off) before any work. Decisions in starter §3 and architecture §7–§8 are **locked — never relitigate silently**. Open or new decisions go to the user with alternatives and pros/cons; the user makes the call.

## Roles

| Role | Agent | Does | Never |
|---|---|---|---|
| Implementer | Claude | Writes `src/`, scaffolding and non-contract tests; runs the review loop, validating and triaging every finding | Weakens or deletes a contract test without recording why in the step's review file |
| Contract-test author | Codex | Writes failing tests for engine-logic steps from the architecture doc, before implementation | Creates or edits anything under `src/` |
| Reviewer | Codex, run headless by Claude via `scripts/codex-review.sh` | Reviews the step branch against `docs/review-checklist.md`, one fresh session per round | Edits, stages or commits anything — review is read-only |
| Approver | The user | Reads the triage, runs `bun run ci`, merges | — |

The per-step pipeline, the review loop, copy-paste prompts and the adversarial-review schedule are in `docs/workflow.md`.

## Process

- **Commit plan:** starter §11, steps ①–⑭. One branch per step (`feat/NN-slug`, or `chore/NN-slug` for tooling) cut from `main`; the user merges after review. Tooling and workflow changes go on their own `chore/` branch, never on a step branch.
- **TDD (hybrid, user-confirmed 2026-06-11; contract-test authorship added 2026-10-03):** strict test-first for engine logic (`coverage`, `segment/`, `engine/` — steps ③–⑧). For those steps the failing tests are written by Codex from the architecture doc and Claude implements against them. Pragmatic tests-with-commit for scaffolding, RPC wiring and examples.
- **Commits:** small Conventional Commits; the repo is green after every commit (`bun run ci`). Contract tests land in the same commit as the code that makes them pass. Local-only — no GitHub remote, no Actions.
- **Never bypass git hooks** (`--no-verify`, `LEFTHOOK=0`). If a hook fails, fix the cause.
- **Dependencies:** adding or upgrading one is a decision — ask first. Add a dependency in the step that first imports it (Knip and Fallow fail on unused dependencies).
- **Docs:** all repo artifacts (docs, ADRs, README, TSDoc) in normal professional prose regardless of chat output mode. Documentation debts (starter §8) ship in the step that touches their area.
- **code-review-graph:** when the MCP is available, refresh the graph after each commit step and explore graph-first.

## Toolchain hard rules

- **Never `bun test`** — Vitest runs under Node (≥22.12). Use `bun run test` or `bunx vitest run`. Bun for everything else (workspaces, scripts).
- Build: tsdown (ESM-only, `isolatedDeclarations: true`). **tsup is EOL — do not use.** `tsc --noEmit` is the authoritative type check; tsgo optional pre-push only.
- Hook staging: pre-commit = Biome (staged) + gitleaks + commitlint (sub-second); pre-push = tsc + full Biome + Knip + Fallow (`bun run fallow`) + Vitest; `bun run ci` = superset incl. build + publint/attw + Playwright + bench smoke, plus gitleaks and commitlint over `main..HEAD` as the backstop for any skipped hook.
- Multi-tab tests: standalone Playwright, one `BrowserContext` + multiple pages (Vitest browser mode cannot share a SharedWorker across tabs).

## Resolved decisions (user-confirmed 2026-06-11)

Name `tscache` unscoped, MIT · `interval` **required, no default** (deviation from starter §9.2 proposal, deliberate) · `alignmentOffset` included (default 0) · K=4, slot cap 32 768 · git-cliff · ESM-only · examples mapping per starter §7 · overlap warning = event + dev console. New decision points **N1–N8 all resolved 2026-06-11** — register in `docs/architecture.md` §8. Highlights: ranges inclusive both ends, unaligned get/invalidate snap outward, internal math on slot indices; three-scope events (client/cache/request, requestId `clientId:seq`); `put()` returns warnings; `./fetcher` subpath; auth error detected by marker `code === 'tscache:auth-invalid'`, never instanceof.

## Code Review Rules

Every review — automated or prompted — checks the diff against `docs/review-checklist.md` and reports in the output format defined there, most severe first. Prioritise violations of locked decisions and the invariants in that checklist over style. Only report issues tied to a specific line and a concrete failure scenario.
