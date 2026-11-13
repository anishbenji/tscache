# Releasing

How `@anishbenji/tscache` reaches npm. GitHub Actions (`.github/workflows/release.yml`) never makes a
version public: it **stages** the package with `npm stage publish`, and the maintainer **approves** the
staged version with two-factor authentication, which publishes it. That approval is the final human
gate for every release.

Staging uses npm trusted publishing: GitHub mints a short-lived OIDC token for the stage job, npm
exchanges it for a token that may only stage this package, and the same OIDC identity signs the
provenance statement. No npm token is ever created or stored, and the workflow reads no secret.

## Current state (13 November 2026)

- The npm account `anishbenji` exists, with two-factor authentication through a security key.
- `@anishbenji/tscache@0.1.0` is live on npm as `latest`, released on 13 November 2026 through the
  flow below. It carries an SLSA v1 provenance statement; `npm audit signatures` in a project that
  installs it verifies one registry signature and one attestation.
- The annotated tag `v0.1.0` points at `b2e1f06`, the merge commit of the release preparation on
  `main`. The release run it started (run 43470043079) succeeded, the maintainer approved the staged
  version with 2FA, and the GitHub release `v0.1.0` was published on 13 November 2026 at
  17:21:12 UTC.
- The trusted publisher (GitHub Actions, `anishbenji/tscache`, workflow `release.yml`, environment
  `npm-publish`) was re-created on 13 November 2026 and validated by the 0.1.0 stage. It allows only
  `npm stage publish`; `npm publish` and `npm dist-tag` are not allowed through it. Publishing access
  requires 2FA and disallows tokens, including bypass tokens.
- Since 13 November 2026 the `npm-publish` environment has the maintainer as required reviewer, so
  the `stage` job waits for an approval on GitHub before it runs. With the 2FA approval of the staged
  version on npm, a release has two human approvals.

Before every release, check that nothing is left in the staging area for the version you are about
to release: staged and published versions share one version index, so a pending stage of a version
blocks staging that version again.

```sh
npm login                                  # browser sign-in with the security key
npm stage list @anishbenji/tscache         # pending staged versions and their stage ids
```

## The release workflow

