# Step 125 — Release docs after 0.2.0

Branch: `docs/125-releasing-after-0.2.0` · Reviewer: GPT-6.1 Sol (pending) · Rounds: 0 · Status: in review · Verdict after triage: pending

## Scope

`@anishbenji/tscache@0.2.0` was released on 2026-11-20, but `docs/releasing.md` still described the state of 17 November (0.2.0 on `main` but not on npm, `latest` at 0.1.0). This step brings "Current state" and the dry-run paragraph up to date, and adds to "Cutting a release" and "Dry run" what the 0.2.0 release showed was missing. It changes no code, workflow or setting. `docs/supply-chain.md` and `.github/workflows/release.yml` are unchanged: neither states anything the release made false.

## Changes and the facts they rest on

Facts are from the director's brief (from the parent thread, 2026-11-20). Those marked "checked" were confirmed read-only on 2026-11-20 with `gh` and `git`; npm was not queried.

- **"Current state", dated 20 November 2026.**
  - New bullet: 0.2.0 is `latest`, with an SLSA v1 provenance statement, 27 files and 271,386 bytes unpacked (brief; the file count and size match `npm pack --dry-run` in `docs/reviews/step-120.md`).
  - New bullet: tag `v0.2.0` on `43393f3`, the merge commit of PR #149, pushed at 17:55 UTC; run 44787821712 succeeded; stage id `5a52992d-6750-4538-a92a-3b8f2e4c99cc`; the GitHub release was published at 18:18:23 UTC. Checked: `gh run view 44787821712` (conclusion `success`, head `43393f37…` on ref `v0.2.0`; `plan`, `ci / ci`, `pack`, `stage` and `github-release-draft` succeeded, `ci / bench` and `stage-dry-run` skipped); `gh release view v0.2.0` (not a draft, published `2026-11-20T18:18:23Z`); `git ls-remote origin 'refs/tags/v0.2.0^{}'` (`43393f37…`). The push time and stage id are from the brief.
  - The two 0.1.0 bullets become one line of history: tag `v0.1.0` on `b2e1f06`, run 43470043079, release published at 17:21:12 UTC (unchanged facts from step 90). The 0.1.0 `npm audit signatures` result is dropped with the rest of the 0.1.0 detail; it was not re-checked for 0.2.0.
  - The bullet saying `main` carries 0.2.0 that npm lacks is replaced: `main` carries the 0.3.0 work in preparation (`docs/releases/0.3.0.md`, titled "in preparation"), and the package version stays 0.2.0 (`packages/tscache/package.json`) until a release-preparation step.
  - The account, trusted-publisher and environment bullets are unchanged; they are still true.
- **Cutting a release, step 5.** A paragraph after the tag commands: the ruleset `protect-release-tags` restricts creating a `v*` tag to the repository admin, so the maintainer's push prints a "Bypassed rule violations" notice about creations being restricted, which is expected. Basis: the 0.2.0 tag push printed it (brief); the ruleset and the admin bypass are described in `docs/supply-chain.md` (chain step 2 and the tag-ruleset check). The steps did not mention the ruleset before.
- **Step 8.** Run `npm whoami` first and sign in again with `npm login` if it fails; an expired login token fails the stage commands with `E401`. Basis: the maintainer's token had expired during the 0.2.0 release (brief). Step 8 already said the stage commands need the maintainer's own login, but not how to check it.
- **Between steps 8 and 9.** Steps 9 and 10 run one at a time, never as one chained block. Basis: in 0.2.0 they were given as one block, so `gh release edit --draft=false` ran although the approval had failed, and the GitHub release was public about 7 minutes before npm had the version (brief).
- **Step 10.** Publish the draft GitHub release only after `npm view @anishbenji/tscache version` prints the new version (the version of the `latest` dist-tag). Step 11 keeps `npm view @anishbenji/tscache@X.Y.Z` as a details check and now reads "Check the rest of the result", so the gating check is in step 10 and the order is clear.
- **Dry run.**
  - The sentence "Today `main` says `0.2.0` and `latest` is still `0.1.0`, so a dry run on `main` passes without it" is false now. It reads: today `main` and `latest` both say `0.2.0`, so a dry run on `main` passes with the version warning. Checked against `plan` in `.github/workflows/release.yml`: a version equal to the highest published plain version produces the `::warning::` "is not above the highest published version" in a dry run. This is outside the brief's list but inside `docs/releasing.md`, and the brief allows fixing a statement the release made false.
  - The link to "Current state" uses the new anchor `#current-state-20-november-2026`; `git grep current-state-17` finds only the historical `docs/reviews/step-120.md`, which stays as written.
  - New paragraph: a job that fails while installing system packages (for example apt 503s while Chromium is installed) is retried with **Re-run failed jobs**, and a passing attempt is the result that counts. Basis: the 0.2.0 dry run on `main` (run 44522693289) failed on attempt 1 only for that reason and passed on attempt 2 (brief). Checked: `gh run view 44522693289` reports attempt 2, conclusion `success`, on `main` at `43393f37…`. The section had no note on retries before.
- **`docs/INDEX.md`.** The `docs/releasing.md` row is re-measured: `wc -c` gives 18,356 bytes, 18.4 KB (was 17.4 KB).

## Verification

| Command                                                              | Result                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| `bunx biome check docs/releasing.md`                                 | no fixes                                               |
| `bun run build`, then `bun run docs:check`                           | exit 0; `doc-anchors: 246 anchors in 42 pages resolve` |
| `~/code/tscache-reports/bin/heavy-run.sh "125 child: ci" bun run ci` | not completed: see below                               |

The full CI run waited about two hours for the heavy-job lock and was stopped about a minute after it took the lock, when the tool's two-hour background limit ran out. By then it had passed the steps up to the site build. It has to be run again on the final head.

Not run: the release itself, any npm command, and the GitHub dry-run workflow.

## Contract-test changes

None.

## Decision concerns

None.
