# Step 138 — Dependabot #162, the dev-dependencies group

Branch: `chore/138-dev-dependencies` · Status: built, awaiting review · It changes root `package.json` (dependency fields only; `scripts` is unchanged), `bun.lock`, `biome.json` and `knip.jsonc`, so the user merges this step.

## Scope

User decision 121 A (2026-11-21): take Dependabot pull request #162 in a short step and fix what its upgrade breaks. The approval covers exactly #162's 14 versions. Its commit `b0a41041` is cherry-picked unchanged, so `bun.lock` is exactly Dependabot's; commitlint already skips Dependabot's own capitalised bump subjects (`commitlint.config.mjs`), so the commit kept its subject.

| Package                | From    | To      |
| ---------------------- | ------- | ------- |
| `@biomejs/biome`       | 2.6.4   | 2.6.8   |
| `@playwright/test`     | 1.64.1  | 1.65.1  |
| `fallow`               | 3.37.0  | 3.43.2  |
| `knip`                 | 6.44.0  | 6.45.1  |
| `tsdown`               | 0.23.4  | 0.23.7  |
| `vitest`               | 5.0.5   | 5.1.0   |
| `fake-indexeddb`       | 6.2.7   | 6.2.8   |
| `vite`                 | 8.3.5   | 8.3.8   |
| `@tanstack/query-core` | 5.105.0 | 5.108.0 |
| `ws`                   | 8.22.0  | 8.23.0  |
| `@vitejs/plugin-react` | 6.1.2   | 6.3.0   |
| `@angular/common`      | 22.2.4  | 22.2.6  |
| `@angular/core`        | 22.2.4  | 22.2.6  |
| `vue`                  | 3.5.44  | 3.5.45  |

No other version was added, removed or changed. Every package is a development dependency; the published package's runtime dependencies are unchanged.

## Fixes

GitHub's ci on #162 failed in Biome: 13 errors and 1 info. Locally `bun run check` reported 14 errors (11 documents, 3 lint findings) and the info.

- **Markdown formatting (11 documents).** Biome 2.6.8 puts a blank line between a paragraph and the list that follows it, and drops whitespace-only lines inside a table block. `docs/benchmarking.md` and ten files under `docs/reviews/` change in whitespace only: `git diff --ignore-all-space --ignore-blank-lines` over them is empty. Fixed, as the rule is mechanical and leaves the rendered text unchanged.
- **`lint/nursery/useAwaitThenable` (3 findings).** The teardowns of `packages/tscache/test/perf/counters.test.ts`, `memory-budget.test.ts` and `persist.test.ts` awaited `PortClient.dispose()`, which returns `void` (`packages/tscache/src/rpc/port-client.ts`). Biome 2.6.4 found nothing there (N85 records 0 findings for the same rule); 2.6.8's type inference now sees the return type. Fixed: each teardown calls `dispose()` without `await` and is no longer `async`. The rule is right, so it stays on. `bunx vitest run` on the three files passes 27 of 27.
- **`biome.json` schema (the info).** `$schema` named the 2.6.4 schema; `bunx biome migrate --write` moved it to 2.6.8 and changed nothing else.
- **Knip configuration hint.** Knip 6.45.1 no longer reports `pgrep`, the system tool `e2e/demo/launcher.spec.ts` runs, as an unlisted binary, and printed a hint to remove `"ignoreBinaries": ["pgrep"]` from `knip.jsonc`. The entry and its comment are removed; `bun run knip` exits 0 without the hint. It was a hint, not a failure, and is a separate commit so it can be dropped on its own.

No rule was turned off. Fallow, tsdown, Vitest and Playwright reported nothing that needed a change.

**Playwright 1.65.1 needs a new Chromium build.** The first local `bun run ci` failed 88 Playwright tests (97 did not run), each with `browserType.launch: Executable doesn't exist at …/chromium_headless_shell-1255/…`: the browser for 1.65.1 was not installed yet. `bunx playwright install chromium` (the step in `CONTRIBUTING.md`; CI runs `bunx playwright install --with-deps chromium` on every job) downloaded build 1255, and the second run passed all 197. Nothing in the repository changed for it. A contributor's machine needs the same command once after this merges.

