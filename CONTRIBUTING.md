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

## Merging to main

The ruleset in `.github/rulesets/main.json` requires a pull request and the
checks `test` (CI) and `gitleaks` (Secret Scan), and blocks force pushes and
deletion of `main`. Apply it once the repository exists:

```bash
gh api -X POST repos/arcforgelabs/flow/rulesets --input .github/rulesets/main.json
```
