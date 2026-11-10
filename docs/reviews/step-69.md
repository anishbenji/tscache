# Step 69 — Fetcher import under webpack-family bundlers, error names under minification

Branch: `fix/69-fetcher-import-bundlers` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: settled · Verdict after triage: merge

Two findings from a review of the repository in November 2026, backed by the bundler probe recorded below. The in-process hosting loads the fetcher with `import(module)`, which carried only a Vite hint; webpack 5 and Rspack replace such an import with an empty context that always rejects, and Turbopack with a stub that throws, so `createClient` with a fetcher rejected on the in-process hosting in those builds. Separately, `TscacheError` named every instance with `new.target.name`, which a minifier renames.

## Scope

Commits are named by subject, so a rebase cannot make this table wrong.

| Commit                                                                  | What                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fix: keep webpack-family bundlers off the fetcher import                | `/* webpackIgnore: true */` beside `/* @vite-ignore */` on the fetcher import (`orchestrator/orchestrator.ts`). `test/bundler-hints.test.ts` pins both hints and that this is the only `import()` of a non-literal specifier in `src/`. Paragraphs in `site/guides/workers.md` and `docs/guides/worker-setup.md`, and a line in `site/troubleshooting.md`. |
| fix: keep documented error names through minification                   | Each exported error class in `errors.ts` writes its documented name as a literal. Tests in `test/errors.test.ts` simulate a minifier by redefining each constructor's `name`.                                                                                                                                                                              |
| docs(review): step 69 scope and verification                            | This file.                                                                                                                                                                                                                                                                                                                                                 |
| fix: keep the HostingError name through minification                    | The same treatment for `HostingError` (`client/hosting.ts`), which is not exported but is what `createClient` rejects with at the end of the fallback chain; `nameFor` is exported from `errors.ts` for it. Added to the minification cases.                                                                                                               |
| test: keep a commented literal import out of the hint scan              | The scan no longer reports `import(/* x */ "./lit")` as non-literal; the matcher has cases of its own.                                                                                                                                                                                                                                                     |
| docs: say what the bundler probe verified without citing an absent file | The guides describe the probe instead of naming the review file, which is not in the repository.                                                                                                                                                                                                                                                           |
| docs(review): step 69 pre-review triage                                 | The evidence table, the class inventory and the pre-review section below.                                                                                                                                                                                                                                                                                  |

## Decisions taken

- **No bundler in CI (user decision 31, option A).** A smoke test that builds with webpack, Rspack or Next.js would need new dev dependencies, which is parked as user decision 31. This branch takes the no-dependency option: the hint is pinned by a source-text test, and the guides state what was verified and by whom.
- **Source-text test for the hints.** The magic comments are instructions to bundlers and have no runtime behaviour to assert, so the test reads the `.ts` sources. It scans all of `src/` rather than one file, so a second non-literal `import()` without hints also fails it. A hand search agrees: `grep -rn "import(" packages/tscache/src` finds, besides prose in comments and the `#import(` method, only the call at `orchestrator.ts:339`.
- **Error names: a literal per class, decided by the constructed class.** A class field `override name: string = nameFor(this, ConfigError, "ConfigError")` on each class (the constructor body for `TscacheError`). When the instance is constructed by that class, the name is the literal from architecture §2.6; when it is constructed by a subclass outside the library, the name is that subclass's own `constructor.name`, which is the behaviour before this change (a test pins it). An application that minifies its own subclasses owns those names. Class fields keep the module free of top-level statements, so unused classes still tree-shake, and `errors.ts` stays import-free. The wire table in `rpc/protocol.ts` already names errors by `instanceof` and is unchanged.
- **Every error class in `src/` pins its name.** `grep -rn "extends .*Error" packages/tscache/src` finds eight classes: `TscacheError`, `ConfigError`, `InvalidRangeError`, `UnknownCacheError`, `PutError`, `ProtocolMismatchError` and `AuthInvalidError` in `errors.ts`, and `HostingError` in `client/hosting.ts`. All eight now name themselves with a literal through `nameFor`, and all eight are in the minification cases of `test/errors.test.ts`.

## Evidence: bundler probe of 2026-11-10

Run by hand outside the repository, against the built package packed with `npm pack`, on Node v26.13.0 and macOS. The patched copy differed from the unpatched one in one line: the fetcher import in `dist/server-<hash>.js` carried `/* @vite-ignore */ /* webpackIgnore: true */`. The fetcher returned the grid points of the requested range (3 points). A control without a bundler, in-process, returned the 3 points.

