# Step 116 — four Biome promise and switch rules, and noImplicitReturns

Branch: `chore/116-promise-lint-rules` · Reviewer: GPT-6.1 Sol (pending) · Rounds: 0 · Status: pre-review fixed; Codex round 1 not yet run

## Scope

User decision 75 (2026-11-16) turns on the two guardrails that the Effect evaluation of 2026-11-15 recommends instead of adopting Effect. Its record is `docs/decisions/N85-effect-adoption.md`, which step 115 adds (`docs/115-effect-decision`, not yet on `main`).

- **Merge order:** only this file cites N85; no code or configuration depends on step 115. Step 116 can merge before or after 115. If it merges first, the N85 path above resolves once 115 lands. It is written as code, not as a link, so no link check fails in the meantime.

The changes:

- `biome.json`: a `nursery` group beside the `recommended` preset, with `noFloatingPromises`, `noMisusedPromises`, `useAwaitThenable` and `useExhaustiveSwitchCases` as errors. The snippet is N85's "Lint setup: `biome.json`", applied as written. The rest of the file (VCS, file includes, formatter, assist and the JSON-with-comments override) is unchanged.
- `tsconfig.base.json`: `"noImplicitReturns": true`, placed after `noFallthroughCasesInSwitch`. Every type-check project inherits it, directly or through `examples/`, `integrations/` and `reference/tsconfig.base.json`.
- `scripts/ci.sh`, `lefthook.yml` and the hook-staging line in `AGENTS.md`: the full-repository Biome check runs after the package build (pre-review PR-1, below).

No source, test or example file changes: neither setting reports anything on the current code.

| Commit (by subject)                                                              | What                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------- |
| `chore(lint): turn on four biome promise and switch rules and noImplicitReturns` | `biome.json` and `tsconfig.base.json`.      |
| `docs(review): step 116, biome promise rules and noImplicitReturns`              | This file.                                  |
| `fix(ci): lint the whole repository after the package build`                     | PR-1: `ci.sh`, `lefthook.yml`, `AGENTS.md`. |
| `docs(review): step 116 pre-review triage`                                       | PR-1 to PR-3 recorded here.                 |

## Findings from the new settings

None. N85 records 0 findings for each rule run alone and 0 new type errors for `noImplicitReturns`; the runs below repeat that with the edited configuration, which N85 did not run. The file counts are at `41a9878`; after merging `main`, Biome checks 799 files with the same result.

- `bunx biome check .`: `Checked 796 files … Found 1 warning.` The one warning is `lint/performance/useDomNodeTextContent` at `e2e/examples/react-lwcharts.spec.ts:37` (`page.locator("#log").innerText()`). It comes from the `recommended` preset, is present on `main` without this change, and is outside this step. It is a false positive: the call is Playwright's `Locator.innerText()`, not the DOM property. `biome ci` passes with it, as on `main`.
- `bunx biome lint --only=nursery/noFloatingPromises --only=nursery/noMisusedPromises --only=nursery/useAwaitThenable --only=nursery/useExhaustiveSwitchCases .`: `Checked 796 files … No fixes applied.`, no diagnostics.
- Biome 2.6.4 (`bunx biome --version`, matching the `$schema` in `biome.json`) accepts the four rule names: no unknown-rule warning or configuration error is printed.

No ignore comment was added.

## Verification

### The rules are live

A planted file, `packages/tscache/src/zz-plant.ts`, created for the check and deleted afterwards (`git status --short` then showed only the two configuration files), with one violation of each rule. `bunx biome lint packages/tscache/src/zz-plant.ts` reported `Found 5 errors.`:

| Line | Rule                                    | Planted code                                     |
| ---: | --------------------------------------- | ------------------------------------------------ |
|    5 | `lint/nursery/noFloatingPromises`       | an unawaited call to an `async` function         |
|    8 | `lint/nursery/noMisusedPromises`        | an `async` callback passed to `Array.forEach`    |
|   11 | `lint/nursery/noMisusedPromises`        | a promise used as an `if` condition              |
|   16 | `lint/nursery/useAwaitThenable`         | `await 1`                                        |
|   20 | `lint/nursery/useExhaustiveSwitchCases` | a `switch` over `"x" \| "y"` handling only `"x"` |

