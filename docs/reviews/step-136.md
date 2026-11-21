# Step 136 — small follow-ups from user decisions 105 and 109

Branch: `chore/136-small-follow-ups` · Status: built, awaiting review · It touches two Never paths, `.github/dependabot.yml` and `packages/tscache/src/snapshot.ts` (Never from 0.1.0), so the user merges this step. Notify paths: `packages/tscache/src/snapshot.ts`, root `package.json` (its `engines` field; `scripts` is unchanged) and `AGENTS.md`.

## User answers (2026-11-21)

- **#105, option A, amended by #122, option A.** The `github-actions` entry of `.github/dependabot.yml` gets a cooldown, as the `bun` entry got in step 130. Decision 105 A asked for the `bun` entry's 3 days for patch and minor releases and 7 for a major; Dependabot supports only `default-days` for GitHub Actions (gate round 1, R1-1), so decision 122 A (2026-11-21) makes every Actions update wait 7 days.
- **#109 c, option B (finding M8).** An endianness probe makes `encodeSnapshot` and `decodeSnapshot` throw an existing error class on a big-endian host, with option A's sentence in the server-rendering guide.
- **#109 g, option A (finding M16).** The root `engines.node` becomes tsdown's range, `^22.18.0 || ^24.11.0 || >=26.0.0`; the published package's `engines` stays as decision 27 A set it.
- **#109 a, d, e and f, option A each.** Knip's `.svelte` and `.vue` hints are expected (L10); the size-budget headroom is by design (L7); `merge-failures.test.ts` keeps its call counts (L9); one line in `docs/reviews/README.md` names the changes merged without a review file before the numbering rule (L4).

## Scope

One commit per decision, then this file, then the fixes from the reviews.

| Commit                                                                   | What changed                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fix(snapshot): throw on a big-endian host instead of corrupting fields` | `packages/tscache/src/snapshot.ts`: `requireLittleEndian`, five lines, called first in `encodeSnapshot` and `decodeSnapshot`; it throws `TscacheError("snapshots need a little-endian host")`. Both functions' TSDoc says so. New `packages/tscache/test/snapshot-byte-order.test.ts`. `site/guides/ssr.md`: one bullet saying the server must be little-endian and that both functions throw `TscacheError` otherwise |
| `ci(dependabot): let github actions releases age before an update`       | `.github/dependabot.yml`: `cooldown` with `default-days: 3` and `semver-major-days: 7` on the `github-actions` entry, with a one-line comment pointing to the `bun` entry's. Replaced by the next row (R1-1)                                                                                                                                                                                                           |
| `ci(dependabot): wait 7 days for every github actions update`            | `.github/dependabot.yml`: the `github-actions` entry's cooldown is `default-days: 7` alone, and its comment says that every Actions update waits 7 days because Actions support only `default-days` (decision 122 A)                                                                                                                                                                                                   |
| `chore: raise the development node floor to tsdown's range`              | Root `package.json` `engines.node`; the stated floor in `CONTRIBUTING.md`, `docs/workflow.md` (Toolchain) and `AGENTS.md` (the Vitest line); the `AGENTS.md` size in `docs/INDEX.md`                                                                                                                                                                                                                                   |
| `docs(review): close m8, m16, l4, l7, l9 and l10 by the user's answers`  | `docs/reviews/2026-11-review-update.md`: six rows, a dated note above the table that also records #105, and the counts line; `docs/reviews/README.md`: the L4 line; the update file's size in `docs/INDEX.md`                                                                                                                                                                                                          |
| `docs: restore step 127's m5 wording in the docs/design index row`       | `docs/INDEX.md`: the `docs/design/` row again says that `m5-deploy-skew.md` was reconciled with M7 and M3 as built in step 127, lists four decision concerns in its §8, and has contract tests next                                                                                                                                                                                                                    |
| `docs(review): step 136 scope and verification`                          | This file                                                                                                                                                                                                                                                                                                                                                                                                              |

No dependency was added or changed. No contract test was changed.

## Notes

### The probe and its test seam

