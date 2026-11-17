# Step 120 — Prepare release 0.2.0

Branch: `chore/120-release-0.2.0` · Reviewer: GPT-6.1 Sol (pending) · Rounds: 0 · Status: in review · Verdict after triage: pending

## Scope

User decision 62 (2026-11-16) cuts 0.2.0 once finding M7 lands; step 114 (change events, PR #146) merged as `8cbb162` on 2026-11-17. This step is step 1 of "Cutting a release" in `docs/releasing.md`: the release-preparation branch. It changes no code, workflow or setting, and creates no tag.

- `packages/tscache/package.json`: `version` 0.1.0 → 0.2.0, no other field.
- `CHANGELOG.md`: the 0.2.0 section from `bun run changelog --tag v0.2.0` (git-cliff `--unreleased --prepend`), a hand-written summary above its generated list, and `*(scope)*` rewritten to `_(scope)_` in that section only. The 0.1.0 section is unchanged.
- `docs/releases/0.2.0.md`: finished as the GitHub release text, in the shape of `0.1.0.md` (title, install, Highlights, Compatibility, Entries and sizes, Known limits, Stability, Links). The "in preparation" title and paragraph are gone.
- `site/index.md`: "Known limits" describes 0.2.0 (anchor `#known-limits` kept); "What it leaves out" no longer lists change events as missing; the pin example reads `~0.2.0`.
- `README.md` and `packages/tscache/README.md`: the "Known limits" links name 0.2.0 and its limits; the package README's stability paragraph uses 0.3.0, 0.2.1 and `~0.2.0` as its examples.
- `docs/INDEX.md`: the `docs/releases/` row no longer says "in preparation" and is re-measured; the `site/` row is re-measured.
- `packages/tscache/src/rpc/protocol.ts`: `LIB_VERSION` 0.1.0 → 0.2.0, outside the brief's file list; see [Outside the brief](#outside-the-brief).

## Claims checked against `main`

- **API.** `TscacheClient.features: ReadonlySet<WorkerFeature>` (`client/client.ts`); `WorkerFeature = "cacheChanged"`, exported from `.` (`entries/index.ts`); `ClientEvents.cacheChanged` with `cacheId`, `written`, `removed`, `cleared`, `requestId?` (`types.ts`); `CacheEvent` includes `cacheChanged` (`client/cache.ts`).
- **Events.** One development-build warning per client when a listener subscribes against a worker without the feature (`client/changes.ts`, `client/dev.ts`); `PROTOCOL_VERSION` stays 1 and `hello.features` is optional (`rpc/protocol.ts`); `hydrate` sends `cacheChanged` and no other event (architecture §2.8, N77). The integrations coalesce to one read per animation frame (`integrations/shared/changes.ts`); the reference clients redraw from `cacheChanged` in the SharedWorker hosting and through the `BroadcastChannel` otherwise (`reference/shared/src/live.ts`).
- **Docs links.** Every site link in the notes resolves to an existing heading: `concepts/events#change-events`, `#reading-after-an-event`, `#hostings-and-older-workers`, `guides/patterns#memory`, `guides/workers#stale-scripts-after-a-deploy`, `guides/live-feeds#redrawing-when-the-cache-changes`.
- **M3 and M5.** The roadmap records both as proposals with open decision rows (`docs/roadmap.md`, `docs/design/m3-memory.md`), so the notes say "proposed but not built".

**Other user-visible changes since `v0.1.0`.** `git log v0.1.0..HEAD --merges --first-parent` lists 30 merges. Besides step 114, only step 101 changes what a user reads: the guides now describe a fetcher-only deploy (the hashed worker URL stays, new tabs join the old SharedWorker and get a `ConfigError`), which the notes list. Steps 93 and 109 split functions in `src/` without a behaviour change; steps 89 and 110 touch the demo recorder; the rest are tooling, tests, CI and design proposals, left out as the brief says. The changelog summary names the tooling in one bullet.

## Sizes

`bun run build`, then `bun run size`, on this branch (Brotli, 1 kB = 1,024 bytes):

| Entry                  | 0.1.0 notes | 0.2.0    |
| ---------------------- | ----------- | -------- |
| `index`                | 4.57 kB     | 5.00 kB  |
| `index (lazy)`         | 12.16 kB    | 12.72 kB |
| `index (lazy, nested)` | 5.38 kB     | 5.36 kB  |
| `worker`               | 13.34 kB    | 13.98 kB |
| `worker (lazy)`        | 5.38 kB     | 5.36 kB  |
| `engine`               | 9.86 kB     | 10.11 kB |
| `fetcher`              | 0.17 kB     | 0.17 kB  |
| `vite`                 | 1.20 kB     | 1.24 kB  |

Every row is within its budget. The 0.1.0 figures predate step 108, which replaced left-out chunk hashes with a constant; the notes say so. `npm pack --dry-run` in `packages/tscache`: 27 files, 81.6 kB packed, 271.4 kB unpacked (0.1.0: 27 files, 76.7 kB, 255.5 kB).

`docs/INDEX.md` sizes, `wc -c` after the last edit (1 KB = 1,000 bytes): `docs/releases/` 12,640 bytes → 12.6 KB (was 8.3 KB); `site/` 42 tracked Markdown pages outside `site/api/`, 266,846 bytes → 266.8 KB (was 266.7 KB). `README.md` (8,939 bytes, 8.9 KB) and `packages/tscache/README.md` (7,421 bytes, 7.4 KB) keep their figures.

## Verification

| Command                                                              | Result                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| `bun run changelog --tag v0.2.0`                                     | 0.2.0 section prepended; 0.1.0 section unchanged       |
| `bun run build`, then `bun run size`                                 | exit 0; every entry within budget (table above)        |
| `npm pack --dry-run` (in `packages/tscache`)                         | 27 files, 81.6 kB packed, 271.4 kB unpacked            |
| `bun run docs:check`                                                 | exit 0; `doc-anchors: 246 anchors in 42 pages resolve` |
| `~/code/tscache-reports/bin/heavy-run.sh "120 child: ci" bun run ci` | exit 0 on `b9dc547`: 2957 Vitest, 191 Playwright tests |

Not run: the supply-chain checklist (npm account and repository settings, the maintainer's step before step 1), the GitHub dry-run workflow (step 3, after the merge), and anything after step 1.

## Follow-ups (director, after the first report)

The director accepted the `LIB_VERSION` bump and asked for the documents that still described 0.1.0 to be fixed on this branch, in one more commit (`docs: release docs and sizes for 0.2.0`):

- `docs/releasing.md`: step 1 of "Cutting a release" gains a bullet that `LIB_VERSION` in `packages/tscache/src/rpc/protocol.ts` must equal the new version, which `test/version.test.ts` checks. "Current state" is dated 17 November 2026 and gains a bullet: from this branch's merge `main` carries 0.2.0, which is not on npm until the maintainer tags and approves it, and `latest` is still 0.1.0. The 0.1.0 facts stay as they were. The dry-run paragraph no longer says "today `main` says `0.1.0`": between two releases a dry run warns about the version, and today, with `main` at 0.2.0 above `latest`, it does not. The anchor `#current-state-17-november-2026` replaces the old one in the same file; nothing else links to it (`git grep current-state-13`).
- `site/guides/workers.md`: "tscache 0.1.0 detects skew only …" reads 0.2.0; M5 is not built, so the substance is unchanged. The same page's "tscache 0.1.0 has no timeout on it", for the fetcher import, reads 0.2.0 too: `git diff v0.1.0..HEAD` adds no timeout to the orchestrator's import.
- `docs/benchmarking.md`: the entry sizes quoted for step 114 were stale in four rows against this head's `bun run size`: `index (lazy)` 12.71 → 12.72, `worker` 13.97 → 13.98, `engine` 10.10 → 10.11 and `vite` 1.20 → 1.24 kB. The cell now quotes this head's figures, dated step 120; the budgets are unchanged.
- `docs/INDEX.md`: `docs/releasing.md` re-measured, 17,146 bytes → 17.1 KB (was 16.4 KB). `site/` keeps 266.8 KB (266,846 bytes). The `docs/benchmarking.md` row was left at 62.0 KB on the belief that the edit kept its byte count, which was wrong: Biome's pre-commit formatting re-padded the size table, and the file went from 61,973 to 61,933 bytes. Pre-review 1 (finding 3) corrects the row.

Checks on the new head: `bun run docs:check` (exit 0, 246 anchors in 42 pages resolve), `bunx biome check` on the four files (no fixes), and `bun run ci` through the heavy-job wrapper: exit 0 on `ff7c4c7` (2957 Vitest and 191 Playwright tests).

## Outside the brief

The brief forbids changes under `packages/tscache/src/`, but the first `bun run ci` on this branch failed on `packages/tscache/test/version.test.ts`, which requires `LIB_VERSION` in `src/rpc/protocol.ts`, the version every hosting reports in `hello.lib` (§4.7), to equal `package.json`'s version. The test exists to stop a release that bumps `package.json` alone. Weakening it is not allowed, and a 0.2.0 whose worker reports 0.1.0 would be wrong, so the constant is bumped in the same commit as the version, keeping every commit green. It is the only change under `src/`. Step 1 of "Cutting a release" in `docs/releasing.md` did not mention the constant; the follow-up commit adds it. The bump moved the `worker` row from 14.04 kB to 13.98 kB (Brotli of one changed string) and the unpacked tarball from 271.3 kB to 271.4 kB; the figures above are after it.

## Pre-review 1

The director merged `main` (step 115, N85) into the branch as `276eb3c`; the pre-review then found four P2s, all accepted.

| #     | Sev | Finding                                                                                                                                          | Decision | Resolution                                                                                                                                                                                                                                                                                                                                                    |
| ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR1-1 | P2  | `bun.lock` still records the workspace package at 0.1.0, and `docs/releasing.md` step 1 does not name the lockfile                               | accepted | `bun install` rewrote the one line (`8ef6a64`); `bun install --frozen-lockfile` exits 0 after it. Step 1 now names the lockfile as the third place that holds the version, with `package.json` and `LIB_VERSION` (`780eeb7`)                                                                                                                                  |
| PR1-2 | P2  | 0.1.0 wording left in `site/guides/fetcher.md`, `site/troubleshooting.md` and the "Known limits of 0.1.0" section of `docs/guides/patterns.md`   | accepted | Both site lines read 0.2.0; the fetcher import still has no timeout. The patterns section is "Known limits of 0.2.0": change events shipped, M3 and M5 proposed but not built. No link targets its anchor (`git grep known-limits-of`), and `docs:check` passes. `docs/architecture.md:501` (`lib: '0.1.0'`) is left alone, as the director asked (`780eeb7`) |
| PR1-3 | P2  | The `docs/benchmarking.md` row in `docs/INDEX.md` says 62.0 KB, but the file is 61,933 bytes, and this file claimed the edit kept its byte count | accepted | Biome's pre-commit formatting had re-padded the size table. The row reads 61.9 KB and the follow-ups paragraph says what happened. Rows of the files touched this round, re-measured with `wc -c`: `docs/releasing.md` 17,391 bytes → 17.4 KB, `docs/guides/patterns.md` 12,618 bytes → 12.6 KB; `site/` keeps 266.8 KB (266,846 bytes) (`780eeb7`)           |
| PR1-4 | P2  | The 0.2.0 generated list in `CHANGELOG.md` predates the merge of step 115 and this branch's commits                                              | accepted | `bunx git-cliff --unreleased --tag v0.2.0` at `780eeb7`, to stdout; only the generated list was replaced, with `*(scope)*` rewritten to `_(scope)_`. The hand-written summary and the 0.1.0 section are unchanged (`47874f6`)                                                                                                                                 |

The changelog list was generated at `780eeb7`. It covers every commit since `v0.1.0` up to that head, except the ones `cliff.toml` skips (review files, merges, size budgets, dependency bumps). The regeneration commit itself, this review commit and any merge of `main` made after it are not in the list; a later merge that brings user-visible commits needs the list regenerated again.

## Round 1 (GPT-6.1 Sol, high) — reviewer verdict: merge

Run on head `0121013`. No findings; the reviewer confirmed the four pre-review fixes, the version consistency
(`package.json`, `LIB_VERSION`, `bun.lock`) and that the 0.1.0 changelog section is unchanged. The round's `bun run ci`
exited 0. Raw output: `.reviews/step-120/round-1.md`. The review has settled. The security lane (run 1) reported no
findings.

## Contract-test changes

None.

## Decision concerns

None.