A second planted file in the same place, with a function that returns a value on one branch only, made `bunx tsc -p packages/tscache` report `error TS7030: Not all code paths return a value.`; it was deleted the same way.

A third plant checks a promise typed through the package, as the examples and reference clients see it (PR-1, below): an unawaited `createClient(...)` in `reference/vanilla/src/page.ts` is caught only when `packages/tscache/dist` is built, and `bun run ci` now fails on it.

### What the rules do not see

Biome infers types itself and does not read every declaration a compiler would (N85, "Risks": a floor, not a proof). Measured on this branch with a temporary `e2e/zz-plant.spec.ts`, deleted afterwards:

- **Playwright promises:** unawaited `page.goto("/")`, `page.evaluate(...)`, `page.locator(...).click()` and `chromium.launch()` were not flagged. Only an unawaited `expect(...).toBeVisible()` was, by the recommended preset's `lint/correctness/noPlaywrightMissingAwait`, not by the new rules.
- **Node built-ins:** an unawaited `readFile("x")` from `node:fs/promises` was not flagged.
- **The package's own types without `dist/`:** a promise typed through `@anishbenji/tscache` is seen only when the package is built (PR-1). The CI and pre-push order now guarantee a build first; an editor or a one-off `bunx biome check` in a fresh checkout does not.
- A same-file `async` function called without `await` in the same plant was flagged, as a control.

So "0 findings" in `e2e/` says little about Playwright calls; the gate there is the specs themselves failing.

### The type check

`noImplicitReturns` reaches 25 projects. All type-check with no error:

- `bun run typecheck` (`packages/tscache`, root, `e2e`, `examples/mock-backend`, `reference/shared`): no output.
- `bun run check:integrations` (`integrations/` shared, test, vanilla, react, solid, vue, svelte, angular), after `bun run build`: no output.
- `bunx tsc -p <project>` for each project the two commands above do not cover: `examples/benchmark`, `examples/solid-ssr`, `examples/react-lwcharts`, `examples/solid-uplot`, `examples/vanilla-uplot`, `examples/react-ssr`, `examples/solid-lwcharts`, `reference/solid`, `reference/vanilla`, `reference/react`, `site` and `site/scripts`: no output for any.

### Documentation

No current-state document lists the Biome rules or the compiler flags: a search of `docs/`, `site/guides/`, `README.md`, `AGENTS.md` and the package README for the flag names, `biome.json`, `tsconfig.base` and "preset" finds nothing outside `docs/reviews/`. N85's "Type and lint settings" line (step 115) describes the state on 2026-11-15 and is a dated record, not a current-state document. After the PR-1 fix, `AGENTS.md`'s hook-staging line named the old pre-push order and was updated (PR-1, below). `docs/review-checklist.md` is protected and was not changed. `docs/INDEX.md` needs no change: the `docs/reviews/` row carries no count.

### Full CI

`~/code/tscache-reports/bin/heavy-run.sh "116 child: ci" bun run ci` runs on the head that adds this file. `bun run ci` checks the commit range, so it cannot run before this file is committed. Its result goes in the step report to the director and in the round 1 triage.

## Pre-review (Claude), not the gate

