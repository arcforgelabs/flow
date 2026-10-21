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

- A normal pull request never edits `CHANGELOG.md` or `CHANGELOG/`. Put the
  release-note text in the pull request: its title and its User Impact
  section.
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
- A stable release has 5 to 8 highlights; a beta has 0 to 8. A small change
  ships as a **beta**, never as a stable release with fewer highlights. A
  stable release needs 5 real user stories. Old stable releases with fewer
  than 5 highlights stay as history.
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
