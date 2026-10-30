# Docs 29 — User documentation site

Branch: `docs/29-docs-site` · Reviewer: not yet reviewed · Rounds: 0 · Status: awaiting review · Verdict after triage: pending

Comprehensive documentation for library users, as a site in its own Bun workspace (`site/`), with an API reference generated from the TSDoc and a build check in `bun run ci`. Built by a Claude Opus 5.5 subagent while the user was away, under the user's grant of 2026-10-30; not a commit-plan step. No engine behaviour changes: the only edits under `packages/tscache/src` are TSDoc comments.

## Scope

| Commit | What |
|---|---|
| 67d4665 | `docs(api)`: a `@module` TSDoc block on the `tscache`, `tscache/engine`, `tscache/fetcher` and `tscache/vite` entries, so the reference names modules after their import paths; `RequestId`'s comment puts its pattern in backticks (raw `<clientId>` broke the VitePress build); `Engine.get`'s comment no longer says orchestration arrives at step ⑪ |
| 9f47a2f | `build(site)`: the `site/` workspace (VitePress, TypeDoc with typedoc-plugin-markdown and typedoc-vitepress-theme, TypeScript 6 under an alias for TypeDoc), its config with the repository-link check, `docs:dev`, `docs:build` and `docs:check` root scripts, `bun run ci` steps, Knip and Fallow configuration; the pages and the compiled code examples |
| feb2595 | `docs`: the README links the site |
| (this commit) | `docs(review)`: this file |

Pages: getting started; concepts (coverage and gaps, the grid and `alignmentOffset`, segments and slots, versions and watermarks, invalidation and clearing, events in three scopes); the API by example (client, cache, snapshots, fetcher module, engine, errors) beside the generated reference; guides (workers and fallback, writing a fetcher, the Vite plugin and its static-import rule, credentials and `tscache:auth-invalid`, server rendering, live feeds by SSE, WebSocket and polling, expiry and other patterns); vanilla, React, Solid and chart libraries; performance (a summary of `docs/benchmarking.md`); troubleshooting and FAQ; an architecture map for contributors. The internal documents (`docs/architecture.md`, `docs/workflow.md`, `docs/reviews/`, `docs/review-checklist.md`, `docs/guides/`) stay where they are; the site links to them on GitHub.

## How the checks work

- **Code examples compile.** Every example is a region of a TypeScript file in `site/snippets/`, included with `<<< @/snippets/file.ts#region`; `bun run docs:check` (`tsc -p site`, TypeScript 7 from the root) type-checks them against the built package, as `check:integrations` does for the integration snippets. Pages also include whole files from `integrations/`, `examples/` and `reference/`, which their own checks compile. Short configuration blocks (webpack, a shell command, a JSON-like interface listing) stay inline.
- **Dead links fail the build.** VitePress fails on a dead link between pages, including the generated reference. A link to a repository file is a GitHub URL, which VitePress does not check, so a markdown-it rule in `site/.vitepress/config.ts` fails the build when the file is missing from the working tree. A missing include or region fails the build too.
- **The reference is generated.** `typedoc` runs before every `docs:dev` and `docs:build`, into `site/api/` (gitignored), with `treatWarningsAsErrors`.

Verified by hand: a page with a link to `/guides/nowhere` failed the build ("1 dead link(s) found"); a link to `https://github.com/anishbenji/tscache/blob/main/docs/nowhere.md` failed it ("links to docs/nowhere.md, which is not in the repository"); an include of a missing file and of a missing region each failed it. The test page was then removed.

The in-process snippets (`cache.ts`, `engine.ts`, `grid.ts`) were run under Bun against the built package once, and the values their comments state (the `PutError` fields, coverage, the snapped range) match the output.

## Decisions made in the step

Taken by the subagent under the grant (logged for the user).

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | VitePress `2.0.0-alpha.21`, pinned exactly | It runs on Vite 8, the repository's Vite; the stable 1.6.4 (August 2025) needs Vite 5, which is end-of-life | VitePress 1.6.4 (stable, but a second, unsupported Vite major in the lockfile) |
| D2 | TypeDoc 0.28.20 with typedoc-plugin-markdown 4.14.1 and typedoc-vitepress-theme 1.1.4; `typescript` aliased to `npm:typescript@6.0.3` in `site/` only | TypeDoc supports TypeScript up to 6.0 and needs a JS API that TypeScript 7 lacks (AGENTS.md toolchain rule); Bun's isolated install resolves TypeDoc's peer to the alias | Generating from `dist/*.d.ts` (still needs the compiler API) |
| D3 | Examples as compiled snippet files, included by region | Simplest robust option: plain `tsc`, no new dependency, the same pattern as `integrations/` | VitePress twoslash (another dependency and the TypeScript JS API at build time, so TS 6 again; slower builds) |
| D4 | `tscache/worker` left out of the reference | It is a worker script; its one export, `createServer`, is for the package's tests | Documenting it, or marking `createServer` `@internal` |
| D5 | `intentionallyNotExported` for `CacheEvent`, `Context` and `OutputChunkLike` | They are internal shapes named by public signatures; exporting them would change the API surface | Exporting them |
| D6 | `docs:check` and `docs:build` in `scripts/ci.sh` after `check:integrations`; not added to pre-push | The task asks for the CI gate; the build takes a few seconds and pre-push already runs the snippet-style integration check | Adding both to the pre-push `built` group |
| D7 | Repository files linked on GitHub (`blob/main`), anchors unchecked | The site has no copy of those files; anchors into GitHub's rendering are not knowable at build time, so pages link to files and name sections in text | Copying the internal documents into the site |
| D8 | The site restates `docs/guides/worker-setup.md` and `patterns.md` rather than moving them | The task keeps internal docs in place; the README and architecture link them | Moving the guides into the site and linking there from the README |
| D9 | No base path, no deploy, no demo page | Out of scope per the task | — |

## Dependencies added

All dev dependencies of the private `site/` workspace, pre-approved: `vitepress` (the site), `typedoc`, `typedoc-plugin-markdown`, `typedoc-vitepress-theme` (the reference), `typescript` as `npm:typescript@6.0.3` (TypeDoc's compiler), and `vite` `^8.3.4` (the Vite config snippet imports `defineConfig`; the same version the examples use). `tscache` is a `workspace:*` dependency for the snippets. Nothing changes for the published package.

## Found while writing

Discrepancies between the code and other documents, not fixed here (outside a docs branch's scope); the site describes the code.

1. **No `console.warn` for merge warnings.** Resolved decision #8 and architecture §2.7 say an overlap difference is also logged with `console.warn` in dev builds; `packages/tscache/src` has no `console` call. The site documents the `mergeWarning` event and `put()`'s `warnings` only. Either the warning is implemented or the decision text is amended: a decision for the user.
2. **Stale limits in the integration READMEs.** `integrations/README.md` ("Limits every variant shares") and `integrations/solid/README.md` still say a seed carries no dataset version and that closing the seed race needs a snapshot API, which step ⑮ added (`hydrate`).

## Contract-test changes

None.

## Decision concerns

None.
