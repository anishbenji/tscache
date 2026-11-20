# Step 123 — Solid 2.0.3 final upgrade

Branch: `chore/123-solid-2-final` · Status: awaiting review

## Scope

The user approved this dependency upgrade on 2026-11-20 (brief in the director's `solid-2.0.3/director-prompt.md`). `solid-js` and `@solidjs/web` move from `2.0.0-rc.20` to `2.0.3`, and `@solidjs/vite-plugin` 3.0.1 replaces `vite-plugin-solid` 3.0.0-next.27, in:

- `integrations/package.json` (dev dependencies, used by `integrations/solid/` and its test);
- `examples/solid-ssr`, `examples/solid-uplot`, `examples/solid-lwcharts` and `reference/solid` (`package.json` and `vite.config.ts`);
- `bun.lock`, regenerated.

The published `@anishbenji/tscache` package is unchanged: it has no Solid dependency. `integrations/README.md`, `integrations/solid/README.md`, `examples/solid-ssr/README.md` and `site/frameworks/solid.md` no longer describe Solid 2 as a release candidate, and the integration README names the new plugin. No source file changed.

## Versions and why

`bun pm view <pkg> dist-tags` on 2026-11-20:

| Package                | `latest` | `next`        |
| ---------------------- | -------- | ------------- |
| `solid-js`             | 2.0.3    | 2.0.0-rc.23   |
| `@solidjs/web`         | 2.0.3    | 2.0.0-rc.23   |
| `@solidjs/signals`     | 2.0.3    | 2.0.0-rc.23   |
| `@solidjs/vite-plugin` | 3.0.1    | 3.0.0-next.35 |

`latest` is still 2.0.3 and 3.0.1, the versions the brief prepared, so no further bump and no changelog reading past 2.0.3 was needed. The `next` tags are older than `latest` and were not used. The pins are exact. `vite-plugin-solid@3.0.0-next.27` was a thin wrapper over `@solidjs/vite-plugin` with no peer dependencies; the plugin's own package is the supported one for Solid 2 and brings HMR in itself, so `solid-refresh` is not needed. It compiles JSX with `@solidjs/compiler` (resolved at 2.0.2, a dependency of the plugin, not pinned here). No other package was added; `@solidjs/router` is not used.

Between rc.20 and 2.0.3 the API changed in `createOwner` (dropped from the public types in rc.21), `markRaw` (new in 2.0.3) and store tracking of frozen objects (2.0.1) and class getters (2.0.2). `grep -rnE "createOwner|markRaw|createStore|createProjection|solid-js/internal|Object\.freeze"` over `integrations/solid`, the three Solid examples, `reference/solid` and `site` finds none of them in Solid code (three hits in `site/scripts/check-doc-anchors*.ts`, which do not use Solid).

## Dedupe and leftovers

- `bun install`: `629 packages installed`; then `bun install --frozen-lockfile`: `Checked 650 installs across 773 packages (no changes)`.
- `bun why solid-js`, `bun why @solidjs/web`, `bun why @solidjs/signals`: one copy each, `2.0.3`. `@solidjs/web` and `@solidjs/vite-plugin` declare `solid-js` as a peer and resolve to that copy; `@solidjs/signals` comes in through `solid-js`. `node_modules/.bun` holds one store entry each: `solid-js@2.0.3`, `@solidjs+web@2.0.3`, `@solidjs+signals@2.0.3`, `@solidjs+vite-plugin@3.0.1`.
- No Solid release candidate and no `vite-plugin-solid` in any `package.json` or in `bun.lock`. The lockfile's only `rc.` string is Vue's own peer range in `@vitejs/plugin-vue` (`^3.6.0-rc.10`), which is unrelated.
- Live docs (everything but `docs/reviews/`, `CHANGELOG.md`, `node_modules` and `dist`): no `release candidate`, `rc.2`, `2.0.0-rc` or `vite-plugin-solid`.
- The lockfile drops `vite-plugin-solid`'s Babel tree (`babel-preset-solid` and its `@babel/*` dependencies) and adds `@solidjs/vite-plugin`, `@solidjs/compiler` with its platform binaries, `seroval` and `seroval-plugins`. It also writes an entry `@tscache/site/typedoc` (`typedoc@0.28.20`) and moves `@tscache/site/typescript` (still `typescript@6.0.3`): the installed store entry is `typedoc@0.28.20+7524df1edfed9f02` here and in a checkout of `main`, so the install is the same and only the lockfile's text changed.

## Verification

Run on this Mac (Node 26.13.0, Bun 1.4.2, Playwright 1.64.1, Vite 8.3.5), every heavy job through `~/code/tscache-reports/bin/heavy-run.sh`.

| Check                                | Command                                                                                                                                                                                                                                                                                                             | Result                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full gate                            | `heavy-run.sh "123 child: ci" bun run ci`                                                                                                                                                                                                                                                                           | exit 0: Biome `Checked 834 files … Found 1 warning` (below), typecheck, build with publint and attw, Knip, Fallow (health 97), Vitest 2957 passed (149 files), check:pack, check:integrations, docs check/run/build, Playwright 191 passed, size, bench smoke and e2e smoke |
| Solid examples and reference clients | `E2E_EXAMPLES=solid-uplot,solid-lwcharts,solid-ssr,reference-vanilla,reference-react,reference-solid heavy-run.sh "123 child: e2e solid" bunx playwright test --project=examples e2e/examples/solid-uplot.spec.ts e2e/examples/solid-lwcharts.spec.ts e2e/examples/solid-ssr.spec.ts e2e/reference/clients.spec.ts` | 83 passed, exit 0 (each app built with `tsc -p .` and `vite build`, served by `vite preview`)                                                                                                                                                                               |
| Dev smoke, four apps                 | below                                                                                                                                                                                                                                                                                                               | all four load with no Solid diagnostic; HMR applied in place in each                                                                                                                                                                                                        |
| Ports after the dev smoke            | `lsof -nP -iTCP:5611-5614 -sTCP:LISTEN`                                                                                                                                                                                                                                                                             | nothing bound                                                                                                                                                                                                                                                               |

The full gate ran before the commits, on a working tree identical to the first commit's. It ran again on the final head after the commits, so the branch-range gitleaks and commitlint checks, which `scripts/ci.sh` skips while `HEAD` is `main`, also ran; that result is in the director's report for this step.

### Dev smoke

A throwaway Node script (outside the repository) started each app with `bun run dev --host 127.0.0.1 --port <port> --strictPort`, opened the page in headless Chromium, recorded every console message and page error, set a marker on `window`, then waited while one JSX heading was edited by hand; the edit was then undone, and `git status` showed only this step's files.

| App                       | Page   | Edited                  | Console on load                             | After the edit                                                                 | HMR                                   |
| ------------------------- | ------ | ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| `examples/solid-uplot`    | `/`    | `src/main.tsx`, `<h2>`  | `[vite] connecting...`, `[vite] connected.` | `[vite] hot updated: /src/main.tsx`                                            | in place (window marker kept, 1 load) |
| `examples/solid-lwcharts` | `/`    | `src/main.tsx`, `<h2>`  | same                                        | `[vite] hot updated: /src/main.tsx`                                            | in place                              |
| `examples/solid-ssr`      | `/`    | `src/panel.tsx`, `<h2>` | same                                        | `[vite] hot updated: /src/panel.tsx`; the server logged `(ssr) program reload` | in place                              |
| `reference/solid`         | `/ssr` | `src/App.tsx`, `<h1>`   | same                                        | `[vite] hot updated: /src/App.tsx`; `(ssr) program reload`                     | in place                              |
| `reference/solid`         | `/`    | none                    | same                                        | —                                                                              | not exercised                         |

No Solid dev diagnostic (for example `STRICT_READ_UNTRACKED`; codes in `solid-js/skills/reactivity-diagnostics`), no warning, no error and no page error was logged on any page. The smoke checked only the console and that the edited heading appeared; it did not check what the charts drew, which the Playwright suites cover against the built apps.

## Biome `useDomNodeTextContent`

The brief reported this rule as failing on `main`. It does not fail any command the repository runs:

- `lint/performance/useDomNodeTextContent` flags `page.locator("#log").innerText()` at `e2e/examples/react-lwcharts.spec.ts:37`. In Biome 2.6.4 (the locked version, matching `biome.json`'s `$schema`) it is a **warning** from the `recommended` preset.
- `bunx biome ci .` (in `scripts/ci.sh`), `bunx biome check .` (pre-push) and `bunx biome check --write` on staged files (pre-commit) all exit 0 with it, on `main` and on this branch: `Checked 834 files … Found 1 warning.` Its fix is marked unsafe, so the pre-commit `--write` does not apply it.
- It becomes a failure only with `--error-on-warnings` (`bunx biome ci --error-on-warnings .` exits 1), which no script, hook or workflow in the repository passes. An editor's Biome integration also shows it, which is the likeliest place it was seen as a failure.
- Step 116 recorded the same warning and judged it a false positive: the call is Playwright's `Locator.innerText()`, not the DOM property, and `Locator.textContent()` would read hidden text too and return `string | null`.

It was not fixed or suppressed here, and it does not block `bun run ci`.

## CHANGELOG and index

No CHANGELOG entry. `CHANGELOG.md` covers the published `@anishbenji/tscache` package only and is generated at release time by git-cliff (`docs/releasing.md`, the changelog step); it keeps no hand-written unreleased section, and `cliff.toml` skips `chore(deps…)` commits. This step changes no published code, only example, reference and integration dev dependencies. Earlier dependency steps did the same: step 91's `chore(deps): add the stryker dev dependencies` added no entry and is not in the generated 0.1.0 list.

No `docs/INDEX.md` change: its `docs/reviews/` row covers every step file.

## Contract-test changes

None.

## Decision concerns

- The `useDomNodeTextContent` warning stays. If a warning-free Biome run is wanted, the options are an override turning the rule off for `e2e/**` (every hit there is Playwright's `Locator`, not the DOM), or switching the call to `textContent()` and handling `null` and hidden text. That would be a separate step; the recommendation is the `e2e/**` override, since the rule's premise does not apply to Playwright locators.
