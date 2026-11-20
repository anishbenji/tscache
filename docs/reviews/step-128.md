# Step 128 — The 2026-11 review update catches up, and the findings that need no decision

Branch: `docs/128-review-update-catch-up` · Reviewer: GPT-6.1 Sol (high) · Rounds: pending · Status: pending · Verdict after triage: pending

## Scope

`docs/reviews/2026-11-review-update.md` tracks what happened to each finding of the review of 2026-11-10. Its status table still described 2026-11-11: M3, M5 and M7 parked on decision 46, H5 and L1 waiting for #98. This step brings the table and the counts line up to date from evidence on `main` (`6716b4d`, the merge of #151), and fixes the findings still `open` or `partly` that need no user decision. The original review, `docs/reviews/2026-11-review.md`, is unchanged. No library code changes.

The director added two fact fixes to the step: the roadmap's description of the bench timing gate, and stale comments in config files. The director told this child to fix the config comments on this `docs/` branch, although `AGENTS.md` (Process, Steps) puts tooling changes on their own `chore/` branch.

| Commit (by subject)                                                   | What                                                                                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `docs(readme): explain attw's node10 result for the esm-only package` | L6: a paragraph under Install in `packages/tscache/README.md`.                                                                          |
| `docs(site): state the range gapSplitK accepts`                       | L10: `site/usage/cache.md` and `site/concepts/segments.md` state the values `gapSplitK` accepts.                                        |
| `docs(roadmap): the eight gated bun timing cases block ci`            | `docs/roadmap.md`, "Performance measurement and gate": timing is no longer called report-only.                                          |
| `chore(config): correct three stale config comments`                  | Two comments in `vitest.config.ts`, one in `.fallowrc.json`.                                                                            |
| `docs(review): bring the 2026-11 review update up to 2026-11-21`      | The status table, the counts line and a dated note in `docs/reviews/2026-11-review-update.md`; this file; the sizes in `docs/INDEX.md`. |
| `docs(review): step 128 verification`                                 | The CI result in this file.                                                                                                             |
| `docs(review): step 128 pre-review and security-lane fixes`           | The fixes below ("Pre-review", "Security lane").                                                                                        |

## Changes and evidence

### The status table

