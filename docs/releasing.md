# Releasing

How `@anishbenji/tscache` is published to npm. Releases run from GitHub Actions
(`.github/workflows/release.yml`) through npm trusted publishing: GitHub mints a short-lived OIDC token
for the publish job, npm exchanges it for a one-time publish token, and the same token signs the
provenance statement. No npm token is ever created or stored, and the workflow reads no secret.

The only publish done by hand is the one-time `0.0.1` placeholder below, because npm configures a
trusted publisher on a package that already exists.

## The release workflow

| Job               | Runs when                    | Permissions                         | Does                                                                                                                                 |
| ----------------- | ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `plan`            | always                       | `contents: read`                    | Reads the version; on a tag, fails unless the tag is `v<version>`; decides whether the run publishes; checks the release notes exist |
| `ci`              | after `plan`                 | `contents: read`                    | The full CI gate (`ci.yml` through `workflow_call`), without the bench job                                                           |
| `pack`            | after `ci`                   | `contents: read`                    | Builds the package and packs the tarball that is published, as a workflow artifact                                                   |
| `publish`         | real publish only            | `contents: read`, `id-token: write` | In the `npm-publish` environment: `npm publish <tarball> --provenance --access public`                                               |
| `publish-dry-run` | every other run              | none                                | `npm publish <tarball> --dry-run --access public`                                                                                    |
| `github-release`  | after a successful `publish` | `contents: write`                   | Creates the GitHub release for the tag from `docs/releases/<version>.md`                                                             |

A run publishes for real when it runs on a `v*` tag and either the tag push started it, or it was
started by hand on that tag with **dry-run** unticked. Every other run is a dry run. Only plain
`X.Y.Z` versions are accepted: a prerelease would need its own dist-tag, which the workflow does not
set.

## One-time setup

### 1. Publish the 0.0.1 placeholder (by hand)

You need the npm account `anishbenji` with two-factor authentication enabled for writes. The
placeholder holds only a `package.json` and a README, so no code ships under 0.0.1.

```sh
npm login                     # opens the browser; complete the 2FA prompt
npm whoami                    # prints: anishbenji

dir="$(mktemp -d)" && cd "$dir"
cat > package.json <<'EOF'
{
  "name": "@anishbenji/tscache",
  "version": "0.0.1",
  "description": "Placeholder that reserves the name. Install 0.1.0 or later.",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/anishbenji/tscache.git",
    "directory": "packages/tscache"
  }
}
EOF
printf '# @anishbenji/tscache\n\nPlaceholder. Install 0.1.0 or later: https://github.com/anishbenji/tscache\n' > README.md

npm publish --access public   # asks for a one-time password from the authenticator
npm view @anishbenji/tscache  # shows version 0.0.1
npm logout                    # ends the CLI session and revokes its token
```

After 0.1.0 is published, mark the placeholder deprecated (this asks for 2FA again after `npm login`):

```sh
npm deprecate @anishbenji/tscache@0.0.1 "Placeholder; install 0.1.0 or later."
```

### 2. Configure the trusted publisher on npmjs.com

On npmjs.com: **Packages → @anishbenji/tscache → Settings → Trusted publishing**, choose
**GitHub Actions**, and enter:

| Field                | Value                                    |
| -------------------- | ---------------------------------------- |
| Organization or user | `anishbenji`                             |
| Repository           | `tscache`                                |
| Workflow filename    | `release.yml` (the filename only)        |
| Environment name     | `npm-publish`                            |
| Allowed actions      | tick **npm publish** (direct publishing) |

npm does not check these values when you save them; a mistake shows only as an `ENEEDAUTH` error at
publish time. A configuration created after 3 September 2026 allows only `npm stage publish` unless
direct publishing is ticked, and this workflow runs `npm publish`.

A new trusted-publisher configuration expires unless its first publish succeeds **within 2 days**. Set
it up shortly before you push the first tag, after the dry run below has passed. If it expires,
delete it and create it again.

Then, under **Settings → Publishing access**, choose **Require two-factor authentication and disallow
tokens**. Trusted publishing keeps working, because it does not use a token.

### 3. The `npm-publish` environment on GitHub

GitHub creates the environment the first time a job names it. Creating it beforehand under
**Settings → Environments** lets you limit it to `v*` tags and add yourself as a required reviewer,
so every real publish waits for your approval. These are repository settings, which you change by
hand.

## Cutting a release

1. On a branch from `main`:
   - set `version` in `packages/tscache/package.json` to the new `X.Y.Z` (0.x semver: a minor release
     may break the API, a patch release never does);
   - regenerate the changelog with `bunx git-cliff --tag vX.Y.Z -o CHANGELOG.md` and edit the
     summary at the top;
   - write the release notes in `docs/releases/X.Y.Z.md`; this file becomes the GitHub release text.
2. Open a pull request, let CI pass and merge it.
3. Tag the merge commit on `main` and push the tag:

   ```sh
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

4. Follow the run with `gh run watch` (or in the Actions tab), and approve the `npm-publish`
   deployment if the environment requires a reviewer.
5. Check the result: `npm view @anishbenji/tscache@X.Y.Z`, the provenance badge on the npmjs.com
   package page, and the GitHub release for `vX.Y.Z`. In a project that installs the package,
   `npm audit signatures` verifies the signature and the provenance attestation.

If the tag does not match the package version, the `plan` job fails before anything is built. Delete
the tag (`git push origin :refs/tags/vX.Y.Z` and `git tag -d vX.Y.Z`), fix the version, and tag again.
Nothing has been published at that point.

## Dry run

Run the whole pipeline without publishing, from any branch:

```sh
gh workflow run release.yml --ref main            # dry-run defaults to true
gh run watch
```

The `publish-dry-run` job prints the tarball's file list and size as npm would publish it. A dry run
on `main` warns, but does not fail, when `docs/releases/<version>.md` is missing.

## Retrying a failed publish

If a tag run failed after `plan` (a flaky CI job, or a trusted-publisher mistake you have since
fixed), start the workflow by hand on the tag with dry-run unticked:

```sh
gh workflow run release.yml --ref vX.Y.Z -f dry-run=false
```

The GitHub release step skips a release that already exists. If the version did reach npm, npm
refuses to publish it again; check `npm view @anishbenji/tscache versions` first.

## Rollback limits

A published version cannot be replaced. Plan for a fix-forward release rather than a rollback.

- **A version number is never reusable.** Even after an unpublish, npm refuses that version again;
  the fix is always a new version.
- **Unpublish only within 72 hours**, and only while no other package in the registry depends on it.
  After 72 hours npm allows it only when no package depends on it, it had fewer than 300 downloads in
  the last week, and it has a single owner. Unpublishing every version blocks any new publish of the
  package for 24 hours.
- **Prefer deprecation.** `npm deprecate @anishbenji/tscache@X.Y.Z "<reason>; use X.Y.Z+1"` warns
  every installer and keeps installs working. Then ship the fix as a patch release.
- **Move `latest` if needed.** If a bad version is `latest`, `npm dist-tag add @anishbenji/tscache@<good>
  latest` (after `npm login`) points new installs at a good one while the fix is prepared.
- The GitHub release can be edited or deleted, but keep the tag: it records what was published.

## References

- npm, [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers)
- npm, [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements)
- npm, [Unpublish policy](https://docs.npmjs.com/policies/unpublish)
- GitHub, [Reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
- GitHub, [Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
