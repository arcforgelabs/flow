# Contributing

Read `VISION.md` first; `README.md` indexes the rest of the documentation.
Work is tracked in GitHub issues and pull requests.

## Working in this repo

- A change to product behaviour updates the doc that describes it in the same
  pull request.
- Preserve the issued-invoice rules: a sent invoice is never changed in place.
  A change to how an invoice version is selected, sent or synced needs a
  regression test.
- Keep integrations behind the integration port. Core code never imports an
  adapter.
- Run `npm test` before you hand off a change.
- Never commit customer data, patient data, credentials or runtime state.
  `SECURITY.md` holds those rules.

### Porting from the earlier codebase

Flow is a new history. Code comes across from an earlier private codebase
one module per pull request. Each such pull request:

- names no customer, lab, practice or person, in code, docs, tests or the
  pull request itself;
- carries no file with real lab, practice, dentist or patient data (photos,
  CSV exports, screenshots, proof notes);
- moves every hostname, tenant id and account into configuration;
- passes gitleaks.

## Pull requests

Title: `type: user-facing description`, where type is one of `feat`, `fix`,
`improve`, `refactor`, `docs` or `chore`. Use
`.github/pull_request_template.md` and fill in every heading.

## Changelog

`CHANGELOG.md` is an index of one file per release in `CHANGELOG/`, with
each release's contribution record again in `CHANGELOG/records/`. The
layout, formats and rules are openclaw/openclaw's split changelog. The
release owns these files:

- A normal pull request never edits `CHANGELOG.md`, `CHANGELOG/` or a
  release page in `docs/releases/`. Put the release-note text in the pull
  request: its title and its User Impact section.
- The release cut writes `CHANGELOG/<version>.md` from the pull requests
  in the release's range, edits the prose, and commits it on the release
  branch `release/<version>` with the version (`docs/RELEASING.md`). It
  never goes through a pull request to `main`: Flow Release Closeout brings
  the shipped file to `main` after the stable release. The procedure is
  `.agents/skills/flow-changelog-update/SKILL.md`.
- Flow Release Prepare refuses a release until its file lists every pull
  request in its range with GitHub's credit, and the GitHub Release takes
  its notes from the file (`docs/RELEASING.md`).
- A stable release covers everything since the previous stable release,
  including the blocker fixes picked onto its branch. A correction
  (`<version>-<n>`) covers the same range plus its fix. A beta covers everything since the release npm's `beta` tag selects before
  the beta publishes, in its own file.
- A release file has Highlights, Changes and Fixes, then a complete
  contribution record that lists every pull request in the range once:
  `- **PR #N** Related #I. Thanks @a and @b.` A prose bullet names its pull
  requests as `(#N, #M)` and keeps every thanks from their rows. `feat`,
  `improve` and `fix` pull requests go in the prose; `docs`, `chore`,
  `refactor`, `test`, `ci`, `build` and `style` go only in the record,
  unless the title marks a breaking change with `!`.
- A stable release aims for 5 to 8 highlights and has at most 8; a beta has
  0 to 8. The 5 is a guideline, not a release gate: a small stable patch
  release ships with the user stories it has (as OpenClaw's patch releases
  do), and never with invented ones.
- Thanks go to the pull request's author, its co-authors and the people who
  reported the issues it closes (`Closes #N`, `Fixes #N`, `Resolves #N`).
  Never to bots, to Claude or Codex, to the organization or to the
  maintainer.
- `npm test` runs `scripts/release/changelog.mjs check`, which holds the
  format rules; `verify` holds the rules that need git and GitHub.
  `CHANGELOG/Unreleased.md` stays empty.

## Merging to main

The ruleset in `.github/rulesets/main.json` requires a pull request and the
checks `test` (CI) and `gitleaks` (Secret Scan), and blocks force pushes and
deletion of `main`. The ruleset in `.github/rulesets/release-tags.json` stops
anyone from deleting, moving or force-pushing a release tag (`v20*`). The
ruleset in `.github/rulesets/release-branches.json` stops anyone from
deleting or force-pushing a release branch (`release/20*`, except the
`-main-closeout` branches).

A small fix with no merge risk merges itself when its checks are green; all
other pull requests wait for a maintainer (`docs/LOW_RISK_MERGE.md`).

The main and tag rulesets are live (applied 18 Oct 2026); the maintainer
applies the release-branch ruleset (`docs/RELEASING.md`, One-time setup). To
apply them again, for example on a fork:

```bash
gh api -X POST repos/arcforgelabs/flow/rulesets --input .github/rulesets/main.json
gh api -X POST repos/arcforgelabs/flow/rulesets --input .github/rulesets/release-tags.json
gh api -X POST repos/arcforgelabs/flow/rulesets --input .github/rulesets/release-branches.json
```

Claude Code sessions merge a pull request through the REST endpoint that
`.claude/settings.json` allows, because cloud sessions block `gh pr` (it uses
GraphQL):

```bash
gh api -X PUT repos/arcforgelabs/flow/pulls/<number>/merge -f merge_method=squash
```

<!-- arc-forge-org-consistency:start -->
## Issue, PR, and contact routing

This follows upstream OpenClaw's routing. Start here before you create a GitHub item:

| Situation | Use | Required evidence |
| --- | --- | --- |
| Bug, regression, crash or wrong behaviour | Bug report form | Repro steps, expected and actual behaviour, version, OS, model and provider route when relevant, logs or screenshots, impact |
| Wrong, missing or contradictory docs | Docs bug report form | Docs path or URL, verification steps, expected and actual content, impact, evidence |
| New capability or improvement | Feature request form | Problem, proposed solution, alternatives, impact, examples, whether you will open the PR |
| Security issue | This repo's `SECURITY.md`; without one, the [Arc Forge security policy](https://github.com/arcforgelabs/business/blob/master/SECURITY.md) | Never paste a credential, in full or in part |
| Defect in OpenClaw itself | The upstream repo's own forms and `CONTRIBUTING.md` | What upstream asks for, in its language (American English for OpenClaw) |
| PR for an existing or new issue | `.github/pull_request_template.md` | Visible `Closes #<issue>` or `Related: #<issue>`, then the four sections below |

The forms in `.github/ISSUE_TEMPLATE/` are copies of upstream OpenClaw's. Answer every field from observed evidence. Where the evidence does not answer a field, write exactly `NOT_ENOUGH_INFO`. File one issue per report, and reuse an open issue rather than file a duplicate. Without the web form (for example `gh issue create`), use each field label as a `###` heading in the body.

For agent-authored or non-trivial work, create or reuse the issue first, then open the PR against it. Do not tag people to route work; the forms and labels do that.

## Pull request body

Use `.github/pull_request_template.md` and keep the body current:

- **What Problem This Solves** — the concrete problem and when it happens.
- **User Impact** — what someone can now do, or a plain statement that there is no user-visible change.
- **Why This Change Was Made** — the shipped solution and any boundary that matters.
- **Evidence** — the command, commit, result, and what was not run. Screenshots show the real product. Placeholder text does not count.

Edit the pull request body when someone asks for more proof. A review comment can point at that edit. The body stays the record. Maintainer authorship does not remove this requirement.
<!-- arc-forge-org-consistency:end -->