The probe is the one the brief and `step-128.md` (decision 4) name, `new Uint8Array(new Uint16Array([1]).buffer)[0] === 1`, and the guard has the shape of the mock backend's own (`examples/mock-backend/src/columns.ts`, `requireLittleEndian`). It runs on every call rather than once at module load: that costs two small typed arrays per call and lets the test reach it without reloading the module. The test stubs the global `Uint16Array` (`vi.stubGlobal`) with a subclass that stores its elements big-endian through a `DataView`, so the probe inside the module reads a big-endian host. No export was added: the package entries re-export `encodeSnapshot` and `decodeSnapshot` by name, and the public API is unchanged. With the probe's condition replaced by `false`, both big-endian tests fail (2 failed, 1 passed); with it restored, all three pass.

The error is `TscacheError`, the class `decodeSnapshot` already throws for an invalid value; the message does not take the `invalid encoded snapshot:` prefix, because the value is not at fault. Options (c), a byte swap, and (d), an escaping helper, are not built, as decision 4 recommended; the M8 row says so.

### The review update

- M8 and M16 are `fixed` by this step, and L4 by the README line.
- L7 and L9 are marked `won't fix`: the user decided that the current state is by design, so nothing changes; the Evidence column says "Decided by the user on 2026-11-21" with the decision letter. The update file has no separate status for a decision to keep things as they are; `won't fix` is the one its counts line already lists.
- L10 is `fixed`. Besides decision 109 a, its other parts were done elsewhere: the tsup wording in `AGENTS.md` by #155 (`c5ef24fa`, step 126) and the Biome warning by #154 (step 130); the empty `~/code/tscache-vitewarn54/` folder no longer exists (`ls` on 2026-11-21: "No such file or directory"). This step did not delete it.
- #105 has no row in the findings table; the note above the table records it.
- Counts: 28 fixed, 2 partly (M4, M5), 0 open, 0 parked, 2 won't fix, 32 in all (`awk` over the Status column).

### The Node floor

`grep` over tracked files for `22.12` and Node version statements found the development floor in `CONTRIBUTING.md:14`, `docs/workflow.md:30` and `AGENTS.md:35`; all three now state the new range. `AGENTS.md` is outside the three places the brief names (CONTRIBUTING, `docs/`, `site/`), but its line states the same floor, and this is a `chore/` branch, where `docs/INDEX.md` says agents propose `AGENTS.md` changes. Left alone, because they state something else: the package's range in `docs/design/calendar-grid.md:53` and `docs/releases/0.1.0.md:66` (decision 27 A), npm staging's Node requirement in `docs/releasing.md:63`, and a runtime remark in `examples/mock-backend/src/vite.ts:252`. `site/` states no Node floor. Every workflow sets up Node 24 (`node-version: 24`), inside the new range; the local Node is 26.13.0.

### `docs/INDEX.md`

