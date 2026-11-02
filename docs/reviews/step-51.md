# Step 51 — Development tools upgraded (Dependabot #77)

Branch: `chore/51-dev-tools` · Status: round 1 triaged; formatting commit pending

User decision #13 (2026-11-02) had the Dependabot upgrades fixed and merged. User decision #14 (2026-11-02) applied the same treatment to Dependabot pull request #77, which supersedes #69: fold its 13 versions into this branch, re-apply the Biome formatting in a commit of its own, run the full CI, and review the one code change with Codex. Version bumps alone skip the review loop; the rename below is a code change, so it is reviewed.

The branch was never pushed. It was rebuilt on `main` after #74–#76 merged, so its package files and lockfile match #77 exactly.

## Scope

| Commit  | What                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9ab1dfa | `build(deps)`: the 13 updates of #77 (Biome 2.6.4, commitlint 21.2.4, Playwright 1.64.1, Fallow 3.37.0, Knip 6.44.0, Lefthook 2.2.2, tsdown 0.23.4, Vitest 5.0.5, Vite 8.3.5, Angular 22.2.4, Svelte 5.57.3); package files and lockfile as in #77 (`bun install --frozen-lockfile` passes); the Biome configuration schema moves to 2.6.4 (`biome migrate`) |
| c409e68 | `refactor(scripts)`: `describe` renamed to `describeError` in `scripts/demo.ts`. Biome 2.6 reports a local function named `describe` as a misplaced test block (a false positive for a helper that formats an error); the rename is the smallest change that keeps the rule on                                                                               |
| a21d76e | `ci(dependabot)`: groups for packages that must move together (`react` with `react-dom`; `solid-js` with `@solidjs/*`), so Dependabot no longer opens pairs that fail alone                                                                                                                                                                                  |
| pending | `style`: Biome 2.6.4 formatting. Biome 2.6 formats Markdown and YAML, which earlier versions skipped. The commit is made after `feat/38-persistence` (#78) merges, because it rewrites many of the same Markdown files and would otherwise conflict with it                                                                                                  |

## Round 1 — reviewer verdict: merge after fixes

Review of the branch at a21d76e (`.reviews/step-51/round-1.md`). The reviewer raised nothing on the rename, the Dependabot groups or the version bumps.

| #    | Sev | Finding                                                                                                                                                                                            | Decision            | Resolution                                                                                                                                                                            |
| ---- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-1 | P1  | Biome 2.6.4 checks Markdown and YAML formatting that existing files do not satisfy: `biome ci .` reports 81 errors and 1 warning, so `bun run ci` stops before type-checking, building and testing | accepted (expected) | The formatting-only commit listed under Scope, made with `biome format --write` once #78 has merged and `main` is merged into this branch; then the full `bun run ci` before the push |
