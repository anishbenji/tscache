# tscache — Working Rules

Read `starter-prompt.md` (normative design register) and `docs/architecture.md` (approved API surface) before any work. Decisions in starter §3 are **locked — never relitigate silently**. Open/new decisions go to the user with alternatives + pros/cons.

## Process

- **No implementation without sign-off.** Architecture/API changes are reviewed first. As of 2026-06-11 the architecture doc is awaiting approval; implementation (starter §11 commits ①–⑭) is gated on it.
- **TDD (hybrid, user-confirmed):** strict test-first for engine logic (`coverage`, `segment/`, `engine/`); pragmatic tests-with-commit for scaffolding, RPC wiring, examples.
- **Commits:** small, Conventional Commits, repo green after every commit (`bun run ci` once it exists). Local-only — no GitHub remote, no Actions.
- **Docs:** all repo artifacts (docs, ADRs, README, TSDoc) in normal professional prose regardless of chat output mode.
- **code-review-graph:** build the graph at commit ② (first real source), refresh after each commit step, graph-first exploration thereafter.

## Toolchain hard rules

- **Never `bun test`** — Vitest runs under Node (≥22.12). Bun for everything else (workspaces, scripts).
- Build: tsdown (ESM-only, `isolatedDeclarations: true`). **tsup is EOL — do not use.** `tsc --noEmit` is the authoritative type check; tsgo optional pre-push only.
- Hook staging: pre-commit = Biome (staged) + gitleaks + commitlint (sub-second); pre-push = tsc + full Biome + Knip + `fallow audit` + Vitest; `bun run ci` = superset incl. build + publint/attw + Playwright + bench smoke.
- Multi-tab tests: standalone Playwright, one `BrowserContext` + multiple pages (Vitest browser mode cannot share a SharedWorker across tabs).

## Resolved decisions (user-confirmed 2026-06-11)

Name `tscache` unscoped, MIT · `interval` **required, no default** (deviation from starter §9.2 proposal, deliberate) · `alignmentOffset` included (default 0) · K=4, slot cap 32 768 · git-cliff · ESM-only · examples mapping per starter §7 · overlap warning = event + dev console. New decision points N1–N8 listed in `docs/architecture.md` §8 — check resolution status there before coding related areas.