Each row names the pull request and its merge commit from `git log --first-parent --merges main`, or the user decision (the director's `decisions-resolved.md`). Every row was checked against `main`, including the rows whose status did not change: their file and line references, sizes and versions were corrected where `main` had moved (H1, H2, H3, H4, M9, M14, M17, L2). Counts of the 32 findings: 24 fixed, 7 partly, 1 open, 0 parked on a decision (on 2026-11-11: 12 fixed, 9 partly, 4 open, 7 parked). L6 is fixed in step 128 (this change).

| Finding | Was                  | Now    | Evidence                                                                                                                                                |
| ------- | -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H2      | fixed                | fixed  | Still fixed; the row now names the rehearsal (decision 49), 0.1.0 (`b2e1f06`, 2026-11-13) and 0.2.0 (`43393f3`, 2026-11-20), and version `0.2.0`        |
| H5, L1  | parked on a decision | fixed  | #98 `3ff6157`, merged by the user 2026-11-12 (decision 43); an ancestor of the `v0.1.0` commit                                                          |
| M2      | partly               | fixed  | #102 `af68568` (step 77), #127 `20ec765` (step 95); scheduled flake hunt run 43870066983 on 2026-11-16 passed (`gh run list --workflow flake-hunt.yml`) |
| M3      | parked on a decision | fixed  | #125 `09210ef` (design), decision 67, #150 `4507d6a` (step 121); not an ancestor of the `v0.2.0` commit, so 0.2.0 does not have it                      |
| M4      | partly               | partly | #147 `8c27a63` (step 118, design); decision 83 (2026-11-21) took every recommendation; not built                                                        |
| M5      | parked on a decision | partly | #136 `004513e` (step 100, design), #129 `7b1d163` (step 101), decision 71; limits stated in #109 `cb51ea9`; not built                                   |
| M7      | parked on a decision | fixed  | #122 `8ec84b2` (design), decision 65, #146 `8cbb162` (step 114), an ancestor of the `v0.2.0` commit (#149 `43393f3`)                                    |
| M10     | partly               | fixed  | #106 `d95b405` (step 73): `docs/decisions/`; N70–N105 each have a file (checked with `ls docs/decisions/N{70..105}-*.md`)                               |
| M11     | fixed                | fixed  | The remaining `ci.yml` comment corrected in #107 `682ef73` (step 81, decision 45 A)                                                                     |
| M12     | partly               | fixed  | Handover to a fresh director thread on 2026-11-13 (decision 44, `handover-2026-11-13.md`); children build and review                                    |
| M13     | partly               | fixed  | `~/code/project-dashboard`: `entries.json` through #151 and `direction.json` for 0.2.0, both 2026-11-20 (`git log` of those files)                      |
| M15     | parked on a decision | fixed  | #110 `fa9e5e4` (step 74); N70 in #108 `2dc86e7` (step 80, decisions 42 A and 52)                                                                        |
| M16     | open                 | open   | Re-checked below ("Toolchain watch"); a watch list, nothing to fix without a decision                                                                   |
| L3      | partly               | fixed  | #106 `d95b405` moved the starter prompt to `docs/history/`; decision 62 dropped its stale rows                                                          |
| L6      | open                 | fixed  | Fixed in step 128 (this change)                                                                                                                         |
| L7      | partly               | partly | #131 `7c2e35d` (step 104), #137 `781c378` (step 108); sizes measured with `bun scripts/size.ts`; decision 5 below                                       |
| L8      | partly               | fixed  | #112 `f6798bf` (step 65): `https://anishbenji.github.io/tscache/` answers 200; root README has "Status: 0.x" and an Install section                     |
| L9      | parked on a decision | partly | #110 `fa9e5e4` added an outcome-based fault test; `merge-failures.test.ts` unchanged since 2026-10-05; decision 6 below                                 |
| L4, L10 | partly, open         | partly | L10's `gapSplitK` fix in step 128 (this change); the rest are decisions 1–3 and 7 below                                                                 |

The other sections of the update file (summary, recommended actions, decisions, still to do) are kept as the record of 2026-11-11; a note above the table says so. No user decision was open at 00:15 IST on 2026-11-21 (`pending-user-decisions.md`, "Open: none"); step 128 raises the eight under "Decisions for the user". `docs/INDEX.md`'s `docs/design/` row now says `calendar-grid.md` was decided by user decision 83; the file's own status line, which still says "proposal for the user's decision", belongs to another step and is not edited here.

### L6: attw's `node10` result

`bunx attw --pack .` in `packages/tscache` (attw 0.18.5, after `bun run --filter @anishbenji/tscache build`) prints "Resolution failed" under `node10` and "ESM (dynamic import only)" under `node16 (from CJS)` for all five entries, and passes `node16 (from ESM)` and `bundler`. The build runs attw with the `esm-only` profile (`packages/tscache/tsdown.config.ts:7`), which ignores those two columns, so `bun run ci` reports "No problems found". The README now says the package is ESM-only with an `exports` map and no `main`, that `bundler`, `node16` and `nodenext` find its types, that `node` (`node10`) does not read `exports`, and that CommonJS code loads it with `import()`.

### L10: the small items

- **`gapSplitK` range (fixed).** `requirePositiveSafeInteger` (`packages/tscache/src/engine/validate.ts:17-22`) accepts only `Number.isSafeInteger` values above 0: it rejects 0, negatives, non-integers, values above 2^53 − 1 and `Infinity`. `validate.test.ts:145` pins the rejection of 0. `site/concepts/segments.md` now says K is "a positive safe integer (at most 2^53 − 1; 0 and `Infinity` are rejected)", and `site/usage/cache.md` says "a positive safe integer". A K of `segmentSlotCap` or more splits segments only at page edges: two points on one page have at most `segmentSlotCap` − 2 empty slots between them. The TSDoc in `packages/tscache/src/types.ts` is not changed: that file has been a Never path since 0.1.0, and editing it would take this documentation step out of auto-merge. The same sentence can go there with the next change to that file.
- **"tsup is EOL" (proposed, not changed).** tsup 9.0.0 is npm's `latest` (published 2026-10-14) and is not deprecated. Its README says "This project is not actively maintained anymore" and points to tsdown. The only live occurrence is `AGENTS.md:36`. `docs/INDEX.md` says agents propose `AGENTS.md` changes on a `chore/` branch, so this branch does not change it. Proposed wording: `**tsup is no longer maintained (its README points to tsdown) — do not use.**`
- **The Biome warning, Knip's two hints and the empty folder** need a choice: decisions 1–3 below.

### The roadmap's bench gate

`docs/roadmap.md` said hot-path timing was "report-only for now" and still listed the calibration as next. `docs/benchmarking.md`, "The gate", says the Bun cases in `packages/tscache/bench/gated.json` fail the `bench` job on a confirmed regression that no trailer allows; every other case, and all of Chromium, reports. `scripts/bench.ts` reads `gated.json` (lines 77-78) and, with `--gate`, fails only the listed cases. `gated.json` lists eight Bun cases and no Chromium case: chore 43's calibration added them, and chore 45 kept Chromium report-only. The calibrations before chore 43 (on `main` at `0797cb5`, after step 22, and chore 39's noise experiment; `docs/benchmarking.md`, calibration log) kept timing report-only. The roadmap now says this, and moves the calibration to "Done". `gated.json` is not edited.