**Fallow warning, left as it is.** Fallow 3.43.2 warns that the entry glob `scripts/*.ts` in `.fallowrc.json` "matches 7 fewer files than before fallow 3.34.0", because a single `*` now matches one folder level only. The repository was already on 3.37.0, so the set of entries is unchanged; only the warning is new. One level is what the config means: it names `scripts/demo/record.ts` as an entry of its own, and the other `scripts/demo/` modules are imported by `scripts/demo.ts`, `scripts/demo-bench.ts` and that recorder. Silencing it would replace the glob with a hand-written list of every top-level script, which a new script would then have to join, so the glob stays. The warning does not fail `bun run fallow` or `bun run fallow:health`.

**Fallow `--runtime-coverage`.** Fallow 3.43.2 carries a security fix for `--runtime-coverage` on untrusted repositories. This repository does not use that flag: `grep -rn "runtime-coverage\|runtimeCoverage"` over the repository (outside `node_modules` and `.git`) finds nothing, and the only fallow commands are `fallow audit` and `fallow health --min-score 95` (root `package.json`, run by `lefthook.yml` and `scripts/ci.sh`).

**Documents that name a tool version.** The remaining mentions of an old version record a dated measurement, so they are left as they are: `docs/decisions/N85-effect-adoption.md` (Biome 2.6.4, measured on 2026-11-15), `docs/benchmarks/mutation.md` (Vitest 5.0.5 on the measured machine), `site/guides/workers.md` ("Built twice with Vite 8.3.5", an observed build) and `CHANGELOG.md`. `integrations/vue/README.md` and `integrations/angular/README.md` name only the minor lines (Vue 3.5, Angular 22.2), which still hold.

**`docs/INDEX.md`.** `docs/benchmarking.md` grew from 65,683 to 65,694 bytes, still 65.7 KB; no other indexed size changed, so the index is unchanged.

## Protected and notify paths touched

- Root `package.json`: dependency versions only. `jq -cS .scripts` prints the same text on `main` and on this branch.
- `packages/tscache/package.json` and the example, reference, integration and site `package.json` files: dependency versions only.
- `bun.lock`: Dependabot's lockfile, unchanged.
- `biome.json`: the `$schema` line only.
- `knip.jsonc`: the `ignoreBinaries` entry and its comment removed.

## Verification

| Check       | Command                                                                           | Result                                                                                                                                                                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install     | `bun install --frozen-lockfile`                                                   | 626 packages installed; `bun.lock` unchanged                                                                                                                                                                                                                                                                        |
| Versions    | `bunx biome --version`, and the same for Playwright, Knip, Fallow, Vitest, tsdown | 2.6.8, 1.65.1, 6.45.1, 3.43.2 (signed), 5.1.0, 0.23.7                                                                                                                                                                                                                                                               |
| Biome       | `bun run check`                                                                   | `Checked 920 files … No fixes applied.` No error, warning or info                                                                                                                                                                                                                                                   |
| Type check  | `bun run typecheck` and `bun run check:integrations`                              | exit 0                                                                                                                                                                                                                                                                                                              |
| Build       | `bun run build`                                                                   | exit 0; attw "No problems found", publint "No issues found"                                                                                                                                                                                                                                                         |
| Knip        | `bun run knip`                                                                    | exit 0; two existing hints (`.svelte`, `.vue`), the `pgrep` hint gone                                                                                                                                                                                                                                               |
| Fallow      | `bun run fallow` and `bun run fallow:health`                                      | "No issues in 32 changed files"; "6 above threshold · 1362 analyzed"                                                                                                                                                                                                                                                |
| Perf tests  | `bunx vitest run` on the three changed perf test files                            | 27 passed                                                                                                                                                                                                                                                                                                           |
| Test clocks | `bun scripts/test-clocks.ts`                                                      | `test-clocks: 214 files clean`                                                                                                                                                                                                                                                                                      |
| Full gate   | `~/code/tscache-reports/bin/heavy-run.sh "138 child: ci" bun run ci`              | On `9f6cff3a`, exit 0: gitleaks over `main..HEAD` (6 commits, no leaks) and commitlint, Biome `Checked 921 files … No fixes applied.`, typecheck, build with publint and attw clean, Knip, Fallow (health 97), Vitest 3359 passed (173 files), Playwright 197 passed, size within budget, bench smoke and e2e smoke |

## Contract-test changes

None. The three test edits remove an `await` on a `void` call in a teardown; no assertion changed.

## Decision concerns

None.
