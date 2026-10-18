# Flow on Replit

Flow can run as a published Replit app. This is the runbook for an
installation on Replit whose workspace is imported from this repository, for
people and agents alike. It is the same model as
[Field on Replit](https://github.com/arcforgelabs/field/blob/main/docs/REPLIT.md).

There is a second way: a private deploy repository that pins one npm release
(`deploy/replit/`, `docs/SELF_HOSTING.md`, "Replit"). Use this runbook for a
workspace of this repository.

## What runs here

- The workspace's Run button starts the workspace files with
  `scripts/replit-start.sh`. The published app is built and started by
  `scripts/replit-deploy.sh` from a release or commit fetched from GitHub
  ("Publishing").
- Runtime: Node 24 (`.replit` module `nodejs-24`), as in CI and the
  `Dockerfile`.
- Flow keeps its records in PostgreSQL (`DATABASE_URL`) and runs its
  migrations when it starts (`docs/DATA_MODEL.md`). A published Replit app
  keeps no files between publishes, so nothing else holds state.
- Checks: `npm test`.

## Configuration

Add a Replit PostgreSQL database; it sets `DATABASE_URL`. Sign-in settings
(`FLOW_AUTH`, the Clerk keys, `FLOW_FIRST_OWNER_EMAIL`,
`FLOW_OWNER_GOOGLE_DOMAINS`, `FLOW_PUBLIC_ORIGIN`) are in
`docs/SELF_HOSTING.md`, "Sign-in (Clerk)". Keep every secret in Replit
Secrets, and never in a file in the repository.

The published app's settings (Publishing > Adjust settings) are separate from
the workspace's. Set them there too.

`scripts/replit-start.sh` serves on `PORT` (19300 in `.replit`) and sets
`FLOW_RUNTIME=replit`.

## Publishing

Publish as a Reserved VM (Flow will run its integration outbox and scheduled
invoice email in-process, so it must stay up).

A publish deploys GitHub, not the workspace's files. Replit publishes a
snapshot of the workspace, so the deployment's build command
(`scripts/replit-deploy.sh build`, `.replit` `[deployment]`) fetches the
deploy ref from the public repository into `.flow-deploy/`, builds it there
(`scripts/replit-build.sh`: `npm ci --omit=dev`) and records its commit. The
run command (`scripts/replit-deploy.sh start`) starts Flow from
`.flow-deploy/`. With no `FLOW_DEPLOY_REF`, the ref is the tip of `main`.

- The fetch needs no token. If it fails, the build fails and the publish
  stops; it never deploys the workspace copy instead.
- Only a commit that passed GitHub CI is built. After the fetch, the build
  asks GitHub's API, without a token, for the commit's check runs
  (`scripts/deploy-checks.js`). `test` (CI) and `gitleaks` (Secret Scan) must
  each have completed with success, as reported by GitHub Actions. Otherwise
  the build fails and the publish stops. A pinned `FLOW_DEPLOY_REF` is
  checked the same way.
- It only writes `.flow-deploy/` (gitignored). It never resets or deletes
  the workspace's own files.
- The build log names what it deployed and its CI result:
  `[deploy] fetched main at <commit>`, `[deploy] checks: passed (test,
  gitleaks) at <commit>`, then
  `[deploy] built github main at <commit> into .flow-deploy/ (checks: passed)`.
  The start log repeats it.

The check refuses the build, and names the reason in the log, when:

| Build log | What it means | What to do |
| --- | --- | --- |
| `checks: NOT passed`, then `<check>: still in progress` (or `queued`) | CI is still running on the commit | Wait for the commit's checks on GitHub, then publish again |
| `checks: NOT passed`, then `<check>: failure` (or another result) | The commit failed CI | Fix it on `main`, or pin a commit that passed |
| `<check>: no run on this commit` | The check never ran on that commit | Pin a commit on `main` |
| `checks: could not be read: GitHub's API rate limit ... is used up. It resets at <time>` | Without a token, GitHub allows 60 API requests an hour from one address, and Replit's build machines may share one | Publish again after that time |
| `checks: could not be read: GitHub did not answer` (or `HTTP 5xx`) | The network or GitHub failed, after three tries | Publish again; check [githubstatus.com](https://www.githubstatus.com) |

It never treats an unreadable answer as a pass.

To publish:

1. Publishing > Republish. Nothing needs pulling first.
   - **If the publish stops at "Development database changes detected", press
     Cancel.** Never pick an option there. The workspace and the published
     app have separate databases, and Replit offers to make production's
     tables match the workspace's; when the workspace is behind, every option
     drops or renames production tables. Flow migrates production itself when
     it starts.
2. When Replit says it is done, open `GET /health`. Its `build` shows what is
   live: `revision` (the commit), `ref` (`main`, the pinned ref, or the
   channel `stable` or `beta`), `release` (the release tag, when the build is
   one), `source` (`github`, or `workspace` for an emergency build) and
   `checks` (`passed`, or `unchecked` when an emergency override built it).
   Check that `revision` and `release` are what you meant to deploy, and that
   `checks` is `passed`.

`.replit`, `scripts/replit-deploy.sh`, `scripts/deploy-checks.js`,
`scripts/deploy-release.js` and `server/release-channel.js` are the only files
a publish takes from the workspace. When a commit changes them, the build log
says `note: ... differs from <ref>`; pull `main` into the workspace before
the next publish so the new ones take effect.

### Following stable releases

Production should run published releases (`docs/RELEASING.md`), not every
merge to `main`. Set the deployment secret `FLOW_DEPLOY_REF` to `stable`
(Publishing > Adjust settings > Secrets), then publish. Each publish then
deploys the release the stable channel points at:

1. The build asks GitHub, without a token, for its latest release
   (`scripts/deploy-release.js`, `server/release-channel.js`). That is the
   newest stable release, or an earlier one if Flow Release Promote rolled
   `latest` back. If GitHub cannot answer, it asks npm for
   `@arcforgelabs/flow`'s `latest` dist-tag instead.
2. It downloads that release's `release-manifest.json` and checks it against
   its `.sha256`.
3. It fetches the release's tag and requires the commit to be the one the
   manifest names.
4. The CI check above applies as before.

If any step fails, the build fails and nothing is deployed; it never falls
back to `main`. The build log names the release:
`[deploy] release: stable is v2026.10.18 at <commit> (from github;
release-manifest.json sha256 <hash> verified)`, then
`[deploy] built github stable (v2026.10.18) at <commit>`. `GET /health` shows
it as `build.ref` `stable` and `build.release` `v2026.10.18`.

`FLOW_DEPLOY_REF=beta` follows the beta channel the same way: the newest
release of all, betas and stable releases alike, so it is never behind
stable.

A publish deploys whatever the channel points at when it runs; a new release
does not publish itself. When one is out, the server log says
`[flow] update available: …`, and an owner can read the same from
`GET /api/updates` (`docs/SELF_HOSTING.md`, "Update notice"). To upgrade,
read the release's notes, then publish again.

### Pinning a release and rolling back

Set the deployment secret `FLOW_DEPLOY_REF` to a release tag such as
`v2026.10.18`, a branch or a full 40-character commit hash, then publish. A
release tag is reported as `build.release` too. To roll back, set it to the
older tag or commit and publish; to follow the channel again, set it back to
`stable`. Use a secret, not a deployment Configuration value: a Configuration
value is written into `.replit`.

Flow's database migrations only move forward. An older release runs against
the newer schema, which works while the migrations are additive; check the
migrations in the newer release's manifest before you roll back.

Replit's documentation does not say whether deployment secrets reach the
build command. The start log checks it: `WARNING: FLOW_DEPLOY_REF is '<ref>'
now, but this build fetched 'main'` means the build did not see the secret.
Then put the ref in the build command itself, in `.replit`:
`build = ["env", "FLOW_DEPLOY_REF=<ref>", "bash", "scripts/replit-deploy.sh", "build"]`.

A fork sets `FLOW_DEPLOY_REPO` to its own repository's `https://` URL; the
fetch is anonymous, so the repository must be public.

### Emergency: build a commit whose CI has not passed

`FLOW_DEPLOY_ALLOW_UNCHECKED=1` (deployment secret, or in the build command
as above) builds the fetched commit even when its CI did not pass or GitHub
could not say. The build still asks, and logs the answer, then
`WARNING: FLOW_DEPLOY_ALLOW_UNCHECKED=1: building <ref> at <commit> although
CI did not pass or could not be read`. `/health` then shows
`checks: "unchecked"`. Use it only when production must change and CI cannot
pass in time, for example during a GitHub Actions outage, and remove it at
the next publish.

### Emergency: publish the workspace files

`FLOW_DEPLOY_FROM_WORKSPACE=1`, together with `FLOW_DEPLOY_ALLOW_UNCHECKED=1`
(no CI ran on these files), builds the workspace's files as they are,
uncommitted edits included, with no fetch. Without
`FLOW_DEPLOY_ALLOW_UNCHECKED=1` the build refuses. Files `.gitignore`
excludes (`node_modules/`, config, `.env`) are left out. `/health` then shows
`source: "workspace"` and `checks: "unchecked"`. Use it only when GitHub
cannot be reached or a fix cannot wait for a merge, and remove both at the
next publish.

## GitHub

The workspace tracks `main` on
[arcforgelabs/flow](https://github.com/arcforgelabs/flow) (or your fork).
Nothing commits to `main` directly; the ruleset on `main` refuses a direct
push (`CONTRIBUTING.md`, "Merging to main"). Work on a branch, open a pull
request, merge it on GitHub, then pull. Publishing does not need the pull.

- `scripts/github-sync.sh status`: remote, ahead/behind, and whether
  `GITHUB_TOKEN` works.
- `scripts/github-sync.sh pull`: fast-forward `main` from GitHub. It needs no
  token for a public repository. It drops Replit's "Published your App"
  commits when together they change no files, and stops if a local commit
  changes files.
- `scripts/github-sync.sh open-pr "<title>" [body-file]`: push the current
  branch and open a pull request.
- `scripts/github-sync.sh handoff`: what to click in the Git pane when no
  token is set.

`GITHUB_TOKEN` (Replit Secret) is needed only to push or open pull requests
from the workspace: a fine-grained token scoped to this repository only, with
Contents and Pull requests read/write. An installation that only follows
releases needs none. Replit Agent reads `replit.md`, and its GitHub
instructions are in `.agents/skills/github-sync/SKILL.md`.
