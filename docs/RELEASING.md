# Releasing Flow

A release is one tagged commit on `main`, built once and published three
ways: an npm package, a container image, and a GitHub Release that records
both. An installation runs a release it chose, by version and fingerprint,
never a branch. This is the same release track as
[Field](https://github.com/arcforgelabs/field/blob/main/docs/RELEASING.md).

## What a release produces

| Output | Where | How you verify it |
| --- | --- | --- |
| npm package `@arcforgelabs/flow@<version>` | [npmjs.com](https://www.npmjs.com/package/@arcforgelabs/flow) | `npm audit signatures` after install: the registry signature and SLSA v1 provenance from trusted publishing. No npm token is stored anywhere. |
| Image `ghcr.io/arcforgelabs/flow@sha256:…` | [GHCR](https://github.com/arcforgelabs/flow/pkgs/container/flow) | `gh attestation verify oci://ghcr.io/arcforgelabs/flow@sha256:… --repo arcforgelabs/flow`: GitHub's build provenance and SBOM attestations for that digest |
| GitHub Release `v<version>` | [Releases](https://github.com/arcforgelabs/flow/releases) | `sha256sum -c <file>.sha256` for each asset |

Each GitHub Release has these assets, each with a `.sha256` file:

- `release-manifest.json`: the version, channel, commit, the result of every
  check lane, the npm integrity and shasum, the tarball's SHA-256, the image
  digest and tags, and the schema migrations the release contains.
- `postpublish-evidence.json`: what the publish run verified from outside,
  after publishing: `npm audit signatures`, the npm provenance type, and the
  image's verified attestations.
- `arcforgelabs-flow-<version>.tgz`: the npm tarball, byte for byte.
- `flow-image-<version>.spdx.json`: the image's SBOM.
- `flow-server-<version>.cdx.json`: an SBOM of the server's production
  dependencies.

The notes are GitHub's generated notes: the pull requests merged since the
last release.

## Versions and channels

Versions are calendar versions with no leading zeros. A stable release is
`2026.10.18`. A beta is a pre-release of the **upcoming** stable version, so
`2026.10.18-beta.1` and `2026.10.18-beta.2` come before `2026.10.18`. Tags
add a `v`, and each GitHub Release is titled `flow <version>`.
`package.json` holds the upcoming stable version.
`scripts/release/release.mjs` holds the rules, and `test/release.test.js`
tests them.

| Channel | npm dist-tag | Image tags | GitHub Release |
| --- | --- | --- | --- |
| beta | `beta` | `<version>`, `beta` | pre-release |
| stable | `latest` | `<version>`, `stable`, `latest` | release, marked latest |

A release reaches its channel when it is published; there is no separate
step.

## The workflows

| Workflow | Starts | Does |
| --- | --- | --- |
| `flow-release-prepare.yml` (Flow Release Prepare) | By hand, from `main` | Takes a `main` commit (default: the head) whose required checks passed: `test` and `gitleaks`, the checks the main ruleset requires (`scripts/deploy-checks.js`). Plans the next tag for the channel, creates it, and starts Flow Release Publish. |
| `flow-release-checks.yml` (Flow Release Checks) | From Flow Release Publish | Requires the tag to be a calendar version on `main` that matches `package.json`. Runs every CI lane on its commit (`.github/workflows/ci.yml`: `test`, `docker-build`, `package`). Packs the npm tarball with a shrinkwrap of the tested dependencies, then installs it in an empty directory and starts it against PostgreSQL. Publishes nothing. |
| `flow-release-publish.yml` (Flow Release Publish) | From Flow Release Prepare, or by hand for an existing tag | `approve` job at the start, alongside the checks: environment `release` for a stable release (Samuel's one approval), `release-beta` for a beta (no reviewer). Then the `image` job pushes the image by digest, attests it and its SBOM, verifies the attestation, starts the pushed digest against PostgreSQL, then adds the channel's tags. Then it creates the GitHub Release with the manifest, and starts Flow NPM Release for the tarball it proved. |
| `flow-npm-release.yml` (Flow NPM Release) | From Flow Release Publish | Requires the tarball from that run to match the GitHub Release's manifest. Dispatched by Flow Release Publish, it publishes on that run's approval: it checks that GitHub Actions dispatched it, that the run is for this tag, and, for a stable release, that GitHub's approvals record shows `release` approved. Dispatched by hand, it waits for `npm-release` first. `publish` runs in environment `npm-publish`: npm trusted publishing with provenance, to the channel's dist-tag. Then it verifies what npm serves and attaches the post-publish evidence. |
| `flow-release-promote.yml` (Flow Release Promote) | By hand, from `main` | Points a channel at a published release, to roll it back or put it back. It verifies the release (the manifest's checksum, the npm integrity, signatures and provenance, and the image attestation), then in environment `npm-release` moves the channel. A stable tag moves npm `latest`, GHCR `stable` and `latest`, and GitHub's latest release, and moves `beta` up when the beta channel is behind. A beta tag moves npm and GHCR `beta`. |

| Action | Approvals |
| --- | --- |
| Beta (`vYYYY.M.D-beta.N`) | 0 |
| Stable release (`vYYYY.M.D`) | 1: `release` |
| Promote or roll back a channel | 1: `npm-release` |
| Flow NPM Release dispatched by hand | 1: `npm-release` |

A beta has guards instead of a gate: it runs only from `main`, only for a
`vYYYY.M.D-beta.N` tag on a `main` commit whose required checks passed
(Flow Release Prepare), and only after every CI lane passes again on that
commit (Flow Release Checks). Every environment accepts only runs from
`main`, and `npm-publish`, the environment npm's trusted publisher names, has
no reviewer of its own. Release tags (`v20*`) cannot be moved or deleted
(`.github/rulesets/release-tags.json`). Each job that builds or publishes
checks out the tag itself, never a commit handed on from an earlier job, and
stops if the tag no longer points at the commit the checks proved
(`test/release-workflows.test.js` holds this rule).

npm can take minutes to serve a new version. Flow NPM Release reads it back
with backoff for about 15 minutes, and a rerun skips a version npm already
serves with the manifest's integrity, so rerunning its failed jobs is safe.

Running Flow Release Publish again for the same tag is safe. It checks again,
updates the GitHub Release's assets, and starts Flow NPM Release, which skips
an npm version that is already published with the same bytes and refuses one
published with different bytes. A published version is never replaced: fix
forward with a new tag.

## Cut a release

1. Open a pull request that sets the upcoming stable version:
   `npm version 2026.10.18 --no-git-tag-version`, which updates
   `package.json` and `package-lock.json`. Title it
   `chore: release 2026.10.18`. Merge it when CI passes. Do this once per
   version; its betas reuse it. The version must be newer than the latest
   stable release, or Prepare refuses it.
2. Start a beta:

   ```bash
   gh workflow run flow-release-prepare.yml --repo arcforgelabs/flow --ref main -f channel=beta
   ```

3. Nothing waits for approval: when the checks pass, the beta is published to
   npm `beta`, GHCR `beta` and a GitHub pre-release.
4. Run the beta where it matters. To release that commit as stable, give it:

   ```bash
   gh workflow run flow-release-prepare.yml --repo arcforgelabs/flow --ref main -f channel=stable -f commit=<commit>
   ```

   Approve `release` in the Flow Release Publish run; you can do it while
   the checks run. That is the only approval. When the checks pass, it is npm
   `latest`, GHCR `stable` and `latest`, and GitHub's latest release.

To roll back, point the channel at the previous release (a stable tag for
`latest`, a beta tag for `beta`), and approve `npm-release`. Nothing is
unpublished:

```bash
gh workflow run flow-release-promote.yml --repo arcforgelabs/flow --ref main -f tag=v2026.10.18
```

Prepare has no dry run: the tag it creates is protected and cannot be
deleted, and it starts the publish at once. To test the release steps
without publishing, look at CI on any pull request: its `package` and
`docker-build` lanes run the same smokes as a release.

## Run a release

`docs/SELF_HOSTING.md` describes how to pin, verify and run a release with
Docker, with Node, or on Replit. `docs/REPLIT.md` describes a Replit
installation that follows a channel (`FLOW_DEPLOY_REF=stable`).

## One-time setup

Done on 18 Oct 2026, with `gh`. Each item can be undone in the repository
settings:

- Environments `release` and `npm-release`: required reviewer Samuel.
  `release-beta` and `npm-publish`: no reviewer. All four deploy from `main`
  only.
- The rulesets on `main` and on release tags (`CONTRIBUTING.md`, "Merging to
  main").

Still to do, by Samuel, before the first beta.

npm (an npm owner of the `@arcforgelabs` scope does this on npmjs.com, with
two-factor authentication; never with a token in a file or a command):

1. Trusted publishing cannot create a package. Publish a placeholder once:
   a directory with only a `package.json` that has `"name":
   "@arcforgelabs/flow"`, `"version": "0.0.0-placeholder"`, `"license":
   "MIT"` and this repository's URL
   (`git+https://github.com/arcforgelabs/flow.git`). Run `npm login`, then
   `npm publish --access public --tag placeholder`, then `npm logout`.
2. On the package's **Settings**, under **Trusted publishing**, add two
   GitHub Actions publishers for organization `arcforgelabs`, repository
   `flow`:
   - workflow `flow-npm-release.yml`, environment `npm-publish`, allowed to
     publish;
   - workflow `flow-release-promote.yml`, environment `npm-release`, with
     **Allow npm dist-tag** on and publishing off.

   npm checks the workflow file of the run's top-level workflow, so these
   names must match the files exactly. Renaming a file breaks publishing
   until its trusted publisher is changed here.
3. Under **Publishing access**, choose **Require two-factor authentication
   and disallow tokens**.

GHCR: the first publish creates the `flow` container package as private,
linked to this repository. Before that, check that the organisation has no
`flow` container package already
(`https://github.com/orgs/arcforgelabs/packages?repo_name=flow`). If one
exists that this repository did not create, empty or remove it first: it
becomes public in the next step. After the first beta, on the package's
page, open **Package settings**, then **Change visibility**, and choose
**Public**. Under **Manage Actions access**, make sure `arcforgelabs/flow`
has the **Write** role. Until the package is public, Replit and Docker
installations cannot pull the image anonymously; npm and the Replit channel
deploy do not need it.
