# Step 87 — Release prep for 0.1.0

Branch: `docs/87-release-prep` · Reviewer: GPT-6.1 Sol · Rounds: — · Status: open · Verdict after triage: —

## Scope

User decision 49 A (2026-11-13): run release prep on today's `main`. The 0.1.0 rehearsal of 2026-11-11 passed but found two things stale on the commit that will be tagged: `CHANGELOG.md` was generated on 9 November, and the size table in `docs/releases/0.1.0.md` predates several fixes. This step follows `docs/releasing.md`, "Cutting a release", step 1, for version 0.1.0. It changes no code, workflow or protected path, and runs nothing on GitHub.

| Commit (by subject)                                              | What                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs: regenerate the 0.1.0 changelog and summarize the release` | `CHANGELOG.md` regenerated with git-cliff, and the hand-written summary above the generated list rewritten for 0.1.0 as of this `main`.                                                                        |
| `docs: re-measure the 0.1.0 sizes and state its known limits`    | The size table and tarball figures in `docs/releases/0.1.0.md`, a Known limits section and a strict-field-values highlight there; the same sizes in `site/performance.md`; the notes' size in `docs/INDEX.md`. |
| `docs(review): step 87 scope and verification`                   | This file, and the review-file count and size in `docs/INDEX.md`.                                                                                                                                              |

**Version.** `packages/tscache/package.json` already says `"version": "0.1.0"`; it was not changed.

**Changelog.** `bunx git-cliff --tag v0.1.0 -o CHANGELOG.md` (git-cliff 2.14.2, a dev dependency already; `cliff.toml` unchanged). The repository has no tag, so the whole history becomes release 0.1.0, dated 2026-11-13. It covers the first commit, `docs: add starter prompt and repo seed` (2026-06-11), through `docs(review): step 74 round 3, settled` (2026-11-13), the last non-merge commit before this branch; `cliff.toml` skips merge, review-triage, size-budget and dependency commits, and git-cliff reports 133 commits skipped as unconventional (the merge commits among them). The generated list only gains lines against the 9 November file. git-cliff writes scope markers as `*(scope)*`; they were rewritten to `_(scope)_`, the style the committed file used. The summary above the list:

- folds in the former `[Unreleased]` section: field-value validation (N68), the snapshot watermark rule for `hydrate` (N69) and `PutError.offenderField`. As 0.1.0 is the first release, they are described as behaviour, not as breaking changes;
- adds the changes since 9 November found in the commits under `packages/tscache/src`: the handshake timer stopped at hello (`fix(client): stop the handshake timer at hello`) and the lifetime-lock watch from hello (`fix(client): watch the lifetime lock from hello`); error names kept through minification (`fix: keep documented error names through minification`, `fix: keep the HostingError name through minification`); the webpack-family fetcher import (`fix: keep webpack-family bundlers off the fetcher import`, with `site/guides/workers.md`, webpack 5 and Rspack, for Turbopack); the failed-put prefix (N70, `docs(decisions): n70, what a failed put leaves behind`);
- states the persisted cache's restore by a new worker (`docs(site): a new worker restores the persisted caches`; `site/guides/persistence.md`, What is stored) and the three known limits (`docs: state three known limits of 0.1.0 in the guides`; `site/index.md`, Known limits).

**Sizes.** Measured on this branch's base after `bun install --frozen-lockfile` and `bun run build`, with `bun run size` (`scripts/size.ts`, brotli):

| Entry (release notes row)       | Notes before |      Now | Changed |
| ------------------------------- | -----------: | -------: | ------- |
| `@anishbenji/tscache`           |      4.42 kB |  4.57 kB | yes     |
| ↳ lazy: in-process hosting      |     11.90 kB | 12.16 kB | yes     |
| ↳ lazy, nested: clear-only call |      5.38 kB |  5.38 kB | no      |
| `@anishbenji/tscache/worker`    |     13.01 kB | 13.34 kB | yes     |
| ↳ lazy: persistence             |      5.38 kB |  5.38 kB | no      |
| `@anishbenji/tscache/fetcher`   |      0.14 kB |  0.17 kB | yes     |
| `@anishbenji/tscache/engine`    |      9.52 kB |  9.86 kB | yes     |
| `@anishbenji/tscache/vite`      |      1.20 kB |  1.20 kB | no      |

Every entry is within its budget. `index (lazy)` is the closest, at 12.16 kB against 12.17 kB. The rehearsal measured `index` 4.55 kB, in-process 11.91 kB, worker 13.07 kB and engine 9.58 kB on `main` of 11 November; the library commits merged since then (N68 among them) landed after that measurement. Which commit added how much was not measured.

`npm pack --dry-run` in `packages/tscache`: 27 files, 76.5 kB packed, 255.2 kB unpacked (the rehearsal: 27 files, 75.3 kB, 251.5 kB). The notes did not give these before; they now do, in the paragraph after the table. `bun run check:pack` passes.

**Notes checked against this `main`.** Besides the sizes:

- The notes said `@anishbenji/tscache/vite` "declares" Vite 8's Node range. The range is the whole package's `engines` field (`packages/tscache/package.json`); the sentence now says so.
- The notes did not mention N68, the one user-visible behaviour added since they were drafted; a "Strict field values" highlight now does.
- The notes did not list the known limits that `site/index.md` states for 0.1.0; a "Known limits" section now lists them, linking the three guide sections (anchors checked against the headings in `site/guides/patterns.md`, `workers.md` and `live-feeds.md`).
- The other claims (hosting chain, fetch sharing only under the SharedWorker, the watermark, auth reaching every tab a worker serves, persistence only under the SharedWorker, server rendering, ESM-only with no runtime dependencies, Vite 8 as an optional peer, the stability policy, both links) hold on this `main`.

**Outside the notes.** `site/performance.md` gave the same sizes, dated 2 November, with `vite` at 0.95 kB; they now read as measured on 2026-11-13, rounded as before.

## Verification

```sh
bun install --frozen-lockfile                    # 544 packages
bun run build                                    # tsdown; attw: no problems; publint: no issues
bun run size                                     # every entry ok (table above)
cd packages/tscache && npm pack --dry-run        # 27 files, 76.5 kB packed, 255.2 kB unpacked
bun run check:pack                               # passes
bunx git-cliff --tag v0.1.0 -o CHANGELOG.md      # 133 unconventional commits skipped
~/code/tscache-reports/bin/heavy-run.sh "87 child: ci" bun run ci   # exit 0 on the final head
```

Not verified: the pack on CI (bytes and shasum may differ from a local pack), the release workflow and its dry run (left to the director after merge, as the brief says), and the rendered site.

**Open points.**

- The changelog was generated before this step's own commits, so the 0.1.0 section does not list them or the merge of this branch. If the tag goes on that merge, a regeneration at tag time would add these three documentation commits; nothing in the summary depends on them.
- The heading date, 2026-11-13, is the date of generation; if the tag is pushed on a later day, the heading's date will not match the tag's.
