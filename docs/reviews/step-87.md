# Step 87 — Release prep for 0.1.0

Branch: `docs/87-release-prep` · Reviewer: GPT-6.1 Sol · Rounds: 1 · Status: settled · Verdict after triage: merge (one P2 fixed)

## Scope

User decision 49 A (2026-11-13): run release prep on today's `main`. The 0.1.0 rehearsal of 2026-11-11 passed but found two things stale on the commit that will be tagged: `CHANGELOG.md` was generated on 9 November, and the size table in `docs/releases/0.1.0.md` predates several fixes. This step follows `docs/releasing.md`, "Cutting a release", step 1, for version 0.1.0. It changes no code, workflow or protected path, and runs nothing on GitHub.

| Commit (by subject)                                              | What                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs: regenerate the 0.1.0 changelog and summarize the release` | `CHANGELOG.md` regenerated with git-cliff, and the hand-written summary above the generated list rewritten for 0.1.0 as of this `main`.                                                                        |
| `docs: re-measure the 0.1.0 sizes and state its known limits`    | The size table and tarball figures in `docs/releases/0.1.0.md`, a Known limits section and a strict-field-values highlight there; the same sizes in `site/performance.md`; the notes' size in `docs/INDEX.md`. |
| `docs(review): step 87 scope and verification`                   | This file, and the review-file count and size in `docs/INDEX.md`.                                                                                                                                              |

**Regeneration before the dry run.** The changelog is not regenerated again on this branch. The director regenerates it once step 65 has merged (the notes link the Pages site, which step 65 creates), right before the dry run; that run adds the commits from this step on and may change the heading's date.

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

`npm pack --dry-run` in `packages/tscache`: 27 files, 76.5 kB packed, 255.2 kB unpacked (the rehearsal: 27 files, 75.3 kB, 251.5 kB). npm counts 1,000 bytes to the kB; `scripts/size.ts` counts 1,024 (`bytes / 1024`). The notes did not give these before; they now do, in the paragraph after the table, as a local measurement. `bun run check:pack` passes.

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
~/code/tscache-reports/bin/heavy-run.sh "87 child: ci" bun run ci   # exit 0 on 86fa75e (second run)
```

The first `bun run ci` on 86fa75e exited 1: three cases in `cache-faults-property.test.ts` and `cache-model-property.test.ts` (from step 74) hit Vitest's 5,000 ms timeout while the machine's load average was 17 to 23. The two files alone passed (16 tests, 8.3 s), and the second full run passed (Vitest 2,594 of 2,594, Playwright 175). The timeout margin of those tests is left for its own step.

Not verified: the pack on CI (bytes and shasum may differ from a local pack), the release workflow and its dry run (left to the director after merge, as the brief says), and the rendered site.

**Open points.**

- The changelog was generated before this step's own commits, so the 0.1.0 section does not list them or the merge of this branch; the regeneration after step 65 (Scope) adds them. Nothing in the summary depends on them.
- The heading date, 2026-11-13, is the date of generation; the same regeneration resets it.

## Pre-review (Claude), not the gate

The director's pre-review of 86fa75e found no P0 or P1 and five P2s. Each was checked against the code or docs before it was fixed, in `docs: pre-review fixes to the 0.1.0 changelog and notes`.

| #    | Sev | Finding                                                                                                                            | Decision | Resolution                                                                                                                                                                                                                                                                |
| ---- | --- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-1 | P2  | `CHANGELOG.md`: the handshake bullet describes a change ("no longer", "instead of waiting forever") in the first release           | accepted | The bullet states the behaviour: the timeout bounds only the wait for the worker's first message; a slow fetcher import does not step a tab down; a SharedWorker that dies during the handshake makes `createClient` fall back.                                           |
| PR-2 | P2  | `CHANGELOG.md`: the N70 sentence under validation can be read as applying to a validation reject                                   | accepted | It now says a put that validation rejects changes nothing, and one that fails part-way on an allocation failure has applied an ascending prefix of its write runs, refetched before it is trusted (N70: "whatever prefix was applied is refetched before it is trusted"). |
| PR-3 | P2  | `CHANGELOG.md` and the notes: "`updateAuth` retries with new credentials" contradicts `site/guides/auth.md` ("nothing is retried") | accepted | Both now say `updateAuth` supplies new credentials and fetching resumes, and the application reads again any range that came back `'auth-pending'` (`site/guides/auth.md`, steps 5 and 6).                                                                                |
| PR-4 | P2  | The notes attribute the tarball figures to "the release build"; they come from a local `npm pack --dry-run`                        | accepted | The sentence names the local dry run, and says npm counts 1,000 bytes to the kB while the size table counts 1,024 (`scripts/size.ts:216`, `bytes / 1024`).                                                                                                                |
| PR-5 | P2  | `docs/INDEX.md`: the `docs/reviews/` size predates the last edit of this file                                                      | accepted | Re-measured after this table was written.                                                                                                                                                                                                                                 |

