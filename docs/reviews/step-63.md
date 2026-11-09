# Step 63 — Package ready for v0.1.0

Branch: `chore/63-package-ready` · Reviewer: pending · Rounds: 0 · Status: built, not yet reviewed

The package is prepared for its first release: version 0.1.0, a README and license that ship in the tarball, the Node range of the Vite plugin, a check of what `npm pack` would upload, the changelog and the release-notes draft. Nothing is tagged or published.

## Scope

| Commit  | What                                                                                                                                                                                                                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a33f09b | `build`: version 0.1.0; `engines.node` set to Vite 8's own range, `^20.19.0 \|\| >=22.12.0` (read from `vite@8.3.5`'s package.json); the `hello.lib` version every hosting reports moves to one constant, and `test/version.test.ts` keeps it equal to package.json's. It said `0.0.0`. |
| d38482e | `docs`: `packages/tscache/README.md` for the npm page and `packages/tscache/LICENSE` (a copy of the root license); the 0.x stability note replaces the pre-release status in `README.md` and `site/index.md`.                                                                           |
| cae75d6 | `refactor`: `LIB_VERSION` sits beside `PROTOCOL_VERSION` in `rpc/protocol.ts`. In a module of its own it became a separate 0.1 kB chunk shared by the worker and the in-process hosting.                                                                                                |
| 91a8f2d | `ci`: `bun run check:pack` (`scripts/check-pack.ts`, logic in `scripts/pack-contents.ts` with its test) replaces the bare `npm pack --dry-run` in `scripts/ci.sh`. `.github/workflows/` is untouched: `ci.yml` runs `scripts/ci.sh`.                                                    |
| daf5046 | `chore`: `cliff.toml` skips `docs(review)`, `chore(size)` and merge commits and writes a header; `CHANGELOG.md` for 0.1.0 with a hand-written summary; `bun run changelog` now prepends.                                                                                                |
| 9bea65b | `docs`: `docs/releases/0.1.0.md`, the release-notes draft, with the brotli size of every entry.                                                                                                                                                                                         |

## The sideEffects check

`package.json` declares `"sideEffects": ["./dist/worker.js"]`: every other file of `dist/` may be dropped by a bundler when nothing imports a binding from it. That is safe only if no other file has a top-level statement whose effect matters.

**Static check.** Every top-level statement of each built `.js` file was parsed with `oxc-parser` (the copy tsdown already installs) and classified. Imports, exports and function declarations were skipped. Class expressions without static members were skipped too, and so were variables initialised with a literal or a function. Everything else was listed:

| File                                                                                        | Top-level code beyond declarations                                                                                                                                                                                                                  | Verdict                                                                                                                      |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `worker.js`                                                                                 | `dedicatedWorkerScope()` and the `if (dedicated) … attach(dedicated)` call; `sharedWorkerScope()` and the `connect` listener                                                                                                                        | the only effects; the file is listed in `sideEffects`                                                                        |
| `engine-*.js`                                                                               | constant tables (`FIELD_ARRAYS`, `STRUCTURAL`), reads of built-in prototypes (`typedArrayKind`, `isEnumerable`), and `static {}` blocks in `CacheState` and `Engine` that assign module-private accessors (`internalsOf`, `stateOf`, `addObserver`) | pure: no global is written; the accessors are used only inside the chunk, so dropping the whole chunk drops their only users |
| `snapshot-*.js`                                                                             | feature detection of `Uint8Array.prototype.toBase64` / `Uint8Array.fromBase64`                                                                                                                                                                      | pure reads                                                                                                                   |
| `lazy-*.js`                                                                                 | constant arrays and `new Set([...])`                                                                                                                                                                                                                | pure; the chunk is reached only through `import()`, which bundlers never drop                                                |
| `lifetime-*.js`, `types-*.js`, `index.js`, `server-*.js`, `errors-*.js`, `port-client-*.js` | constant arrays and objects; classes (`PortClient` has a static method only)                                                                                                                                                                        | pure                                                                                                                         |
| `engine.js`, `fetcher.js`, `vite.js`, `in-process-*.js`                                     | none                                                                                                                                                                                                                                                | —                                                                                                                            |

**Bundler check.** Rolldown 1.2.16 bundled `import "<dist>/worker.js"` (a side-effect-only import, as a worker entry is) with tree-shaking on. The output, 161 kB, keeps the dedicated-worker `attach` and the SharedWorker `connect` listener. As a control, the same bundle with `treeshake.moduleSideEffects: false` (every module treated as pure, as if `worker.js` were not listed) comes out empty. The check therefore tells the two apart, and the current declaration keeps the worker. A bundle of `import { Engine } from "<dist>/engine.js"` keeps the engine (76 kB).

Both checks ran by hand on the build of a33f09b and were rerun after cae75d6. They are not part of `bun run ci`. If a later change adds a top-level effect to a shared chunk, `bun scripts/size.ts` and the end-to-end tests are what would notice.

## The packed-contents check

`bun run check:pack` runs `npm pack --dry-run --json` in `packages/tscache` after the build. It fails if a required file is missing: `package.json`, `README.md`, `LICENSE`, the `types` and `default` target of every `exports` entry, or a file named in `sideEffects`. It also fails on any other file that is not `dist/<name>.js` or `dist/<name>.d.ts`, and on anything whose name marks a test, a spec, a fixture or a source map. npm 12 prints an object keyed by package name where npm 11 printed an array; the parser reads both. The tarball on this branch has 27 files, 74.1 kB packed and 247.5 kB unpacked.

## Decisions taken without the user

- **`engines` on the whole package.** npm has no per-entry `engines`, so the range covers the package. It is advisory for the browser entries, which do not run in Node.
- **Docs links in the npm README** point at the GitHub Pages site (`https://anishbenji.github.io/tscache/`), which step 65 deploys. The site is not deployed yet; 0.1.0 is published after step 65.
- **`bun run changelog` prepends** (`git-cliff --unreleased --prepend CHANGELOG.md`, used with `--tag vX.Y.Z`). The previous `-o` would have overwritten the hand-written summaries on every run.
- **`hello.lib` reports the real version.** The constant said `0.0.0` with a "replaced at build time later" note. A test now ties it to package.json instead of a build-time define, which Vitest would also need.
- **The site home page** no longer says version 1 has no persistence across page loads. `persist: true` ships (§4.10), so the line was wrong for the release.

## Not verified

- The changelog's 0.1.0 date (2026-11-09) and its commit list stop at this branch. Before the tag, regenerate the section with `bunx git-cliff --tag v0.1.0 -o CHANGELOG.md` and restore the summary. `bun run changelog` would add a second 0.1.0 section, because no tag exists yet. Step 64's `docs/releasing.md` should state this.
- `SECURITY.md` still says "pre-release"; step 62 owns that file's supported-versions table.
- The release-notes sizes are from this branch's build; later steps that change `src/` change them.
