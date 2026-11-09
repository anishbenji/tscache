# Step 64 — Release workflow

Branch: `ci/64-release-workflow` · Status: built, awaiting review

A tag-triggered release workflow **stages** `@anishbenji/tscache` on npm with `npm stage publish`
through trusted publishing (OIDC), with provenance, after the full CI gate, and drafts the GitHub
release from the release notes. The maintainer approves the staged version with 2FA, which publishes
it; that approval is the final human gate. The maintainer steps are in `docs/releasing.md`. No npm
token is created, read or stored, and the workflow references no secret.

## Revision 2 (user decision, 9 November 2026)

The user created the npm account (2FA through a security key) and the package, whose first publish
was staged, so npm shows its `0.0.0-stage` placeholder. The trusted publisher allows only
`npm stage publish`; `npm publish` and `npm dist-tag` are not allowed, and tokens are disallowed.
Changes:

- The real job is `stage`: `npm stage publish <tarball> --provenance --access public`. The dry run is
  `npm stage publish --dry-run`, the stage command's own dry run.
- Both stage jobs install the exact npm 12.2.2 instead of relying on the bundled npm.
- The GitHub release is created as a draft (`github-release-draft`), published by the maintainer after
  approval.
- `docs/releasing.md` drops the hand-published 0.0.1 bootstrap and documents the staged flow.

## Scope

| File                            | What                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`      | A `workflow_call` trigger with one boolean input, `skip-bench` (default `false`), and `if:` on `bench`.   |
| `.github/workflows/release.yml` | `plan` → `ci` → `pack` → `stage` or `stage-dry-run` → `github-release-draft`.                             |
| `docs/releasing.md`             | Current state, trusted-publisher setup, cutting a release, review and approval, dry run, retry, rollback. |
| `site/contributing.md`          | One sentence linking `docs/releasing.md`.                                                                 |

## Design

- **Triggers.** A pushed `v*` tag, and `workflow_dispatch` with a boolean `dry-run` (default `true`).
  A run stages for real only on a `v*` tag ref, started either by the tag push or by hand with
  `dry-run` unticked (the retry path). Every other run is a dry run. The `plan` job computes this once
  as the `stage` output; the later jobs read only that output.
- **Version check.** On a tag, `plan` fails unless the tag is exactly `v<version>` from
  `packages/tscache/package.json`, before CI runs. Only plain `X.Y.Z` is accepted: npm refuses a
  prerelease without `--tag`, the workflow sets none, and a staged package's tag cannot be changed
  later. A real stage also fails in `plan` when `docs/releases/<version>.md` is missing; a dry run only
  warns.
- **CI through `workflow_call`.** `ci.yml` gains the trigger. On push, pull request and manual runs
  the `inputs` context is empty, `!inputs.skip-bench` is true, and both jobs run as before. The release
  passes `skip-bench: true`: the bench job compares a head against a base, and on a tag push or a
  manual run its base resolves to `HEAD`, so the comparison means nothing and a timing-noise failure
  could block a release. The concurrency groups differ (`ci-<ref>` in the called workflow,
  `release-<ref>` in the caller), so neither cancels the other, which GitHub warns about when caller
  and callee share a group.
- **Build and stage are separate jobs.** `pack` installs dependencies, builds (tsdown, publint, attw)
  and packs the tarball with no OIDC permission, then uploads it as an artifact. `stage` checks out
  nothing and installs no project dependency: it sets up Node, installs the pinned npm, downloads the
  tarball and stages it. Dependency install scripts and build tooling never run in a job that can mint
  an OIDC token.
- **Staging a tarball is supported.** `npm stage publish [<package-spec>]` takes the same
  `<package-spec>` as `npm publish`. In npm's source (`lib/commands/stage/publish.js` on the `latest`
  tag, 12.2.2), `StagePublish` extends `Publish` and differs only in `stage = true`; `publish.js`
  notes that "you can publish name@version, ./foo.tgz, etc", and the stage branch sends the same
  manifest and tarball data with `stage: true`. Lifecycle scripts run only for directory specs, so the
  tarball spec also keeps project scripts out of the OIDC job.
- **Dry runs never get OIDC.** `stage-dry-run` runs the same steps with `--dry-run`, no environment and
  no permissions. With `--dry-run`, npm skips the registry call and only warns when there are no
  credentials (`publish.js`). Keeping dry runs out of `npm-publish` also lets step 66 restrict that
  environment to `v*` tags without breaking dry runs from `main`.
- **npm version.** Staged publishing needs npm 11.15.0 or later and Node 22.14.0 or later. Both stage
  jobs run `npm install --global npm@12.2.2` and fail unless `npm --version` then prints exactly
  `12.2.2`. 12.2.2 is npm's `latest` dist-tag, released 4 November 2026; its `engines.node` is
  `^22.22.2 || ^24.15.0 || >=26.0.0`, and `setup-node` with `node-version: 24` resolves to 24.22.2.
  The version is one workflow-level variable, `NPM_VERSION`. The bundled npm (11.19.1 in Node
  24.22.2) is newer than 11.15.0, but the pin makes the version explicit, as the brief asked.
- **No `registry-url` on `setup-node`.** It would write an `.npmrc` that reads `NODE_AUTH_TOKEN`, and
  no token exists. `package-manager-cache: false` everywhere, as npm's documentation recommends for
  release builds.
- **Stage id.** npm prints `+ <name>@<version> (staged with id <stage-id>)`. The `stage` step runs
  under `shell: bash` (so `-o pipefail` applies to the `tee`), and copies that line into the job summary
  with the approval instructions. The OIDC token cannot run `npm stage list`, `view` or `approve`
  ("Shortlived tokens cannot run `npm stage` subcommands"), so the workflow does not try.
- **Draft GitHub release (decision).** The director offered a draft release or a release that says it
  goes live after approval. A draft is recommended and chosen: until approval nothing is on npm, a
  published release would announce a version that may still be rejected, and a draft keeps npm
  approval as the single gate; the maintainer publishes the draft afterwards (`gh release edit
  vX.Y.Z --draft=false`). `github-release-draft` runs only after `stage` succeeds, and skips a release
  that already exists, so a retried run does not fail there.
- **Injection.** No `${{ }}` expression appears inside a `run:` script; every value reaches the shell
  through `env:` (checked by extracting every `run:` block, see Verification).

## Permissions

The workflow default is `permissions: {}`: no job inherits anything, and each states its own.

| Job                    | Permission        | Why                                                                                                                                               |
| ---------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`                 | `contents: read`  | `actions/checkout` reads the repository for `package.json` and the release notes.                                                                 |
| `ci`                   | `contents: read`  | The caller job's permissions cap the called workflow; `ci.yml` checks out the repository and declares `contents: read` itself.                    |
| `pack`                 | `contents: read`  | Checkout. The artifact upload uses the runner's Actions runtime token, not `GITHUB_TOKEN`.                                                        |
| `stage`                | `contents: read`  | Required by the brief; stating any permission sets the rest to none. The job itself checks out nothing.                                           |
| `stage`                | `id-token: write` | Lets the job request a GitHub OIDC token, which npm exchanges for a short-lived token limited to `npm stage publish`, and which signs provenance. |
| `stage-dry-run`        | none (`{}`)       | It downloads the artifact (runtime token) and runs `npm stage publish --dry-run`, which needs no credential.                                      |
| `github-release-draft` | `contents: write` | `gh release create --draft` creates a release, which needs write access to repository contents. Only this job has it, and only after a stage.     |

