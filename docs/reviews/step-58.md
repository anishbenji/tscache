# Step 58 — Publish under the @anishbenji scope

Branch: `chore/58-npm-scope` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: re-review pending · Verdict after triage: pending

The package is renamed from `tscache` to `@anishbenji/tscache`. npm refuses the unscoped name: it strips punctuation before comparing names, so `tscache` collides with the existing `ts-cache`. The user chose the personal scope on 2026-11-04 and deferred an organisation scope (`docs/architecture.md` N67, superseding §7 #1).

## Scope

| Commit  | What                                                                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0b73f1e | `docs`: N67 in the decision register, §7 #1 marked superseded, the `AGENTS.md` resolved-decisions line updated.                                                                                                                          |
| 10ffe99 | `chore`: every import specifier, workspace dependency, tsconfig path, `bun --filter`, Vite `ssr.noExternal` entry, TypeDoc `@module` tag, the stand-in installed package in `vite-fetcher-url.test.ts`, and the docs that name an entry. |
| 16b4e41 | `chore(package)`: `repository`, `homepage`, `bugs`, and `publishConfig.access: "public"` (a scoped package otherwise publishes as restricted).                                                                                           |
| 3522c6b | `test`: the Vitest source aliases match the scoped specifiers (R1-1).                                                                                                                                                                    |
| 135694a | `docs`: the copy recipes name `node_modules/@anishbenji/tscache/dist` (R1-2).                                                                                                                                                            |

The rename is mechanical, done by a codemod that rewrites only module-specifier contexts. What keeps the name `tscache`, deliberately:

- Runtime strings: the IndexedDB database (N51), the `[tscache]` log and warning prefix, the `tscache:auth-invalid` marker (N8), the `tscache-worker:` lock and worker names, the `tscache:fetcher-url` plugin name, the Vue injection key's description, and the demo's build label. Renaming any of them would orphan stored data or change behaviour.
- Historical records: `docs/reviews/`, `starter-prompt.md` and `docs/architecture-review.md` keep the name they were written with.
- The served path `/vendor/tscache` in the no-bundler recipes, which is the app's choice.

## CI

`bun run ci` passed on the host before round 1 (`.reviews/step-58/round-1.ci.log`). After the fixes, the examples' and integration snippets' tests pass with `packages/tscache/dist` moved aside (8 files, 137 tests), the case R1-1 covers.

## Not verified

- Publishing. The npm account `anishbenji` did not exist on 2026-11-04 (the registry and npmjs.com answer "Scope not found"), and the version is still `0.0.0`. A publish workflow and the release flow are a separate step.
- The local install still holds stale `node_modules/tscache` links from before the rename, which would resolve a missed import. The fresh install in GitHub Actions is the check for that.

## Round 1 — reviewer verdict: merge after fixes

Review of the branch at 16b4e41 (`.reviews/step-58/round-1.md`, high), with the host `bun run ci` passing.

| #    | Sev | Finding                                              | Decision | Resolution                                                                                                                                                                            |
| ---- | --- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-1 | P1  | Vitest's aliases still match the unscoped specifiers | accepted | Reproduced: with `dist/` moved aside, 5 of 8 example and integration test files fail with `Failed to resolve entry for package "@anishbenji/tscache"`. Fixed in 3522c6b; 8 of 8 pass. |
| R1-2 | P1  | The copy recipes name `node_modules/tscache/dist`    | accepted | Confirmed by reading: a scoped install lives under `node_modules/@anishbenji/`. Fixed in 135694a, all four paths; the served `/vendor/tscache` stays.                                 |

Both misses were regex literals and paths, which the codemod's specifier rules did not cover; the codemod now has rules for both and changes nothing further on this branch.

## Contract-test changes

None.

## Decision concerns

None.
