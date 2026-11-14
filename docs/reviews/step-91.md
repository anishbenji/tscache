# Step 91 — Stryker dev dependencies and a mutation script

Branch: `chore/91-stryker-deps` · Status: built, awaiting review

## Scope

Step 84 measured the engine's mutation score before the two Stryker packages were dependencies of the repository, because they could not be added unattended. The user approved adding them (user decision 60, option A) and ran `bun add -d --exact @stryker-mutator/core@10.1.1 @stryker-mutator/vitest-runner@10.1.1` in this worktree. This step commits that change, adds a script that runs Stryker from the repository root, and updates the mutation report's re-run recipe. It changes no source file, test or Stryker configuration.

Commits, by subject:

- `chore(deps): add the stryker dev dependencies (decision 60)`. `package.json` and `bun.lock` exactly as the user's `bun add` left them.
- `chore: add the mutation script and the in-repo re-run recipe`. `"mutation": "stryker run"` in the root `package.json` scripts, which also lets Knip see `@stryker-mutator/core` as used (the `stryker` binary). In `docs/benchmarks/mutation.md`, "How to re-run" now gives `bun run mutation` and how to scope a run with `--mutate`, and drops the note that the dependencies are pending. In `docs/INDEX.md`, the mutation report row names the script and is re-measured.
- `docs(review): step 91 scope and verification`. This file, and the review-file count and size in `docs/INDEX.md`.

`docs/reviews/step-84.md` still says the dependencies are pending decision 60. It is left unchanged because it records the state at step 84.

## Verification

### No existing package moved

The lockfile diff removes 26 lines. They are re-hoists, not version changes: Stryker brings its own `@babel` 8, so Bun now places `@babel/*` 8.x, `js-tokens@10.0.0` and their kin at the top level and moves the existing 7.29.x `@babel/*`, `js-tokens@4.0.0`, `semver@6.3.1` and `lru-cache` copies to nested keys under the packages that use them (for example `@solidjs/vite-plugin/@babel/core/semver`). Two checks confirm that no consumer resolves a different version:

1. **Per-consumer resolution.** A script (kept outside the repository) parses both lockfiles: main's (`git show 98b7bbf:bun.lock`) and this branch's. For every workspace and every package entry it resolves each dependency, optional dependency and peer dependency the way Bun's lockfile keys nest (the consumer's own key path, then each parent, then the top level), and records the pair (consumer name@version or workspace, dependency) with the resolved name@version.

   | Measure                                         | Main (98b7bbf) | This branch |
   | ----------------------------------------------- | -------------: | ----------: |
   | (consumer, dependency) pairs                    |          1,121 |       1,418 |
   | Main pairs whose resolved version changed       |              — |           0 |
   | Main pairs missing on the branch                |              — |           0 |
   | Pairs with no resolution (optional peers unset) |             55 |          55 |
   | Distinct package@version entries                |            687 |         800 |
   | Entries on main missing on the branch           |              — |           0 |

   The 113 added entries are Stryker, its `@babel` 8 tree, `@inquirer/*` and their small dependencies; none replaces a version main uses.

2. **Installed tree.** `bun pm ls --all` in a clean detached worktree of main (after `bun install --frozen-lockfile`) and in this worktree list 687 and 800 distinct package@version lines; every line from main is present on the branch, and the 113 new ones match the lockfile comparison.

### Commands

| Command                                                                                                                               | Result                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                                                                       | no changes                                                                                   |
| Lockfile comparison script, main against branch                                                                                       | 0 changed, 0 missing (table above)                                                           |
| `bun pm ls --all`, main worktree against this worktree                                                                                | 0 package@version lines lost, 113 added                                                      |
| `bun run knip` (unbuilt worktree)                                                                                                     | neither Stryker package reported; the other reports are the known unbuilt-`dist` ones        |
| `~/code/tscache-reports/bin/heavy-run.sh "91 child: mutation coverage.ts" bun run mutation --mutate packages/tscache/src/coverage.ts` | exit 0 in 53 s; 104 mutants, 100 killed, 2 timed out, 2 survived: score 98.08, as in step 84 |
| `~/code/tscache-reports/bin/heavy-run.sh "91 child: ci" bun run ci`                                                                   | exit 0 on 9f4ce81; later commits change only Markdown                                        |

The scoped run passed `--mutate` on the command line only; `stryker.config.json` is unchanged, and the run's reports and sandbox are under the ignored `reports/` and `.stryker-tmp/`.

Not run: the full mutation suite over every area (about 40 minutes in all), as the brief asked.

## Pre-review (Fable), not the gate

No P0 or P1; the pre-review reproduced the lockfile comparison with its own resolver (0 changed, 0 missing, 113 added) and found no install scripts in the new packages. One P2 (the run time read as per area; it is about 40 minutes for all six) and three nits (the CI row named no head; `docs/INDEX.md`'s own size; `AGENTS.md`'s heavy-job list does not name a mutation run) were fixed in `docs: step 91 pre-review fixes`, except the `AGENTS.md` line, which is the user's file and is proposed to the user. Its decision concern (the step 84 provenance sentence) is settled by stating when the numbers were measured without describing how.
