# Step 16 — `tscache/vite` entry

Branch: `feat/16-vite-entry` · Reviewer: GPT-6.1 Sol (high) · Rounds: 2 · Status: review loop in progress · Verdict after triage: —

Item 2 of the post-build architecture review (`docs/architecture-review.md`; decisions N40–N41). Not an engine step: tests are written with the code.

## Scope

| Commit | What |
|---|---|
| b7ce23a | `feat(vite)`: `src/vite/fetcher-url.ts` and the `./vite` entry exporting `fetcherUrl()` and its `FetcherUrlPlugin` type; `vite ^8.0.0` as an optional peer dependency and `^8.3.4` as a dev dependency (the version the examples already use); the tsdown entry; `test/vite-fetcher-url.test.ts` runs real client, server and dev builds; Knip and Fallow configuration; architecture §4 layout and export list |
| 24b624c | `refactor(examples)`: every example imports `fetcherUrl` from `tscache/vite`; the mock backend's copy goes |
| affb818 | `docs(guides)`: `docs/guides/worker-setup.md` replaces the forty-five-line copy with the import; roadmap pointer |

## Points for the user

| # | Point | Done (recommended) | Alternatives |
|---|---|---|---|
| V1 | Supported Vite range (N40 left it to this step) | `^8.0.0`: the one major the test and the examples build with. Widening later is not breaking | `^6.0.0 \|\| ^7.0.0 \|\| ^8.0.0`, since the environments API the plugin uses exists from Vite 6, but nothing here tests 6 or 7 |
| V2 | How the plugin is typed | A structural type (`FetcherUrlPlugin`) declaring the hooks and context members it uses; nothing imported from `vite`. Vite's types reference Node's, so importing them would put Node globals into the package's type check and let Node APIs into the browser library unnoticed (the guard `batch-realms.test.ts` relies on). The examples' type check of their `vite.config.ts` against Vite's real `Plugin` type proves the fit, and `dist/vite.d.ts` references neither Vite nor Node | Import `type { Plugin } from "vite"`: exact types for users, but Node types throughout `src/` and `test/` |
| V3 | Build platform | Withdrawn after round 1 (R1-1): the entry now has its own `platform: "node"` tsdown config, as N40 states | — |

## Round 1 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | The entry shares the browser-platform build, where N40 says a Node-platform entry, without recorded approval | accepted | Validated against the N40 row. Rather than ask for the deviation, the build now has a second tsdown config with `platform: "node"` and plain `.js` output for `./vite`; tsdown cleans `dist/` once for both configs before either writes (checked in its source) |
| R1-2 | P1 | In dev, the URL ignores Vite's `base`, so a normal dev server under `/app/` answers 404 | accepted | Reproduced with a real dev server under `/app/` that requests the URL over HTTP (the earlier test used middleware mode, which bypasses the base check). The browser now gets `<base>@fs/<path>` |
| R1-3 | P1 | A Windows path `C:/…` gives `/@fsC:/…` | accepted | Validated by reading; `devUrl(base, file)` now builds the URL with exactly one slash before the path, with unit cases for POSIX and drive paths |
| R1-4 | P1 | An installed `tscache` is externalized in dev SSR, so its `import()` of the `/@fs/` URL runs in plain Node and fails | accepted | Reproduced with a stand-in `node_modules/tscache` whose `import()` loads the fetcher under `ssrLoadModule`: "Cannot find module '/@fs/…'". The plugin's `config` hook now adds `tscache` to `ssr.noExternal`, so the import goes through Vite's module runner; server code keeps the `/@fs/` path without the base, which the runner resolves. The guide says so |

Commit note: the Node-platform tsdown config of R1-1 landed in the round 1 triage commit (99a6f21) rather than its own, because its own commit was refused by commitlint and the file stayed staged. The branch was already under review, so the history was left as it is.

## Round 2 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P1 | A literal `%` in the checkout path breaks the dev URL: `/repo/a%20b` is requested as `/repo/a b` | accepted; area redesigned | Reproduced with the fetcher in a directory named `lib %41`. **Convergence check:** dev-URL construction drew findings in rounds 1 and 2, so the area was redesigned rather than patched. Delegating to Vite's own `?url` import was tried first and failed: Vite turns `lib %41` into `lib%20A`. Probes then fixed the design on evidence: Vite's module middleware decodes with `decodeURI`, so the browser gets `<base>@fs/` + `encodeURI(path)`, its exact inverse; Vite's module runner does not decode at all, so server code gets the plain absolute path (also free of the Windows `/@fs` slash). The virtual module's id no longer embeds the path either: Vite puts ids into URLs unencoded and decodes the request, which failed with a 500 for the same directory. The test now keeps the fetcher outside the app's root in that directory and checks the URL and its fetch over a real dev server under a base, the runner's load, and the installed-package case. A path holding `#` or `?` cannot be served by Vite's middleware at all; the code says so |

Observed while verifying: one CI run timed out an unrelated heavy test (`merge-failures.test.ts`, 5 s) while the new Vite builds ran in the same Vitest pool; the rerun passed. Recorded as a load risk, not changed.

## Contract-test changes

None: not an engine step.

## Decision concerns

None yet.