| Job                    | Runs when                | Permissions                         | Does                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`                 | always                   | `contents: read`                    | Reads the version; on a tag, fails unless the tag is `v<version>`; decides whether the run stages for real; for a real stage, fails unless the commit is on `main` and the version is above every published one; checks the release notes exist |
| `ci`                   | after `plan`             | `contents: read`                    | The full CI gate (`ci.yml` through `workflow_call`), without the bench job                                                                                                                                                                      |
| `pack`                 | after `ci`               | `contents: read`                    | Builds the package and packs the tarball that is staged, as a workflow artifact                                                                                                                                                                 |
| `stage`                | real stage only          | `contents: read`, `id-token: write` | In the `npm-publish` environment, after its required reviewer approves: `npm stage publish <tarball> --provenance --access public`; prints the stage id in the job summary                                                                      |
| `stage-dry-run`        | every other run          | none                                | `npm stage publish <tarball> --dry-run --force --access public`                                                                                                                                                                                 |
| `github-release-draft` | after a successful stage | `contents: write`                   | Creates a **draft** GitHub release for the tag from `docs/releases/<version>.md`                                                                                                                                                                |

A run stages for real when it runs on a `v*` tag and either the tag push started it, or it was started
by hand on that tag with **dry-run** unticked. Every other run is a dry run. Only plain `X.Y.Z`
versions are accepted: npm refuses a prerelease without `--tag`, and a staged package's tag cannot be
changed later. Only a commit on `main` is staged: `main` takes changes only through reviewed pull
requests, so a tag on any other commit fails `plan` (a dry run from another branch only warns). Both
stage jobs install npm 12.2.2 (staging needs npm 11.15.0 or later and Node 22.14.0
or later; the workflow uses Node 24).

The GitHub release is a draft because the version is not on npm until you approve it. You publish the
draft after approving.

## One-time setup

### Trusted publisher on npmjs.com

On npmjs.com: **Packages → @anishbenji/tscache → Settings → Trusted publishing**, choose
**GitHub Actions**, and enter:

| Field                | Value                                                             |
| -------------------- | ----------------------------------------------------------------- |
| Organization or user | `anishbenji`                                                      |
| Repository           | `tscache`                                                         |
| Workflow filename    | `release.yml` (the filename only)                                 |
| Environment name     | `npm-publish`                                                     |
| Allowed actions      | `npm stage publish` only; leave npm publish and dist-tag unticked |

The environment name must stay exactly `npm-publish` and the workflow filename exactly `release.yml`:
npm matches both against the OIDC token, so renaming either the environment in `release.yml` or the
file itself breaks staging until the trusted publisher is re-created to match. npm does not check the
values when you save them; a mistake shows only as an `ENEEDAUTH` error when the stage job runs.

**Validation.** A new trusted publisher must be validated by one CI publish within about two days
(npm: "within 2 days") of its creation, or it lapses and can no longer be used or edited. A dry run
does not count: `npm stage publish --dry-run` stages nothing on the registry. So create (or re-create)
the trusted publisher shortly before you push the release tag, after a dry run has passed, and let the
tag's stage validate it. If it lapses, delete it and create it again with the same fields.

Under **Settings → Publishing access**, keep **Require two-factor authentication and disallow tokens**.
Trusted publishing keeps working, because it uses no token.

### The `npm-publish` environment on GitHub

GitHub creates the environment the first time a job names it. Under **Settings → Environments** it
is limited to `v*` tags and has the maintainer as required reviewer (see
[`docs/supply-chain.md`](supply-chain.md) for the expected settings and how to check them). These are
repository settings, which you change by hand.

## Cutting a release

Before step 1, run through the checklist in [`docs/supply-chain.md`](supply-chain.md), which confirms
that each protection on the path from `main` to npm is still in place.

1. On a branch from `main`:
   - set `version` in `packages/tscache/package.json` to the new `X.Y.Z` (0.x semver: a minor release
     may break the API, a patch release never does). It must be above every version already on npm;
     the `plan` job checks this;
   - regenerate the changelog with `bunx git-cliff --tag vX.Y.Z -o CHANGELOG.md` and edit the summary
     at the top;
   - write the release notes in `docs/releases/X.Y.Z.md`; this file becomes the GitHub release text.
2. Open a pull request, let CI pass and merge it.
3. Run a dry run on `main` (see [Dry run](#dry-run)) and check that it passes with no warning: with the
   bumped version and its notes in place, a warning means the tag run would fail.
4. Check that the trusted publisher is validated, or re-create it with the same fields (GitHub
   Actions, anishbenji/tscache, release.yml, environment npm-publish, permission npm stage publish).
   Do this only now, after the merge and the dry run, because a new connection lapses unless the tag's
   stage validates it within two days.
5. Within two days of step 4, tag the merge commit on `main` and push the tag:

   ```sh
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. Follow the run with `gh run watch`. After `plan`, `ci` and `pack` pass, the `stage` job waits for
   the required reviewer of the `npm-publish` environment. Open the run on GitHub, choose
   **Review deployments**, tick `npm-publish` and **Approve and deploy**. Approve only a run started by
   the tag you pushed, on the commit you tagged.
7. When the run succeeds, the `stage` job summary shows
   `+ @anishbenji/tscache@X.Y.Z (staged with id <stage-id>)`, and a draft GitHub release exists.
8. Review the staged package. The stage commands need your own login (`npm login`); the workflow's
   OIDC token cannot run them.

   ```sh
   npm stage list @anishbenji/tscache   # find the stage id
   npm stage view <stage-id>            # details of the staged package
   npm stage download <stage-id>        # the tarball, to inspect or install locally
   ```

   On npmjs.com the same is under the package's **Staged Packages** tab.
9. Approve it, with your security key: **Approve** in the Staged Packages tab, or

   ```sh
   npm stage approve <stage-id>
   ```

   This publishes the version under `latest`. The provenance statement, signed during the OIDC stage
   publish, is published with it.
10. Publish the draft GitHub release: `gh release edit vX.Y.Z --draft=false`, or **Publish release** on
    the draft.
