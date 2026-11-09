# Step 64 — Release workflow

Branch: `ci/64-release-workflow` · Status: built, awaiting review

A tag-triggered release workflow publishes `@anishbenji/tscache` to npm through trusted publishing
(OIDC) with provenance, after the full CI gate, and creates the GitHub release from the release
notes. The maintainer steps are in `docs/releasing.md`. No npm token is created, read or stored, and
the workflow references no secret.

## Scope

| File                            | What                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`      | A `workflow_call` trigger with one boolean input, `skip-bench` (default `false`), and `if:` on `bench`. |
| `.github/workflows/release.yml` | The release workflow: `plan` → `ci` → `pack` → `publish` or `publish-dry-run` → `github-release`.       |
| `docs/releasing.md`             | Placeholder bootstrap, trusted-publisher setup, cutting a release, dry run, retry, rollback limits.     |
| `site/contributing.md`          | One sentence linking `docs/releasing.md`.                                                               |

## Design

- **Triggers.** A pushed `v*` tag, and `workflow_dispatch` with a boolean `dry-run` (default `true`).
  A run publishes for real only on a `v*` tag ref, started either by the tag push or by hand with
  `dry-run` unticked (the retry path). Every other run is a dry run. The `plan` job computes this once
  as an output; the publish jobs read only that output.
- **Version check.** On a tag, `plan` fails unless the tag is exactly `v<version>` from
  `packages/tscache/package.json`, before CI runs. Only plain `X.Y.Z` is accepted: a prerelease would
  otherwise publish under `latest`, since the workflow sets no dist-tag. A real publish also fails in
  `plan` when `docs/releases/<version>.md` is missing; a dry run only warns.
- **CI through `workflow_call`.** `ci.yml` gains the trigger. On push, pull request and manual runs
  the `inputs` context is empty, `!inputs.skip-bench` is true, and both jobs run as before. The release
  passes `skip-bench: true`: the bench job compares a head against a base, and on a tag push or a
  manual run its base resolves to `HEAD`, so the comparison means nothing and a timing-noise failure
  could block a release. The concurrency groups differ (`ci-<ref>` in the called workflow,
  `release-<ref>` in the caller), so neither cancels the other, which GitHub warns about when caller
  and callee share a group.
- **Build and publish are separate jobs.** `pack` installs dependencies, builds (tsdown, publint,
  attw) and packs the tarball with no OIDC permission, then uploads it as an artifact. `publish`
  checks out nothing, installs nothing and runs no project code: it sets up Node, makes sure npm is at
  least 11.5.1, downloads the tarball and runs `npm publish <tarball> --provenance --access public`.
  Dependency install scripts and build tooling therefore never run in a job that can mint an OIDC
  token.
- **Dry runs never get OIDC.** The brief describes one publish job that switches to `--dry-run`. That
  job would hold `id-token: write` on every dry run, and once step 66 restricts the `npm-publish`
  environment to `v*` tags, a dry run from `main` could not enter it at all. A second job,
  `publish-dry-run`, runs the same steps with `--dry-run`, no environment and no permissions.
- **No `registry-url` on `setup-node`.** It would write an `.npmrc` that reads `NODE_AUTH_TOKEN`,
  and no token exists. npm's default registry is `registry.npmjs.org`. `package-manager-cache: false`
  everywhere, as npm's documentation recommends for release builds.
- **npm version.** Node 24.22.2 (27 October 2026) bundles npm 11.19.1, already at least 11.5.1. The
  `Ensure npm >= 11.5.1` step compares with `sort -V` and installs the pinned `npm@11.21.2` (the
  newest 11.x on 9 November 2026) only when the bundled npm is older. The comparison was exercised for
  11.3.0 (upgrade), 11.5.1, 11.19.1 and 12.2.1 (keep).
- **GitHub release.** `github-release` runs only after `publish` succeeds, with `gh release create
  "$TAG" --verify-tag --notes-file docs/releases/<version>.md`. It skips a release that already
  exists, so a retried run does not fail there.
- **Injection.** No `${{ }}` expression appears inside a `run:` script; every value reaches the
  shell through `env:` (checked by extracting every `run:` block, see Verification).

## Permissions

The workflow default is `permissions: {}`: no job inherits anything, and each states its own.

| Job               | Permission        | Why                                                                                                                                     |
| ----------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`            | `contents: read`  | `actions/checkout` reads the repository for `package.json` and the release notes.                                                       |
| `ci`              | `contents: read`  | The caller job's permissions cap the called workflow; `ci.yml` needs to check out the repository and declares `contents: read` itself.  |
| `pack`            | `contents: read`  | Checkout. The artifact upload uses the runner's Actions runtime token, not `GITHUB_TOKEN`.                                              |
| `publish`         | `contents: read`  | Declared because stating any permission sets the rest to none; the job itself checks out nothing.                                       |
| `publish`         | `id-token: write` | Lets the job request a GitHub OIDC token, which npm exchanges for a short-lived publish token and which signs the provenance statement. |
| `publish-dry-run` | none (`{}`)       | It downloads the artifact (runtime token) and runs `npm publish --dry-run`, which needs no credential.                                  |
| `github-release`  | `contents: write` | `gh release create` creates a release, which needs write access to repository contents. Only this job has it, and only after a publish. |