## Round 1 — reviewer verdict: merge after fixes

One P2 (2026-11-13): the release notes listed "a value outside the dtype's range" among the values that reject a
put, without limiting it to integer fields; N68 lets float fields take every number, and `batch.ts` range-checks
only integer fields. Valid; fixed in `docs: scope the range rejection to integer fields`. The reviewer's aside on
the `docs/reviews/` size is fixed in the same commit.

## Finding check (claude-fable-5-2), round 1

V 1, P 0, I 0, D 0

## Rebase and changelog regeneration (director's request)

After the gate round, steps 65 (#112: GitHub Pages, the README rewrite, the demo media), 86 (#111: lockfile security updates) and 88 (#113: property-test batches) merged. The branch, never pushed, was rebased from `fa9e5e4` onto `main` at `f6798bf` (merge of #112).

- **What moved.** The five step 87 commits replayed on top of the three merges. Only `docs/INDEX.md` conflicted, on sizes and counts each side had measured; main's rows were kept and every row this step touches re-measured with `wc -c` (1 KB = 1,000 bytes): `docs/releases/` and `docs/reviews/`. `docs/supply-chain.md` keeps main's figure, which step 65 measured.
- **Sizes.** After `bun install --frozen-lockfile` and `bun run build` on the rebased head, `bun run size` gives the same brotli sizes as before; no file under `packages/tscache/src` changed on `main` since `fa9e5e4`. `npm pack --dry-run` gives 27 files, 76.7 kB packed and 255.5 kB unpacked (before: 76.5 kB and 255.2 kB): step 65 lengthened the package README, which is in the tarball, and set the package's `homepage` to the Pages site. The notes carry the new figures.
- **Changelog.** Regenerated with `bunx git-cliff --tag v0.1.0 -o CHANGELOG.md` as the last content change, in its own commit after the one that carries this section, so the list covers this section's commit too. The `_(scope)_` markers were re-applied and the hand-written summary kept. Against the branch's list before the rebase, the generated list only gains lines (`diff` shows no removed line). It now covers the first commit, `docs: add starter prompt and repo seed` (2026-06-11), through `docs: re-measure the 0.1.0 pack after the rebase` (2026-11-13); git-cliff skips the unconventional commits, merges among them. The heading date stays 2026-11-13.
- **Summary.** Two bullets were added: the documentation site on GitHub Pages (<https://anishbenji.github.io/tscache/>, the package's `homepage`), with the README rewrite and the demo recordings (#112); and the development-tooling security updates in the lockfile, with nothing shipped changed (#111). The summary lists no test changes, so #113 is not mentioned.
- **Links to the Pages site.** `docs/releases/0.1.0.md` links the site's root and `/guides/patterns#memory`, `/guides/workers#stale-scripts-after-a-deploy` and `/guides/live-feeds#redrawing-when-the-cache-changes`; `CHANGELOG.md` links the root. With `base: "/tscache/"` and `cleanUrls: true` (`site/.vitepress/config.ts`), these are `site/index.md`, `site/guides/patterns.md` (`## Memory`), `site/guides/workers.md` (`## Stale scripts after a deploy`) and `site/guides/live-feeds.md` (`## Redrawing when the cache changes`); all exist.
- **Checks.** `bun run docs:check` and `~/code/tscache-reports/bin/heavy-run.sh "87 child: ci" bun run ci` on the final head; results in the director's report.
