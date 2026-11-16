# Step 116 — four Biome promise and switch rules, and noImplicitReturns

Branch: `chore/116-promise-lint-rules` · Reviewer: GPT-6.1 Sol (pending) · Rounds: 0 · Status: implementation complete, review not yet run

## Scope

User decision 75 (2026-11-16) turns on the two guardrails that the Effect evaluation of 2026-11-15 (`docs/adr/0001-effect-adoption.md`, moving to `docs/decisions/N85-effect-adoption.md` in step 115) recommends instead of adopting Effect:

- `biome.json`: a `nursery` group beside the `recommended` preset, with `noFloatingPromises`, `noMisusedPromises`, `useAwaitThenable` and `useExhaustiveSwitchCases` as errors. The snippet is the ADR's "Lint setup: `biome.json`", applied as written. The rest of the file (VCS, file includes, formatter, assist and the JSON-with-comments override) is unchanged.
- `tsconfig.base.json`: `"noImplicitReturns": true`, placed after `noFallthroughCasesInSwitch`. Every type-check project inherits it, directly or through `examples/`, `integrations/` and `reference/tsconfig.base.json`.

No source, test or example file changes: neither setting reports anything on the current code.

| Commit (by subject)                                                              | What                                   |
| -------------------------------------------------------------------------------- | -------------------------------------- |
| `chore(lint): turn on four biome promise and switch rules and noImplicitReturns` | `biome.json` and `tsconfig.base.json`. |
| `docs(review): step 116, biome promise rules and noImplicitReturns`              | This file.                             |

## Findings from the new settings

None. The ADR measured 0 findings for each rule run alone and 0 new type errors for `noImplicitReturns`; the runs below repeat that with the edited configuration, which the ADR did not run.

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

### The type check

`noImplicitReturns` reaches 25 projects. All type-check with no error:

- `bun run typecheck` (`packages/tscache`, root, `e2e`, `examples/mock-backend`, `reference/shared`): no output.
- `bun run check:integrations` (`integrations/` shared, test, vanilla, react, solid, vue, svelte, angular), after `bun run build`: no output.
- `bunx tsc -p <project>` for each project the two commands above do not cover: `examples/benchmark`, `examples/solid-ssr`, `examples/react-lwcharts`, `examples/solid-uplot`, `examples/vanilla-uplot`, `examples/react-ssr`, `examples/solid-lwcharts`, `reference/solid`, `reference/vanilla`, `reference/react`, `site` and `site/scripts`: no output for any.

### Documentation

No current-state document lists the Biome rules or the compiler flags: a search of `docs/`, `site/guides/`, `README.md`, `AGENTS.md` and the package README for the flag names, `biome.json`, `tsconfig.base` and "preset" finds nothing outside `docs/reviews/`. The ADR's "Type and lint settings" line describes the state on 2026-11-15 and is not a current-state document; step 115 moves it. `docs/review-checklist.md` is protected and was not changed. `docs/INDEX.md` needs no change: the `docs/reviews/` row carries no count.

### Full CI

`~/code/tscache-reports/bin/heavy-run.sh "116 child: ci" bun run ci` runs on the head that adds this file. `bun run ci` checks the commit range, so it cannot run before this file is committed. Its result goes in the step report to the director and in the round 1 triage.

## Contract-test changes

None.

## Decision concerns

None.