Fable 5.2, on `41a9878`, before Codex round 1 (`~/code/tscache-reports/reviews/step-116/pre-review-1.md`). Its "Decision concerns" item (how low Biome's inference floor is, against a compiler-backed linter) is escalated to the user by the director and not acted on here.

| #    | Sev | Finding                                                                                                   | Decision | Resolution                                                                                           |
| ---- | --- | --------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| PR-1 | P1  | The promise rules see package-typed promises only with `dist/` built, and `ci.sh` linted before the build | accepted | fixed in `0750741`; see below                                                                        |
| PR-2 | P2  | The liveness check covers only a same-file plant in `packages/tscache/src`                                | accepted | "What the rules do not see", above, reproduced on this branch                                        |
| PR-3 | P2  | The file cited `docs/adr/`, which is on neither this branch nor `main`                                    | accepted | cites `docs/decisions/N85-effect-adoption.md` (step 115) only, with the merge-order note under Scope |

### PR-1

**Reproduced.** A temporary plant added an unawaited `createClient({ workerUrl, fetcher: { module: fetcherModule, context: await fetcherContext() } })` at the end of the teardown in `reference/vanilla/src/page.ts`. It has the same arguments as the file's own call, so it still type-checks. `bunx biome lint reference/vanilla/src/page.ts` reported `page.ts:220:5 lint/nursery/noFloatingPromises` with `packages/tscache/dist` built and nothing with it deleted. `scripts/ci.sh` deletes `dist/` at the start and ran `biome ci .` before the build, so CI could never see it. Pre-push ran `biome-full` in parallel with the build, so the result there depended on whether `dist/` was already present.

**Fix.** `scripts/ci.sh` runs `bunx biome ci .` immediately after the package build, before `site api`. In `lefthook.yml`, `biome-full` moves into the piped `built` group, after `build` and before `knip`, so pre-push sees the package's types as CI does. `AGENTS.md`'s hook-staging line names the new pre-push order. The edit is the minimum that makes the step's rules effective; both files are protected paths, and this pull request is already the user's merge.

**Proof.**

| Order and state                                      | Command                                               | Result                                                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Old order: `dist/` deleted, as at the old Biome step | `rm -rf packages/tscache/dist && bunx biome ci .`     | `Checked 799 files … Found 1 warning.`: the plant is not reported                                                                                |
| New order, the plant in place                        | `heavy-run.sh "116 child: ci plant proof" bun run ci` | exit 1 at the Biome step, after build, publint and attw: `reference/vanilla/src/page.ts:220:5 lint/nursery/noFloatingPromises`, `Found 1 error.` |

The plant was undone with the Edit tool, and `git status --short` then showed only the three fix files.

**`dist/` is not linted.** It is gitignored (`.gitignore`: `dist/`), and `biome.json` sets `vcs.useIgnoreFile: true`. `bunx biome ci .` checks 799 files with and without `dist/` built. `bunx biome check packages/tscache/dist` reports `No files were processed` and lists the path as ignored. The build writes nothing else: `git status --short --ignored` before and after `bun run --filter @anishbenji/tscache build` differs only by `packages/tscache/dist/`. The later `site api` step writes `site/api/`, which `site/.gitignore` ignores, and it runs after Biome anyway.

**Pre-push.** `bunx lefthook validate`: `All good`. `bunx lefthook run pre-push --job built` from a deleted `dist/` ran `build`, `biome-full`, `knip` and `integrations` in that order, all passing.

**Pre-commit** is unchanged: its staged `biome` job was not edited and ran in 0.48 s on the fix commit. As before, it lints only the staged files, and sees package types when `dist/` happens to be built. A `dist/` older than `src/` can also make the promise rules report a correct `await` or bare call on a package type in a staged file; if pre-commit fails that way, rebuild (`bun run build`) and commit again.

### Pre-review 2 (Claude Opus 5.5, on `fbc8fe6`)

No P0 or P1. Two P2s, both accepted and fixed by the director:

- PR2-1 (P2): `CONTRIBUTING.md` called `bun run check` "the Biome lint", which now matches CI only with a fresh build. Fixed: the line says to run it after `bun run build`, because the promise rules read the package's types from `dist/`.
- PR2-2 (P2): pre-commit's staged Biome reads whatever `dist/` exists, so an old build can report a correct call. Fixed: the pre-commit paragraph above says so and gives the remedy (rebuild).

## Contract-test changes

None.

## Decision concerns

None.