`stage` also runs in the environment `npm-publish`, the environment named in the trusted-publisher
configuration on npmjs.com. Every checkout sets `persist-credentials: false`, so no job leaves a token
in `.git/config`.

## Pinned actions and tools

Each action is pinned to the full commit SHA of its latest release, looked up on 9 November 2026 with
`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha` (and `releases/latest` for the tag). The first
four match the pins `ci.yml` already uses.

| Action                      | Version | SHA                                        | Used in                                |
| --------------------------- | ------- | ------------------------------------------ | -------------------------------------- |
| `actions/checkout`          | v7.0.1  | `3d3c42e5aac5ba805825da76410c181273ba90b1` | `plan`, `pack`, `github-release-draft` |
| `actions/setup-node`        | v7.1.0  | `949feb2413d6458794dcd2491c4babbbce0c15c1` | `pack`, `stage`, `stage-dry-run`       |
| `oven-sh/setup-bun`         | v2.2.0  | `0c5077e51419868618aeaa5fe8019c62421857d6` | `pack`                                 |
| `actions/upload-artifact`   | v7.0.2  | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | `pack`                                 |
| `actions/download-artifact` | v8.0.2  | `9000827ccba6bdab643e8b6fd33ac0654aef8333` | `stage`, `stage-dry-run`               |

| Tool | Version                                                                            | Verified with                                                        |
| ---- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| npm  | 12.2.2 (`latest`; git tag `v12.2.2` at `60e11343e61316d966c86805d803df5a0eb99230`) | `npm view npm@12.2.2 version engines`, `npm view npm time`, `gh api` |
| Node | 24 (resolves to 24.22.2 on 9 November 2026)                                        | `https://nodejs.org/dist/index.json`                                 |