11. Check the result: `npm view @anishbenji/tscache@X.Y.Z`, the provenance badge on the npmjs.com
    package page, and the GitHub release. In a project that installs the package,
    `npm audit signatures` verifies the signature and the provenance attestation.

If the tag does not match the package version, the `plan` job fails before anything is built. Delete
the tag (`git push origin :refs/tags/vX.Y.Z` and `git tag -d vX.Y.Z`), fix the version, and tag again.
Nothing has been staged at that point.

## Dry run

Run the whole pipeline without staging, from any branch:

```sh
gh workflow run release.yml --ref main            # dry-run defaults to true
gh run watch
```

The `stage-dry-run` job runs `npm stage publish --dry-run --force`, which prints the tarball's file
list and size and changes nothing on the registry. `--force` skips only npm's client-side version
checks, which would otherwise fail every dry run whose version is not above the registry's, such as
`main` between two releases (today `main` says `0.1.0`, the same version as `latest` on npm). The
`plan` job makes the same check against `npm view @anishbenji/tscache versions` instead, ignoring
prereleases: a dry run reports a version that is not above the highest published one as a warning,
and a tag run fails on it before CI. So a dry run on `main` passes with that warning until the next
release bumps the version. A dry run also warns, but does not fail, when `docs/releases/<version>.md`
is missing, and when the commit is not on `main`. Staged versions are not public, so neither check
sees a pending stage; `npm stage list` does (see [Current state](#current-state-13-november-2026)).

## Retrying a failed stage

If a tag run failed before the stage succeeded (a flaky CI job, or a trusted-publisher mistake you
have since fixed), start the workflow by hand on the tag with dry-run unticked:

```sh
gh workflow run release.yml --ref vX.Y.Z -f dry-run=false
```

If the version is already staged, npm refuses to stage it again; reject the old stage first
(`npm stage reject <stage-id>`, which asks for 2FA). The draft-release step skips a release that
already exists.

**If `stage` succeeded but `github-release-draft` failed**, the staged package is good: do not reject
it, and do not start a new run, which would fail because the version is already staged. Either open
the original run and use **Re-run failed jobs**, which keeps `plan`'s outputs and the uploaded
tarball and runs only the draft job again, or create the draft by hand from a checkout of the tag:

```sh
gh release create vX.Y.Z --draft --verify-tag --title vX.Y.Z --notes-file docs/releases/X.Y.Z.md
```

Never reject a good stage only to get the draft.

## Rollback limits

- **Before approval, rejecting is free.** `npm stage reject <stage-id>` (2FA) removes the staged
  package; nothing was ever public. Delete the draft GitHub release too, fix the problem, and stage
  again.
- **After approval, a published version cannot be replaced.** Plan for a fix-forward release.
- **A version number is never reusable.** Even after an unpublish, npm refuses that version again; the
  fix is always a new version.
- **Unpublish only within 72 hours**, and only while no other package in the registry depends on it.
  After 72 hours npm allows it only when no package depends on it, it had fewer than 300 downloads in
  the last week, and it has a single owner. Unpublishing every version blocks any new publish of the
  package for 24 hours.
- **Prefer deprecation.** `npm deprecate @anishbenji/tscache@X.Y.Z "<reason>; use X.Y.Z+1"` (after
  `npm login`, with 2FA) warns every installer and keeps installs working. Then ship the fix as a patch
  release.
- **Moving `latest` is a manual step.** The trusted publisher cannot change dist-tags. If a bad version
  is `latest`, run `npm dist-tag add @anishbenji/tscache@<good> latest` yourself after `npm login`.
- The GitHub release can be edited or deleted, but keep the tag: it records what was published.

## References

- npm, [Staged publishing for npm packages](https://docs.npmjs.com/staged-publishing)
- npm, [`npm stage`](https://docs.npmjs.com/cli/v11/commands/npm-stage)
- npm, [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers)
- npm, [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements)
- npm, [Unpublish policy](https://docs.npmjs.com/policies/unpublish)
- GitHub, [Reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
- GitHub, [Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