`publish` also runs in the environment `npm-publish`, the environment named in the trusted-publisher
configuration on npmjs.com. Every checkout sets `persist-credentials: false`, so no job leaves a
token in `.git/config`.

## Pinned actions

Each action is pinned to the full commit SHA of its latest release, looked up on 9 November 2026 with
`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha` (and `releases/latest` for the tag). The first
four match the pins `ci.yml` already uses.

| Action                      | Version | SHA                                        | Used in                              |
| --------------------------- | ------- | ------------------------------------------ | ------------------------------------ |
| `actions/checkout`          | v7.0.1  | `3d3c42e5aac5ba805825da76410c181273ba90b1` | `plan`, `pack`, `github-release`     |
| `actions/setup-node`        | v7.1.0  | `949feb2413d6458794dcd2491c4babbbce0c15c1` | `pack`, `publish`, `publish-dry-run` |
| `oven-sh/setup-bun`         | v2.2.0  | `0c5077e51419868618aeaa5fe8019c62421857d6` | `pack`                               |
| `actions/upload-artifact`   | v7.0.2  | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | `pack`                               |
| `actions/download-artifact` | v8.0.2  | `9000827ccba6bdab643e8b6fd33ac0654aef8333` | `publish`, `publish-dry-run`         |

`setup-node`'s `package-manager-cache` input and `download-artifact`'s `name` and `path` inputs were
read from each action's `action.yml` at the pinned SHA. `gh` is preinstalled on GitHub-hosted runners
and is not an action.

## Doc sources

| Claim                                                                                                                                                                                | Source                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trusted publishing needs npm ≥ 11.5.1 and Node ≥ 22.14.0, GitHub-hosted runners, and `id-token: write`                                                                               | npm, [Trusted publishing](https://docs.npmjs.com/trusted-publishers)                                                                                   |
| Publisher fields: user, repository, workflow filename only, optional environment, allowed actions                                                                                    | same                                                                                                                                                   |
| Configurations created after 3 Sep 2026 allow only `npm stage publish` unless direct publishing is ticked                                                                            | same                                                                                                                                                   |
| A new configuration expires unless its first publish succeeds within 2 days                                                                                                          | same                                                                                                                                                   |
| npm validates the calling workflow's filename under `workflow_call`                                                                                                                  | same (so the publish job lives in `release.yml` itself)                                                                                                |
| `repository.url` must match the GitHub repository                                                                                                                                    | same; `packages/tscache/package.json` has `git+https://github.com/anishbenji/tscache.git`                                                              |
| "Require two-factor authentication and disallow tokens" keeps trusted publishing working                                                                                             | same                                                                                                                                                   |
| Provenance needs a cloud-hosted runner; `npm publish --provenance --access public`                                                                                                   | npm, [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements)                                                       |
| Unpublish within 72 h without dependents; after that only < 300 weekly downloads, one owner, no dependents; a version is never reusable; 24 h block after unpublishing every version | npm, [Unpublish policy](https://docs.npmjs.com/policies/unpublish)                                                                                     |
| Called-workflow permissions can only be kept or reduced; `github` context is the caller's; shared concurrency groups cancel the caller                                               | GitHub, [Reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)          |
| Secrets reach a called workflow only when passed                                                                                                                                     | GitHub, [Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)                                                |
| Referencing a missing environment creates it without protection rules; required reviewers; tag rules                                                                                 | GitHub, [Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) |
| Node 24.22.2 bundles npm 11.19.1                                                                                                                                                     | `https://nodejs.org/dist/index.json`                                                                                                                   |
| Newest npm 11.x is 11.21.2                                                                                                                                                           | `npm view npm dist-tags` (`next-11`)                                                                                                                   |

## Verification

- Both workflows parse as YAML (`Bun.YAML.parse`), and the parsed jobs show the intended `needs`,
  `if` and `permissions`.
- Every `run:` block of `release.yml` was extracted and passed `bash -n`; none contains a `${{ }}`
  expression.
- The `plan` script was run locally against the real `package.json` (version 0.0.0) with simulated
  inputs: a matching tag push publishes when the notes exist and fails when they are missing; a
  mismatched tag fails with the expected message; a dispatch on `main` is a dry run whatever
  `dry-run` says; a dispatch on a tag publishes only with `dry-run` false.
- The `pack` script was run locally after `bun run build`: `npm pack --pack-destination` writes
  `anishbenji-tscache-0.0.0.tgz`, the name the step expects.
- `bun run ci` through the heavy-job lock on the final head (result in the step report).

## Not verified

- The workflow has not run on GitHub: no tag, no dispatch. The rehearsal after steps 63 and 64 merge
  dispatches it with `dry-run` true.
- `actionlint` is not installed on this machine and was not added.
- `npm publish --dry-run` on the packed tarball was not run locally: the agent's command guard blocks
  any `npm publish` in unattended runs. The `publish-dry-run` job exercises it on the first dispatch.
- The OIDC exchange and provenance signing can only be checked by the first real publish.