`setup-node`'s `package-manager-cache` input and `download-artifact`'s `name` and `path` inputs were
read from each action's `action.yml` at the pinned SHA. `gh` is preinstalled on GitHub-hosted runners
and is not an action.

## Doc sources

| Claim                                                                                                                                   | Source                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Staged publishing needs npm ≥ 11.15.0 and Node ≥ 22.14.0; staging a new package creates `0.0.0-stage`                                   | npm, [Staged publishing](https://docs.npmjs.com/staged-publishing)                                                                                     |
| `npm stage list`, `view`, `download` need no 2FA; `approve` (CLI or Staged Packages tab) prompts for 2FA                                | same, and npm, [`npm stage`](https://docs.npmjs.com/cli/v11/commands/npm-stage)                                                                        |
| `npm stage publish [<package-spec>]` flags: `--tag`, `--access`, `--dry-run`, `--provenance`                                            | npm, [`npm stage`](https://docs.npmjs.com/cli/v11/commands/npm-stage)                                                                                  |
| Staged and published versions share one version index; prerelease needs `--tag`; tag is immutable; reject then re-stage                 | same                                                                                                                                                   |
| OIDC tokens can run `npm stage publish` (if allowed) but no `npm stage` subcommand                                                      | same                                                                                                                                                   |
| Trusted publishing needs npm ≥ 11.5.1 and Node ≥ 22.14.0, GitHub-hosted runners, and `id-token: write`                                  | npm, [Trusted publishing](https://docs.npmjs.com/trusted-publishers)                                                                                   |
| Publisher fields; allowed actions (stage publish always allowed); config expiry within 2 days                                           | same                                                                                                                                                   |
| npm validates the calling workflow's filename under `workflow_call`                                                                     | same (so the stage job lives in `release.yml` itself)                                                                                                  |
| `repository.url` must match the GitHub repository                                                                                       | same; `packages/tscache/package.json` has `git+https://github.com/anishbenji/tscache.git`                                                              |
| "Require two-factor authentication and disallow tokens" keeps trusted publishing working                                                | same                                                                                                                                                   |
| Provenance needs a cloud-hosted runner                                                                                                  | npm, [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements)                                                       |
| Unpublish within 72 h without dependents; after that only < 300 weekly downloads, one owner, no dependents; a version is never reusable | npm, [Unpublish policy](https://docs.npmjs.com/policies/unpublish)                                                                                     |
| Called-workflow permissions can only be kept or reduced; `github` context is the caller's; shared concurrency groups cancel the caller  | GitHub, [Reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)          |
| Secrets reach a called workflow only when passed                                                                                        | GitHub, [Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)                                                |
| Referencing a missing environment creates it without protection rules; required reviewers; tag rules                                    | GitHub, [Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) |
| Tarball spec, dry-run behaviour and the stage-id line                                                                                   | npm CLI source, `lib/commands/publish.js` and `lib/commands/stage/publish.js` at tag `latest` (12.2.2)                                                 |

## Verification

- Both workflows parse as YAML (`Bun.YAML.parse`), and the parsed jobs show the intended `needs`, `if`,
  `environment` and `permissions`.
- Every `run:` block passes `bash -n`; none contains a `${{ }}` expression; every `uses:` is a 40-hex
  SHA.
- The `plan` script was run locally against the real `package.json` (version 0.0.0) with simulated
  inputs: a matching tag push stages when the notes exist and fails when they are missing; a
  mismatched tag fails with the expected message; a dispatch on `main` is a dry run whatever `dry-run`
  says; a dispatch on a tag stages only with `dry-run` false.
- The `pack` script was run locally after `bun run build`: `npm pack --pack-destination` writes
  `anishbenji-tscache-0.0.0.tgz`, the name the step expects.
- The summary's `grep -E '\(staged'` matches the line format in npm's source.
- `bun run ci` through the heavy-job lock on the final head (result in the step report).

## Not verified

- The workflow has not run on GitHub: no tag, no dispatch. The rehearsal after steps 63 and 64 merge
  dispatches it with `dry-run` true.
- `actionlint` is not installed on this machine and was not added.
- `npm stage publish --dry-run` on the packed tarball was not run locally: the agent's command guard
  blocks any npm publish command in unattended runs. The `stage-dry-run` job exercises it on the first
  dispatch.
- The OIDC exchange, the stage itself and provenance signing can only be checked by the first real
  stage; whether a stage counts as the trusted publisher's first "publish" for its 2-day expiry is not
  documented.
