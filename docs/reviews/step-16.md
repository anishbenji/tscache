# Step 16 — `tscache/vite` entry

Branch: `feat/16-vite-entry` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: review loop in progress · Verdict after triage: —

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
| V3 | Build platform | The same browser-platform tsdown build as the other entries: the plugin uses no Node API, so the agenda's separate Node-platform entry is unnecessary | A second tsdown config with `platform: "node"` |

## Contract-test changes

None: not an engine step.

## Decision concerns

None yet.
