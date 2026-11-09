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

## Pre-review — director: three P2 findings

| #   | Sev | Finding                                                                               | Decision | Resolution |
| --- | --- | ------------------------------------------------------------------------------------- | -------- | ---------- |
| P-1 | P2  | `bun run changelog` (`--prepend`) loses the blank line before the next `## [` heading | accepted | 7d512ec    |
| P-2 | P2  | README, release notes and changelog summary claim one fetch however many tabs ask     | accepted | fdec03e    |
| P-3 | P2  | The changelog lets `docs(reviews)` and `build(deps)` commits through                  | accepted | ca42b58    |

**P-1.** Reproduced in a scratch clone: after tagging `v0.1.0` and adding a `fix:` commit, `git-cliff --unreleased --prepend CHANGELOG.md --tag v0.1.1` wrote `- Something after release` directly above `## [0.1.0] - …`. git-cliff trims the rendered release (`trim = true`) and joins it to the older content with a single newline. The fix is a postprocessor, `'\n*\z'` → `"\n"`, which ends the output with exactly one newline; the prepend's own newline then makes it a blank line. The header lost its explicit trailing `\n`: with it, the header was followed by two blank lines. Checked again in a fresh clone of ca42b58 with the same steps. The new section ends with a blank line before `## [0.1.0]`, the header is followed by one blank line, and everything from `## [0.1.0]` on is byte-identical to the committed `CHANGELOG.md`. The clone was deleted afterwards. The postprocessor runs on each release before git-cliff joins them, so it does not separate releases in a full `-o` regeneration of several tagged releases. Only the 0.1.0 regeneration below uses `-o`, and it has one release.

**P-2.** The claims now follow the code. A get fetches only what its cache neither covers nor has in flight: `planRound` in `orchestrator/orchestrator.ts` subtracts the in-flight ranges and joins them. That sharing spans tabs only under the SharedWorker hosting, where every tab's port reaches one `Engine`. The dedicated and in-process hostings build one engine per tab (`entries/worker.ts`, `client/in-process.ts`). Points at or after `finalizedUntil` are never recorded as coverage (`engine/cache.ts`, `volatileFrom`; site/concepts/freshness.md), so every read that includes them fetches them again. The same wording went into `site/index.md`, which made the same claim. The root `README.md` has no such claim (its line 12 is the decision-register pointer), so it is unchanged. The auth sentence now says `authInvalid` reaches every tab _the worker serves_, which under a dedicated worker is one tab.

**P-3.** `^docs\(reviews?\)` and `^(chore|build)\(deps` replace the narrower patterns. The 0.1.0 section was regenerated with `bunx git-cliff --tag v0.1.0 -o CHANGELOG.md` and the hand-written summary put back on top.

## Codex round 1 (gate), on e083617

Verdict: merge after fixes. Pre-review P-1 and P-3 confirmed fixed. One P2.

| #    | Finding                                                                                                                                                                                                                                  | Verdict | Action                                                                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-1 | The fetch-once wording ignores the one-interval flank extension: with interval 1 and finalized `[0,10]` cached, a read of `[11,20]` requests `[10,20]`, so point 10 is fetched again (Codex confirmed it with a read-only planner call). | Valid   | Fixed in `packages/tscache/README.md`, `site/index.md`, `docs/releases/0.1.0.md` and the `CHANGELOG.md` summary: a miss is widened by one interval where it meets cached data, and that edge point is fetched again. |

## User-approved README changes (2026-11-09, relayed by the director)

| Commit  | What                                                                                                                                                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8bba585 | The fetch bullet is shortened for first-time readers. The one-interval edge and the `finalizedUntil` detail move behind a link to `site/concepts/coverage.md` ("How a read fetches"), which documents both.      |
| 4a18741 | A measured-benefit placeholder links `docs/benchmarks/demo-comparison.md` by its full GitHub URL. It states no figure; step 67 (or 65) fills it in. The file does not exist yet, so the link is dead until then. |
| 26c4675 | A "Browser support" section.                                                                                                                                                                                     |

Every claim of the new section and the shortened bullet, traced to the code and to `site/guides/workers.md`:

| Claim                                                                                     | Trace                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The order is SharedWorker → dedicated worker → in-process                                 | `packages/tscache/src/client/client.ts#CHAIN` (`["shared", "dedicated", "in-process"]`), tried in turn by `client.ts#connect`, each opened by `client.ts#open` through `client/hosting.ts#openShared`, `#openDedicated`, `#openInProcess` |
| The chain starts from `mode`, default `"shared"`                                          | `client.ts#chainFrom` (`mode ?? "shared"`, then `CHAIN.slice` from it); `src/types.ts#ClientOptions` `mode?: HostingMode`                                                                                                                 |
| `client.mode` reports the hosting it settled on                                           | `client.ts#Client` constructor, `this.mode = hosting.mode`                                                                                                                                                                                |
| Each step down emits `modeFallback` with the reason                                       | `client.ts#connect` pushes `{ from, to, reason: error.message }` per `HostingError`; the `Client` constructor emits each one on the next macrotask; payload type `src/types.ts#ClientEvents` `modeFallback`                               |
| No `SharedWorker` steps down to the dedicated worker                                      | `hosting.ts#openShared` throws `HostingError("SharedWorker is not available")` when the global is missing                                                                                                                                 |
| Chrome on Android before 148 has no `SharedWorker`, so each tab gets its own cache        | `site/guides/workers.md` ("Chrome on Android" box: "falls back to a dedicated worker per tab … each tab then has a cache of its own"); one `Engine` per dedicated worker, `src/entries/worker.ts#createServer`                            |
| Tabs share one cache when they load the same worker script                                | `hosting.ts#openShared` constructs `new SharedWorker(url, { type: "module", … })`: the browser shares a worker between same-origin pages that construct it from the same script URL                                                       |
| In-process: the engine in the page, no sharing                                            | `src/client/in-process.ts#connectInProcess` builds an `Engine` and `RpcServer` in the page's realm over a `MessageChannel`                                                                                                                |
| Only the SharedWorker hosting persists                                                    | `src/entries/worker.ts`: the dedicated worker attaches `createServer(…, clearOnly = true)`, which persists nothing; the in-process hosting uses `ClearOnlyPersistence` (`in-process.ts#connectInProcess`); N52                            |
| The worker fetches only what's missing; tabs share fetches in flight under a SharedWorker | `src/orchestrator/orchestrator.ts#planRound` (need minus coverage minus in-flight, joins the in-flight ranges); the in-flight table is per orchestrator, so shared across tabs only when they share one worker                            |

`docs/roadmap.md` (§ "Design sketch: IndexedDB persistence") says "Chrome on Android before 148". That suggests a later Chrome on Android may have `SharedWorker`, which the README, the workers guide and the troubleshooting page do not say. It is left for the user to confirm; the code takes whatever the browser exposes.

### Chrome on Android version (director, after the README changes)

The roadmap's "before 148" is correct. Chrome Platform Status lists "SharedWorker on Android" as shipping in Chrome 148 (origin trial 140 to 147), and MDN's compatibility table gives Chrome Android 148 and WebView Android 148. The README now says "Chrome on Android before version 148". `site/guides/workers.md` and the troubleshooting page still say Chrome on Android has none; step 60 corrects them.

## Codex round 2 (gate), on 9fc1d25

Verdict: merge. No findings; P-1, P-2, P-3 and R1-1 confirmed fixed. Settled.