`git log -G 'm5-deploy-skew' -- docs/INDEX.md` finds step 127's row text in `1f742c0d`; `git show <commit>:docs/INDEX.md` has it in `09627a7c` (#157, step 127's merge) and not in `55c5e2e8` (step 128's merge of `main`), which kept the branch's older row. The text is restored next to the current `calendar-grid.md` facts (rows G1–G19 decided by user decision 83, built in step 129). The four concerns are still open in `m5-deploy-skew.md` §8, so the wording is still true. Biome re-pads the whole table to the wider row: every line of the table changes in whitespace only (`git diff -w --word-diff` shows the one text change).

Rows re-measured (`wc -c`, 1 KB = 1,000 bytes): `AGENTS.md` 7,840 to 7,866 bytes (7.8 to 7.9 KB); `docs/reviews/2026-11-review-update.md` 55,775 to 54,679 bytes (55.8 to 54.7 KB, after the fixes from the reviews; Biome's re-padding of its table removes more than the new text adds); `docs/design/` unchanged at 604,922 bytes (604.9 KB). `docs/workflow.md` (18,541 bytes) and `CONTRIBUTING.md` (2,444 bytes) still round to their rows' 18.5 KB and 2.4 KB. `site/guides/ssr.md` and `docs/reviews/README.md` have no size row. This file gets no row: the `docs/reviews/` row covers every step file.

## Verification

| Check                        | Command                                                                                                                            | Result                                                                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Test clocks                  | `bun scripts/test-clocks.ts`                                                                                                       | `test-clocks: 215 files clean`, exit 0                                                                                                                                                                                                                       |
| The new test, red then green | `bunx vitest run packages/tscache/test/snapshot-byte-order.test.ts`, with the probe's condition replaced by `false`, then restored | 2 failed, 1 passed; then 3 passed                                                                                                                                                                                                                            |
| Snapshot tests               | `bunx vitest run` over the six `snapshot*` and `*-snapshot` test files                                                             | 141 passed                                                                                                                                                                                                                                                   |
| Exact budgets                | `bunx vitest run packages/tscache/test/perf`                                                                                       | 64 passed (7 files)                                                                                                                                                                                                                                          |
| Entry sizes                  | `bun run size`, after `bun run --filter @anishbenji/tscache build`, before and after the probe                                     | All ok, no budget changed. Brotli: `index` 5.65 to 5.69 of 5.81 kB, `engine` 15.16 to 15.22 of 15.64 kB; every other entry unchanged (`worker` 19.22 of 19.42, `index (lazy)` 17.99 of 18.14, `worker (lazy)` 5.61 of 5.69). The script's kB are 1,024 bytes |
| Dependabot file              | `Bun.YAML.parse` of `.github/dependabot.yml`                                                                                       | On `9e0199eb`: `github-actions` has `cooldown` `{"default-days":7}` and `bun` `{"default-days":3,"semver-major-days":7}`; groups unchanged. The parse does not check which keys an ecosystem supports (R1-1)                                                 |
| Type check                   | `bun run typecheck`                                                                                                                | exit 0                                                                                                                                                                                                                                                       |
| Biome                        | `bun run check`                                                                                                                    | `Checked 920 files … No fixes applied.`                                                                                                                                                                                                                      |
| Full gate                    | `~/code/tscache-reports/bin/heavy-run.sh "136 child: ci" bun run ci` on the commit that adds this file                             | Recorded with the round 1 triage                                                                                                                                                                                                                             |

`snapshot-roundtrip`, one of the eight gated Bun timing cases (`packages/tscache/bench/gated.json`), encodes and decodes a month of bars per call, so the probe's two small allocations per call are on a gated path. Timing is gated by the `bench` job on the pull request; a local `bun scripts/bench.ts compare` is recorded with the triage if it runs.

## Contract-test changes

None. `snapshot.ts` is outside the strict test-first areas (`AGENTS.md`, TDD), so the test was written with the code, and shown failing without the probe.

## Decision concerns

None needing an answer. Two readings of the brief, for the director to confirm:

- L7 and L9 are marked `won't fix` (decided as by design), not `fixed`.
- `AGENTS.md`'s Node floor was aligned with the others although the brief lists CONTRIBUTING, `docs/` and `site/`.

## Pre-review (Claude), not the gate

Pre-review 1 (Opus 5.5, head `114c3970`): two P2 findings.

- **The M16 row split into extra cells (accepted).** The Node range's bare pipes inside a code span made the table split the row into nine cells, and Biome's re-pad joined "`docs/workflow.md`" and "and". Fixed in `docs(review): escape the node range pipes in the m16 row`: the pipes are escaped as `\|\|`, as `docs/design/calendar-grid.md:53` does; the row has five cells; no other table this step touches holds the range. The update file is re-measured: 54,581 bytes, 54.6 KB.
- **`semver-major-days` has no effect for GitHub Actions (accepted, then superseded).** The pre-review read the key as ignored; gate round 1 (R1-1) found that Dependabot rejects it. Resolved there.

## Round 1 (Codex) — reviewer verdict: merge after fixes

| #    | Sev | Finding                                            | Decision | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | --- | -------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-1 | P1  | Remove the unsupported GitHub Actions cooldown key | accepted | Validated against GitHub's Dependabot options reference (the cooldown table, checked by the user): GitHub Actions supports `default-days` only, and Dependabot rejects `semver-major-days` there, which would stop Actions updates. `Bun.YAML.parse` and `bun run ci` cannot see an ecosystem restriction. The user chose a uniform 7 days (decision 122 A, 2026-11-21, amending 105 A). Fixed in `ci(dependabot): wait 7 days for every github actions update`; this file and the review update's note now say 7 days for every Actions update |

The reviewer worked from the director's host `bun run ci`, which passed; the director queues `bun run ci` for the fixed head.
