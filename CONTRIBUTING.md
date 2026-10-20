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

`CHANGELOG.md` is an index of one file per release in `CHANGELOG/`, the
split layout that openclaw/openclaw uses. The release owns these files:

- A normal pull request never edits `CHANGELOG.md` or `CHANGELOG/`. Put the
  release-note text in the pull request: its title and its User Impact
  section.
- The release cut writes `CHANGELOG/<version>.md` from the pull requests
  merged since the previous release, then edits the prose. The procedure is
  `.agents/skills/flow-changelog-update/SKILL.md`.
- A stable release covers everything since the previous stable release. A
  beta covers everything since the previous release of either channel, in
  its own file.
- A release file has Highlights, Changes and Fixes, then a complete record
  that lists every pull request in the range once. `feat`, `improve` and
  `fix` pull requests go in the prose; `docs`, `chore`, `refactor`, `test`,
  `ci`, `build` and `style` go only in the record, unless the title marks a
  breaking change with `!`.
- `npm test` runs `scripts/release/changelog.mjs check`, which holds these
  rules. `CHANGELOG/Unreleased.md` stays empty.

## Merging to main

The ruleset in `.github/rulesets/main.json` requires a pull request and the
checks `test` (CI) and `gitleaks` (Secret Scan), and blocks force pushes and
deletion of `main`. The ruleset in `.github/rulesets/release-tags.json` stops
anyone from deleting, moving or force-pushing a release tag (`v20*`).

Both rulesets are live (applied 18 Oct 2026). To apply them again, for
example on a fork:

```bash
gh api -X POST repos/arcforgelabs/flow/rulesets --input .github/rulesets/main.json
gh api -X POST repos/arcforgelabs/flow/rulesets --input .github/rulesets/release-tags.json
```

Claude Code sessions merge a pull request through the REST endpoint that
`.claude/settings.json` allows, because cloud sessions block `gh pr` (it uses
GraphQL):

```bash
gh api -X PUT repos/arcforgelabs/flow/pulls/<number>/merge -f merge_method=squash
```