| Bundler and version                                      | Case                                                                                                                | Build, unpatched                                                                      | Runtime, unpatched                                                                                                    | With the hint                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| webpack 5.112.2, copy-dist recipe                        | Browser, `shared` and `dedicated`                                                                                   | Succeeds, warning "Critical dependency: the request of a dependency is an expression" | Works: 3 points, console clean                                                                                        | Works                                                             |
| webpack 5.112.2, `target: node22`                        | `mode: 'in-process'` with a fetcher                                                                                 | Succeeds, same warning                                                                | `createClient` rejects: "fetcher module file://…/fetcher.js failed to load: Cannot find module 'file://…/fetcher.js'" | Builds without the warning; 3 points                              |
| Rspack 2.3.2                                             | Browser and Node, as webpack                                                                                        | Succeeds, same warning in both targets                                                | As webpack: workers work, in-process rejects with "Cannot find module"                                                | Builds without the warning; 3 points                              |
| Next.js 16.4.6 (Turbopack), React 19.3.1                 | Client component with the copied worker; route handler, dynamic page and prerendered page in-process with a fetcher | Succeeds, no warning                                                                  | Client works (`shared`); server paths reject: "failed to load: Cannot find module as expression is too dynamic"       | Server paths, shared worker and forced in-process client all work |
| Next.js 16.4.6, `next build --webpack`                   | As above                                                                                                            | "Compiled with warnings"                                                              | Same split: client works, server rejects with "Cannot find module"                                                    | Not run separately                                                |
| Headless Chromium, the webpack and Rspack browser builds | Forced `mode: 'in-process'`                                                                                         | —                                                                                     | Rejects with "Cannot find module"                                                                                     | 3 points                                                          |

For Next.js server code only, `serverExternalPackages: ["@anishbenji/tscache"]` also made the server paths work without the hint. Under the minified Next.js builds the probe saw error names arrive as `r`, `b`, `e`, `t` and `o`.

## Verification

- `bunx vitest run packages/tscache/test/bundler-hints.test.ts` before the source change: the hint test failed with `expected '/* @vite-ignore */' to contain '/* webpackIgnore: true */'`; after it, 2 passed.
- `bunx vitest run packages/tscache/test/errors.test.ts` before the `errors.ts` change: the seven minification cases failed (`expected 'r' to be 'ConfigError'`, and so on for each class); the subclass case passed, confirming the existing behaviour it pins. After: all pass.
- `bun run build`, then `grep -n -A2 "await import" packages/tscache/dist/server-CUlXN0NT.js`: line 338 is `loaded = await import(`, followed by `/* @vite-ignore */` and `/* webpackIgnore: true */` on lines 339–340.
- By hand, a consumer bundle minified with `bun build --minify --target=browser` over `dist/index.js`: constructors arrived as `e`, and `error.name` printed `ConfigError`, `PutError`, `AuthInvalidError`, `TscacheError`.
- `bunx vitest run packages/tscache/test/errors.test.ts` with `HostingError` added to the cases, before its fix: `expected 'r' to be 'HostingError'`; after, 17 passed.
- `bunx vitest run packages/tscache/test/bundler-hints.test.ts` with the matcher cases, before the pattern change: `import(/* x */ "./lit")` gave `[ '' ]` instead of `[]`; after, 5 passed.
- `bunx vitest run packages/tscache/test`: all files pass on the final head.
- `bun run typecheck`: exit 0. `bunx biome check .`: no errors (one existing warning in `e2e/examples/react-lwcharts.spec.ts`, untouched here).
- `bun run ci` through the heavy-job lock on the final head: see the report for the result.

## Not verified

- No webpack, Rspack or Next.js build was run on this branch. The claim that the hint fixes those builds rests on the probe above, which patched a copy of `dist/` (webpack 5.112.2, Rspack 2.3.2, Next.js 16.4.6 with Turbopack; under `next build --webpack` only the unpatched failure was observed).
- Minified error names were checked with Bun's minifier only, not with Terser, SWC or the Next.js production build the probe used.
- A fetcher that has imports of its own, or is written in TypeScript, under webpack or Rspack; `next dev`; the edge runtime.

## Pre-review (Claude), not the gate

| #    | Sev | Finding                                                                                            | Decision | Resolution                                                                                                                                                |
| ---- | --- | -------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-1 | P2  | `HostingError` loses its name when minified; `createClient` rejects with it and it is not exported | accepted | fix: keep the HostingError name through minification                                                                                                      |
| PR-2 | P2  | This file and `docs/guides/worker-setup.md` cite a review file that is not in the repository       | accepted | docs: say what the bundler probe verified without citing an absent file; the probe table is in "Evidence" above (docs(review): step 69 pre-review triage) |
| PR-3 | P2  | The Scope table names commits by hashes from before the rebase                                     | accepted | Scope names commits by subject (docs(review): step 69 pre-review triage)                                                                                  |
| PR-4 | nit | The hint scan reports `import(/* x */ "./lit")` as a non-literal import                            | accepted | test: keep a commented literal import out of the hint scan                                                                                                |

## Round 1 — reviewer verdict: merge

No findings (2026-11-10). The reviewer confirmed the pre-review findings PR-1 to PR-4 are fixed, ran the error and bundler-hint tests (22 passed) and the type check; it did not rerun the webpack, Rspack or Next.js builds.

| #   | Sev | Finding | Decision | Resolution |
| --- | --- | ------- | -------- | ---------- |
| —   | —   | None    | —        | —          |

## Contract-test changes

None.

## Decision concerns

None.
