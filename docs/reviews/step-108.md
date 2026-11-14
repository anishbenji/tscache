# Step 108 — a size measurement stable against chunk-hash and comment noise

Branch: `chore/108-stable-size` · Reviewer: GPT-6.1 Sol · Rounds: 0 · Status: built, awaiting review

## Scope

User decision 64 B (2026-11-15), as recorded in the director's resolved decisions: step 104 raised the `index:lazy` budget after a comment-only change (step 96) failed the size check, and "a later step for a measurement stable against chunk-hash and comment noise (normalised chunk names or a better approach), as a Never-path PR for the user". This step is that measurement. It touches `scripts/size.ts`, on the protected-path Notify list, and adds `scripts/size-measure.ts`, which now holds the measurement that `scripts/size.ts` held; the list names neither the new file nor any change to `scripts/ci.sh`, `packages/tscache/tsdown.config.ts` or another Never path, and this step changes none of those. `packages/tscache/bench/budgets.json` is unchanged.

## Investigation

How the measured bytes depended on comments and hashes, found by building `main` twice, once with a comment-only edit to `packages/tscache/src/engine/merge.ts`, and diffing the minified bundles `scripts/size.ts` compresses:

- **Comments do not ship to users and never reached the minified bundles.** `packages/tscache/tsdown.config.ts` sets no minification, so `dist/` (and the npm tarball) keeps the source's comments. `scripts/size.ts` measures each entry as an application's production bundle carries it: bundled with `Bun.build({ minify: true })`, which drops every comment except legal ones (`/*!`, `@license`, `@preserve`); the package source has none. The minified bundles of both builds contained no comment.
- **Hashes did reach them.** tsdown names a shared chunk `<name>-<8-character hash>.js`, the hash covering the chunk's content, comments included. The edit to a doc comment above a function in `merge.ts` changed the hashes of `engine-*.js`, `lazy-*.js`, `server-*.js` and `in-process-*.js` (a chunk's hash changes with the names of the chunks it imports). A measured bundle leaves some chunks out (the lazy chunks from an entry's row, the files an entry already holds from its lazy rows) and keeps their names in its import strings: five of the eight bundles differed, and each differed in exactly one import string, such as `import("./lazy-IeRyiNQd.js")` against `import("./lazy-CGNI4tAk.js")`. The minified sizes were equal; brotli and gzip compress different hash characters to a few bytes more or less. In the table of `bun scripts/size.ts`, `index (lazy)` and `worker` went up by 0.01 kB, `index (lazy, nested)` and `worker (lazy)` down by 0.01 kB.
- **A comment above a module's first statement leaves `dist/` unchanged.** The first trial edited the file header of `merge.ts`, which tsdown drops; no hash changed. Step 96's edits were to comments that tsdown keeps.

## Approach

Of the options in the brief:

- **A: replace the hash in each left-out chunk's import string with a constant (chosen).** A one-function change to how a bundle leaves a chunk out: the plugin that marks a chunk external now names it `<name>-00000000.js`. It keeps measuring what users download: an application's bundler names the chunks it emits itself, so the package's hashes never reach its users, and the constant keeps the name's length, so the minified sizes are unchanged and only a few bytes of compression noise go. It changes no build configuration and no budget.
- **B: measure a build with comments stripped.** Would need a second tsdown configuration or a post-processing step, measures a build nobody ships, and still leaves the hashes, which change with any code edit too. Rejected.
- **C: rewrite import strings in the minified output with a regular expression.** Same effect as A, but parses generated code instead of naming the external at the point the bundler resolves it. Rejected for A.

So that the measurement can be tested, the code that measures moves unchanged from `scripts/size.ts` into `scripts/size-measure.ts`, with the dist directory as a parameter instead of a module constant and no side effect on import; `scripts/size.ts` keeps the budgets, the table and `--update`. The renamed chunk is checked: a left-out file not named `<name>-<8 characters>.js` (if tsdown changed its naming) or two left-out chunks that would get the same name fail the check with a message, instead of measuring something else.

## Test first

`scripts/size-measure.test.ts` writes fixture packages: an entry that imports a shared chunk and loads a lazy chunk with `import()`, which loads a nested chunk in turn, so each of the three measured rows names a hashed chunk in an import string. Vitest runs under Node, which has no `Bun.build`; the test measures in a Bun process, as `packages/tscache/test/base64.test.ts` does for its Bun-only check. It asserts that a rebuild with other hashes, and a comment-only edit with the hashes it brings, measure exactly the same minified, gzip and brotli bytes on every row, and that a code change does not. Before the fix, the hash-only rename failed it: brotli 107 against 94 B on the initial row, 124 against 116 B lazy, 87 against 75 B nested. After the fix it passes, with two further tests for the two failure messages.

## Re-measured

Brotli bytes on the build of `main` at `a7f01ba`, before and after the change (minified bytes are identical in every row):

| Row                    | Before |  After | Change | Budget |
| ---------------------- | -----: | -----: | -----: | -----: |
| `index`                |  4,732 |  4,721 |    −11 |  5,008 |
| `index (lazy)`         | 12,454 | 12,415 |    −39 | 12,976 |
| `index (lazy, nested)` |  5,505 |  5,485 |    −20 |  6,000 |
| `worker`               | 13,665 | 13,663 |     −2 | 13,728 |
| `worker (lazy)`        |  5,505 |  5,485 |    −20 |  5,824 |
| `engine`               | 10,099 | 10,099 |      0 | 10,272 |
| `fetcher`              |    178 |    178 |      0 |    656 |
| `vite`                 |  1,228 |  1,228 |      0 |  1,488 |

`engine`, `fetcher` and `vite` leave no chunk out and do not change. Every row stays within its budget and moves down, so no budget changes: the method requires none, and lowering budgets to the new sizes is not part of decision 64 B. `index (lazy)` keeps the 512 B of room step 104 gave it; `worker` keeps 65 B.

With the change, the comment-only edit to `merge.ts` measured the same bytes on every row as `main` (the JSON of every row's minified, gzip and brotli bytes compared equal), although the edit changed four chunk hashes.

`docs/benchmarking.md` (Exact budgets) now says how the size check treats comments and hashes, and its size row carries these measurements.

## Verification

- `bunx vitest run scripts/size-measure.test.ts`: failed before the fix (the hash-only rename), 3 passed after.
- A comment-only edit to `packages/tscache/src/engine/merge.ts`, built and measured, then undone with an edit and measured again: identical bytes on every row.
- `bun scripts/size.ts` passes.
- `bun run ci` exits 0 on the branch head.

## Contract-test changes

None.

## Decision concerns

None.
