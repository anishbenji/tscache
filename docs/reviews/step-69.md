# Step 69 — Fetcher import under webpack-family bundlers, error names under minification

Branch: `fix/69-fetcher-import-bundlers` · Reviewer: — · Rounds: 0 · Status: built · Verdict after triage: —

Two findings from the November 2026 review (`docs/reviews/2026-11-review.md`, §3h and L2). The in-process hosting loads the fetcher with `import(module)`, which carried only a Vite hint; webpack 5 and Rspack replace such an import with an empty context that always rejects, and Turbopack with a stub that throws, so `createClient` with a fetcher rejected on the in-process hosting in those builds. Separately, `TscacheError` named every instance with `new.target.name`, which a minifier renames.

## Scope

| Commit  | What                                                                                                                                                                                                                                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| b20fde0 | `fix`: `/* webpackIgnore: true */` beside `/* @vite-ignore */` on the fetcher import (`orchestrator/orchestrator.ts`). `test/bundler-hints.test.ts` pins both hints and that this is the only `import()` of a non-literal specifier in `src/`. Paragraphs in `site/guides/workers.md` and `docs/guides/worker-setup.md`, and a line in `site/troubleshooting.md`. |
| 8d6440e | `fix`: each exported error class in `errors.ts` writes its documented name as a literal. Tests in `test/errors.test.ts` simulate a minifier by redefining each constructor's `name`.                                                                                                                                                                              |

## Decisions taken

- **No bundler in CI (user decision 31, option A).** A smoke test that builds with webpack, Rspack or Next.js would need new dev dependencies, which is parked as user decision 31. This branch takes the no-dependency option: the hint is pinned by a source-text test, and the guides state what was verified and by whom.
- **Source-text test for the hints.** The magic comments are instructions to bundlers and have no runtime behaviour to assert, so the test reads the `.ts` sources. It scans all of `src/` rather than one file, so a second non-literal `import()` without hints also fails it. A hand search agrees: `grep -rn "import(" packages/tscache/src` finds, besides prose in comments and the `#import(` method, only the call at `orchestrator.ts:339`.
- **Error names: a literal per class, decided by the constructed class.** A class field `override name: string = nameFor(this, ConfigError, "ConfigError")` on each class (the constructor body for `TscacheError`). When the instance is constructed by that class, the name is the literal from architecture §2.6; when it is constructed by a subclass outside the library, the name is that subclass's own `constructor.name`, which is the behaviour before this change (a test pins it). An application that minifies its own subclasses owns those names. Class fields keep the module free of top-level statements, so unused classes still tree-shake, and `errors.ts` stays import-free. The wire table in `rpc/protocol.ts` already names errors by `instanceof` and is unchanged.

## Verification

- `bunx vitest run packages/tscache/test/bundler-hints.test.ts` before the source change: the hint test failed with `expected '/* @vite-ignore */' to contain '/* webpackIgnore: true */'`; after it, 2 passed.
- `bunx vitest run packages/tscache/test/errors.test.ts` before the `errors.ts` change: the seven minification cases failed (`expected 'r' to be 'ConfigError'`, and so on for each class); the subclass case passed, confirming the existing behaviour it pins. After: all pass.
- `bun run build`, then `grep -n -A2 "await import" packages/tscache/dist/server-CUlXN0NT.js`: line 338 is `loaded = await import(`, followed by `/* @vite-ignore */` and `/* webpackIgnore: true */` on lines 339–340.
- By hand, a consumer bundle minified with `bun build --minify --target=browser` over `dist/index.js`: constructors arrived as `e`, and `error.name` printed `ConfigError`, `PutError`, `AuthInvalidError`, `TscacheError`.
- `bunx vitest run packages/tscache/test`: 93 files, 1942 tests passed.
- `bun run typecheck`: exit 0. `bunx biome check .`: no errors (one existing warning in `e2e/examples/react-lwcharts.spec.ts`, untouched here).
- `bun run ci` through the heavy-job lock on the final head: see the report for the result.

## Not verified

- No webpack, Rspack or Next.js build was run on this branch. The claim that the hint fixes those builds rests on the review probe, which patched a copy of `dist/` (webpack 5.112.2, Rspack 2.3.2, Next.js 16.4.6 with Turbopack and with `--webpack`).
- Minified error names were checked with Bun's minifier only, not with Terser, SWC or the Next.js production build named in the review.
- A fetcher that has imports of its own, or is written in TypeScript, under webpack or Rspack; `next dev`; the edge runtime.

## Contract-test changes

None.

## Decision concerns

None.