### Config comments

Every comment in the listed files was read. These three were fixed because they stated something false:

| File and line            | Said                                                                                            | Fact                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest.config.ts:9-11`  | "Engine unit tests cover ~90% of logic; browser-mode and Playwright suites arrive at steps ⑨–⑫" | The Playwright suites exist (`playwright.config.ts`); no Vitest browser mode is configured (no `@vitest/browser` in any manifest); the 90 % figure has no source |
| `vitest.config.ts:13-15` | "`bun run ci` runs Vitest before the build"                                                     | `scripts/ci.sh` builds at line 53 and runs Vitest at line 67; the alias still matters for `bun run test` without, or with a stale, `dist/`                       |
| `.fallowrc.json:31-32`   | "`bun run ci` runs Fallow before the build"                                                     | `scripts/ci.sh` builds before Fallow (line 63); the pre-push hook runs Fallow in parallel with the build (`lefthook.yml`, `parallel: true`)                      |

These were read and are correct, so they were not changed: `vitest.mutation.config.ts`; `playwright.config.ts` (the demo launcher does start the ten apps of `e2e/examples/apps.ts`, as it says); `knip.jsonc`; `stryker.config.json` (no workflow, hook or `ci.sh` line runs Stryker: `grep -i stryker .github/workflows/*.yml`); and the rest of `.fallowrc.json`. The root and package `package.json` files have no comment fields. `.fallowrc.json:107-108` still says that members "used only by tests or by a later commit-plan step" are reported. The commit plan is complete, so the second case no longer arises, but the sentence is not false, so it stays.

Found in protected paths and not changed (listed for the director):

- `scripts/ci.sh:82-85`: "The timings run in the separate bench job, which reports and does not gate yet." This has been false since chore 43: the job gates the eight Bun cases in `gated.json`, as `.github/workflows/ci.yml:89-95` correctly says. Suggested: "The timings run in the separate bench job, which gates the cases in packages/tscache/bench/gated.json and reports the rest."
- `lefthook.yml:1`: "Hook staging per starter prompt §4" still holds. The starter is now at `docs/history/starter-prompt.md`, and `docs/INDEX.md` marks §4 historical. Not false.
- `.github/`: the `bench` job comment in `ci.yml` and the `ci` job comment in `release.yml:151-152` are correct.
- `biome.json` and `packages/tscache/tsdown.config.ts`: `biome.json` has no comments; the two comments in `tsdown.config.ts` are correct.

### Toolchain watch (M16)

Versions on 2026-11-21, from the repository's manifests and `node_modules`, `npm view <package> dist-tags`, and `gh api repos/gitleaks/gitleaks/releases/latest`. Nothing was upgraded.

| Tool       | In the repository                                                                | Newest release                                                                | Newer?                                 |
| ---------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| VitePress  | `2.0.0-alpha.21` (`site/package.json`)                                           | `next` 2.0.0-alpha.21 (2026-10-25); `latest` 1.6.4 (2025-08-05, needs Vite 5) | No; still no stable release for Vite 8 |
| Node floor | root `engines.node` `>=22.12`; package `^20.19.0 \|\| >=22.12.0` (decision 27 A) | tsdown 0.23.7 requires `^22.18.0 \|\| ^24.11.0 \|\| >=26.0.0`                 | The floor is still below tsdown's      |
| gitleaks   | 8.30.1 (`ci.yml` pinned with SHA-256; Homebrew 8.30.1 locally)                   | 8.30.1 (2026-03-21); README: "feature complete", "security patches only"      | No                                     |
| tsdown     | `^0.23.4`, lockfile 0.23.4                                                       | 0.23.7 (2026-11-06)                                                           | Yes, a patch within the declared range |
| TypeDoc    | 0.28.20 with TypeScript 6.0.3 under an alias (`site/package.json`)               | 0.28.20 (2026-07-05); issue #3098 (TypeScript 7 support) still open           | No                                     |

## Decisions for the user

Each of these needs a choice, so none was acted on.

1. **L10: the Biome warning in an end-to-end test.** `e2e/examples/react-lwcharts.spec.ts:37` calls Playwright's `Locator.innerText()`, which Biome's `useDomNodeTextContent` rule mistakes for the DOM property.
   - (a) Turn the rule off for `e2e/**` in `biome.json`. Pros: one config line; no test changes; covers future specs. Cons: the rule then also misses a real DOM `innerText` in a page script under `e2e/`; `biome.json` is a Notify path.
   - (b) A `biome-ignore` comment on the line, with the reason. Pros: the narrowest change; the rule stays on everywhere else. Cons: one comment per occurrence, and the next spec that uses `innerText()` warns again.
   - (c) Call `textContent()` instead. Pros: no suppression at all. Cons: it reads hidden text and ignores CSS line breaks, so the assertion could read different text: a change to a test's behaviour.
   - Recommendation: (a). Every `innerText` under `e2e/` is Playwright's API, not the DOM's. The director has already queued this as step 130.
2. **L10: Knip's two configuration hints.** Knip reports `.svelte` and `.vue` as "Compiled extension excluded by project (imports not followed)" for `integrations`. Knip still exits 0.
   - (a) Leave them, and record them as expected. Pros: no change; the snippets are already entries, and `bun run check:integrations` type-checks them. Cons: the two lines stay in every Knip run, and imports inside `.svelte` and `.vue` files are not followed.
   - (b) Configure Knip compilers for the two extensions. Pros: Knip follows their imports and the hints go. Cons: probably adds Svelte and Vue compiler dev dependencies (ask-first), for snippet files that nothing imports.
   - Recommendation: (a).
3. **L10: the empty `~/code/tscache-vitewarn54/` folder.** It is still there and empty. It is outside the repository and was not created by this step, so deleting it needs your OK (`agent-config.md`, rule 5).
   - (a) Delete it. Pros: closes the last part of L10; nothing references it. Cons: none known.
   - (b) Keep it. Pros: none. Cons: it stays listed in the review.
   - Recommendation: (a).
4. **M8: snapshot byte order and HTML safety.** `encodeSnapshot` runs where the snapshot is made, which in server rendering is the server (`site/guides/ssr.md`). It copies each field's bytes in the host's native order (`packages/tscache/src/snapshot.ts:46`), while the format promises little-endian bytes (`packages/tscache/src/types.ts:199`). `decodeSnapshot` likewise reads them in native order (`snapshot.ts:104`). A big-endian server (s390x, for example) would therefore make snapshots that the browser decodes to wrong numbers, with no error. The browser side is little-endian in practice; the server host is the risk. HTML safety is the caller's job today, behind a danger box in `site/usage/snapshots.md`. The mock backend already guards its own binary format this way (`examples/mock-backend/src/columns.ts:101-105`).
   - (a) Documentation only: state in the server-rendering guide that the server must be little-endian, and close M8. Pros: no code change and no Never-path merge. Cons: the failure stays silent; a reader who never sees the sentence gets wrong prices.
   - (b) An endianness probe (`new Uint8Array(new Uint16Array([1]).buffer)[0] === 1`) that makes `encodeSnapshot` and `decodeSnapshot` throw an existing error class on a big-endian host. Pros: silent corruption becomes a loud error; about five lines plus a test that forces the probe; no public API change. Cons: `snapshot.ts` is a Never path, so it is your merge; a big-endian server cannot make snapshots at all.
   - (c) Byte-swap on big-endian hosts, so the bytes are little-endian whatever the host. Pros: works on every host. Cons: per-dtype swap code in a Never path, on a branch no CI runner executes (testable only through an injected probe), and bytes in the size budget.
   - (d) Export a helper that escapes the encoded JSON for a `<script>` element. Pros: removes the HTML footgun the danger box describes. Cons: new public API (Never path, `entries/`) and bundle bytes. It is independent of (a)–(c).
   - Recommendation: (b), with (a)'s sentence in the server-rendering guide. Without (b) a wrong result is silent, and silent wrong data is the costliest failure for the primary use (charted prices). Keep (c) until someone needs a big-endian server, and (d) until a consumer asks. M8 then closes when (b) merges.
5. **L7: size-budget headroom.** Measured with `bun scripts/size.ts`: `worker (lazy)` 5.39 of 5.69 kB (5.3 % headroom), `index (lazy)` 14.25 of 14.75 kB (3.4 %), `worker` 15.50 of 15.97 kB (2.9 %) and `engine` 11.57 of 12.06 kB (4.1 %). A budget is the measured size plus max(512 B, 3 %) (`scripts/size.ts:21`). Since step 108 the measurement no longer moves with chunk hashes or comments.
   - (a) Close L7 as by design: a deliberate change raises its budget in its own pull request, with the reason (`docs/benchmarking.md`). Pros: budgets stay tight, so every growth is a visible, explained edit. Cons: a feature that grows an entry also edits `budgets.json` (a Notify path) in the same pull request.
   - (b) Give every budget at least 6 % headroom. Pros: fewer budget edits. Cons: up to 6 % growth goes unexplained, which is what the budgets exist to catch.
   - Recommendation: (a). The review's worry was the noise that made a comment-only change fail; step 108 removed it.
6. **L9: `merge-failures.test.ts`.** It injects an allocation failure at the Nth call of a `DenseSegment` method and checks that the cache is unchanged and still usable. The call counts only choose where the failure lands; the assertions are on outcomes. The fault-injection property test of step 74 covers the same guarantee from outside.
   - (a) Keep the test and close L9. Pros: it pins step-by-step atomicity at every internal allocation, which N70 describes; nothing is weakened. Cons: a refactor that changes how many slices or merges a join makes must update the test's counts.
   - (b) Rewrite it to inject failures without counting calls. Pros: no coupling to the call sequence. Cons: harder to aim a failure at each step, and the property test already covers the random case; a rewrite risks losing a case.
   - Recommendation: (a).
7. **L4: the missing review files.** PRs #29 and #32–#37 (chores and a docs step, numbered 17–23 for the second time) and steps 49–50 (#74 and #75, two dependency bumps) have no review file.
   - (a) Close L4 with one line in `docs/reviews/README.md` naming them as merged before the numbering rule. Pros: one line; the record is complete and honest. Cons: those changes keep no review record beyond their pull requests.
   - (b) Write review files after the fact from the pull requests. Pros: every step has a file. Cons: a file written now records no review that happened, and only restates the pull request.
   - Recommendation: (a).
8. **M16: the Node floor for development.** The root `engines.node` (`>=22.12`) is below tsdown's (`^22.18.0 || ^24.11.0 || >=26.0.0`), so a contributor on Node 22.12–22.17 passes the repository's check and then fails tsdown's.
   - (a) Raise the root `engines.node` to tsdown's range; the published package's `engines` stays as decision 27 A set it. Pros: the first error a contributor meets is the true one. Cons: it touches root `package.json`, a Notify path; Node 22.12–22.17 users must upgrade to contribute (they already must, to build).
   - (b) Leave it. Pros: no change. Cons: the mismatch stays, and the review keeps it open.
   - Recommendation: (a). It is not a dependency change.

## Pre-review (Claude), not the gate

Fable 5.2, pre-review 1, on `6fab944`: six findings, all accepted and fixed.

- PR-1 (P2): "`gapSplitK` has no upper bound" was false: `requirePositiveSafeInteger` rejects 2^53, 1e300 and `Infinity`. Fixed: `site/concepts/segments.md` and this file say "a positive safe integer (at most 2^53 − 1; 0 and `Infinity` are rejected)", and `site/usage/cache.md` says "a positive safe integer".
- PR-2 (P2): four rows whose status did not change were stale against `main`: H2 (version 0.1.0, and release items already done), H4 (`orchestrator.ts:340`, now 353), M9 (435.7 KB, now 283.1 KB) and L2 (`errors.ts:21-26`, now 26-32). Fixed. Every other row was also re-checked against `main`; H1 (the brief's relay rule is now line 69), H3 (the limit is still stated for 0.2.0, `site/guides/fetcher.md:20`), M14 (the starter's new path) and M17 (the reports repository's commit count) were corrected too.
- PR-3 (P2): "not yet merged" and "once step 128 merges" turn false on merge. Fixed: "fixed in step 128 (this change)".
- PR-4 (P2): "no user decision is open" contradicted the eight decisions raised here. Fixed in the update file and in this file: none was open at 00:15 IST on 2026-11-21, and step 128 raises eight. `docs/INDEX.md`'s `docs/design/` row now says `calendar-grid.md` was decided by user decision 83.
- PR-5 (P2): the roadmap said "the first two calibrations"; three before chore 43 kept timing report-only (on `main` at `0797cb5`, after step 22, and chore 39). Fixed: "The calibrations before chore 43 kept timing report-only".
- PR-6 (nit): this file did not record that the director asked for the config comments on this `docs/` branch. Fixed in Scope.

## Security lane

Run 1, on `6fab944`: one finding, accepted.

- SL-1 (P2): decision 4 (M8) rested on "browsers are little-endian", but `encodeSnapshot` runs on the server in server rendering and copies native-order bytes (`snapshot.ts:46`). A big-endian server would make snapshots that decode wrong with no error. Fixed: decision 4 now names the server host as the risk, adds option (b), an endianness probe that makes `encodeSnapshot` and `decodeSnapshot` throw on a big-endian host (no public API change; `snapshot.ts` is a Never path, so it is the user's merge), and its recommendation changed from documentation only to (b).

## Verification

| Command                                    | Result                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bunx attw --pack .` in `packages/tscache` | The table above: `node10` "Resolution failed" on all five entries                                                                                                  |
| `bun scripts/size.ts`                      | Every entry `ok`; sizes as in decision 5                                                                                                                           |
| `bunx biome ci .`                          | One warning (decision 1), no error                                                                                                                                 |
| `bunx knip`                                | Exit 0; two configuration hints (decision 2)                                                                                                                       |
| `bun run docs:check`                       | Exit 0 on `969ff81`; `doc-anchors: 246 anchors in 42 pages resolve`                                                                                                |
| `heavy-run.sh "128 child: ci" bun run ci`  | Exit 0 on `c2a7e21`, `6fab944` and `969ff81` (after the pre-review fixes): Vitest 3,058 passed in 156 files, Playwright 193 passed, bench smoke and e2e smoke `ok` |

## Contract-test changes

None.

## Decision concerns

None. No locked decision is touched.

## Round 1 (Codex) — reviewer verdict: merge

Head `f016bf1`. No findings; the reviewer confirmed PR-1 to PR-6 and SL-1. `bun run ci` exited 0 on `f016bf1`. The review settles at round 1. The eight user items are the director's #109 (and #92 for item 1).
