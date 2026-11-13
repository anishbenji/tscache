# Step 90 — Release docs after 0.1.0

Branch: `docs/90-releasing-current-state` · Reviewer: none yet (the director runs the review) · Rounds: 0 · Status: pre-reviewed, awaiting the gate

## Scope

`@anishbenji/tscache@0.1.0` was released on 2026-11-13, but `docs/releasing.md` still described the state of 9 November (0.0.1 as `latest`, a trusted publisher left to lapse) and `docs/supply-chain.md` still called a required reviewer optional. This step brings both documents up to date. It changes no code, workflow or setting.

Commits, by subject:

- `docs: bring the release docs up to date after 0.1.0`. In `docs/releasing.md`: Current state rewritten for 13 November 2026, and the one anchor to the old heading fixed; the dry-run paragraph rewritten for `main` at 0.1.0; the `stage` row and "Cutting a release" gain the environment approval (new step 6, later steps renumbered); the environment section describes today's settings. In `docs/supply-chain.md`: the stale "placeholder bootstrap" mention removed, the chain names the required reviewer, and the checklist checks it with a read-only `gh api` call. In `docs/INDEX.md`: both rows re-measured.
- `docs(review): step 90 scope and verification`. This file, and the review-file count and size in `docs/INDEX.md`.
- `docs: fix the pre-review findings on the release docs`. The four pre-review findings below, with this file and the `docs/INDEX.md` sizes.

**Facts and their sources.** The release facts come from the director's brief (from the user). These were checked read-only on 2026-11-13:

- `npm view @anishbenji/tscache dist-tags versions --json`: `latest` is `0.1.0`; versions `0.0.0-stage`, `0.0.1`, `0.1.0`.
- `gh run view 43470043079 --repo anishbenji/tscache`: conclusion `success`, head `b2e1f0697d1c089c25e3a8e8ce5318d76fbb585f` on ref `v0.1.0`; `plan`, `ci / ci`, `pack`, `stage` and `github-release-draft` succeeded, `stage-dry-run` and `ci / bench` skipped.
- `gh release view v0.1.0 --repo anishbenji/tscache`: not a draft, published `2026-11-13T17:21:12Z`.
- `gh api repos/anishbenji/tscache/environments/npm-publish`: protection rules `branch_policy` and `required_reviewers` (`anishbenji`). The expected output in the new supply-chain check is copied from this call.

Not checked here: the SLSA provenance and `npm audit signatures` result, the 2FA approval, and the re-creation date of the trusted publisher (npm account views); they are stated as the brief gives them.

**Dry-run paragraph.** Checked against `plan` in `.github/workflows/release.yml`: it warns in a dry run, and fails a real stage, when the version is not strictly above the highest published plain `X.Y.Z` version (prereleases ignored), when the commit is not on `origin/main`, and when `docs/releases/<version>.md` is missing. With `main` at 0.1.0, equal to `latest`, a dry run on `main` passes with the version warning until the next release bumps the version; `--force` lets `npm stage publish --dry-run` skip npm's own version check.

## Verification

| Command                                                             | Result                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------ |
| `bun run build`, then `bun run docs:check`                          | exit 0; `doc-anchors: 246 anchors in 42 pages resolve` |
| `bunx biome check docs/releasing.md docs/supply-chain.md`           | no fixes                                               |
| `grep -rn current-state-9-november .` (outside `.git`)              | no match after the change                              |
| `~/code/tscache-reports/bin/heavy-run.sh "90 child: ci" bun run ci` | exit 0 on `8f8cebc`                                    |

On the final head, after the pre-review fixes (wording only, so no full `bun run ci`, as the director asked): `bun run docs:check` and `bunx biome check docs/releasing.md docs/supply-chain.md docs/reviews/step-90.md docs/INDEX.md`, results in the director's report. The `can_admins_bypass` expected output was re-read with the same read-only `gh api` call on 2026-11-14.

## Pre-review (Claude), not the gate

The director's pre-review checked the release facts and found no P0 or P1. Its findings were fixed in `docs: fix the pre-review findings on the release docs`.

| #    | Sev | Finding                                                                                      | Decision | Resolution                                                                                                                                                                                                                                         |
| ---- | --- | -------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-1 | P2  | "Cutting a release" said `bunx git-cliff --tag vX.Y.Z -o CHANGELOG.md`, which rebuilds 0.1.0 | accepted | Step 1 now uses `bun run changelog --tag vX.Y.Z` (`--unreleased --prepend`, `package.json` and `cliff.toml`), says the new summary is hand-written, and keeps the `*(scope)*` to `_(scope)_` rewrite: `cliff.toml` line 28 still emits `*(scope)*` |
| PR-2 | P2  | "Retrying a failed stage" did not say a retried `stage` waits for the required reviewer      | accepted | One paragraph added: a new run on the tag or **Re-run failed jobs** waits again; approve under **Review deployments**, as in step 6                                                                                                                |
| PR-3 | P2  | `npm-publish` has `can_admins_bypass: true`; the supply-chain doc did not say so             | accepted | Chain step 3 says an admin (the maintainer alone) can bypass both rules; the checklist's jq call includes `can_admins_bypass` and its expected output, copied from a live read                                                                     |
| PR-4 | nit | The Verification table left the CI result open                                               | accepted | CI recorded as exit 0 on `8f8cebc`; the checks run on the final head stated above                                                                                                                                                                  |

## Contract-test changes

None.

## Decision concerns

None.
