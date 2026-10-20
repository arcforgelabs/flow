---
name: flow-changelog-update
description: Write a Flow release's changelog file (CHANGELOG/<version>.md and its record in CHANGELOG/records/) from the history since the previous release. Use when cutting a beta or stable release, or when asked to write or fix release notes.
---

# Flow changelog update

This is openclaw/openclaw's `openclaw-changelog-update` skill, with Flow's
names. `CONTRIBUTING.md` holds the rules; `scripts/release/changelog.mjs`
holds the tool, the format check (`check`) and the history check
(`verify`).

## When

At the release cut, before Flow Release Branch cuts `release/<version>`
(`docs/RELEASING.md`, Release a stable version). Commit the files on any
branch and pass it as `notes_ref`: the cut puts them on the release branch
in the release commit. They never go through a pull request to `main`;
Flow Release Closeout brings them there after the stable release. Never in
a feature pull request. Draft again at the branch's head after a blocker
pick, and put the refreshed files on the branch with Flow Release Branch
`notes` (or in the same `cherry-pick` run). Prepare refuses a release while
its file misses a pull request, misses GitHub's credit or breaks the
highlight budget. Publish uses the file as the GitHub Release body and
checks the published body. Each beta gets its own file
(`CHANGELOG/<version>-beta.<n>.md`), never a copy of the stable file; the
stable release gets a new, cumulative file, and a correction
(`CHANGELOG/<version>-<n>.md`) the same range plus its fix.

## Inputs

- Stable base: the newest stable release tag older than the version, on
  any branch. When it is not in the target's history (it shipped from its
  own release branch), the range starts at their merge base and leaves out
  the pull requests that release already shipped, picks included.
- Beta base: the version npm's `beta` tag selects before the beta
  publishes. `draft` reads it with `npm view @arcforgelabs/flow
  dist-tags.beta`. If npm already selects this beta or a newer one, pass the
  tag you captured before publishing with `--base`.
- Target: the commit the release will tag: the cut commit on `main` before
  the branch exists, then the branch's head (`origin/release/<version>`).
  The record's target may be an older commit of that history; any pull
  request merged after it makes `verify` fail until you draft again.

## Steps

1. Get the full history. A shallow clone gives a short range, and the tool
   refuses it:

   ```bash
   git fetch --unshallow --tags origin   # or: git fetch --tags origin
   ```

2. Draft the section and its manifest. `draft` reads each pull request's
   author, commits and closed issues from GitHub (`gh api`):

   ```bash
   node scripts/release/changelog.mjs draft --version <version> \
     --output /tmp/section.md --manifest /tmp/manifest.json
   ```

   The draft has every `feat`, `improve` and `fix` pull request under
   Changes or Fixes, the first eight of them as Highlights, and the complete
   contribution record: every pull request in the range once, as
   `- **PR #N** Related #I. Thanks @a and @b.` The manifest also lists the
   direct commits. They are editorial input; they get no row.

3. Read the manifest, then edit the prose, not the record:
   - Highlights: 5 to 8 bullets for a stable release, 0 to 8 for a beta.
     One user story per bullet, in one sentence, with every pull request
     that tells it: `- Text. (#N, #M) Thanks @a.` Leave out tests, CI,
     refactors and docs unless the outcome is a material install, update or
     data-safety change.
   - Changes: new capabilities and behaviour changes. Fixes: user-facing
     fixes first. Group pull requests that tell one story into one bullet.
   - A bullet that names a pull request keeps every thanks from its record
     row. Issues stay inline as `#N`.
   - Put the user-visible fixes first: data safety, then sending and sync,
     then screens. Drop release-process words such as "release 2026.10.31".
   - Never thank bots, Claude, Codex, the organization or the maintainer.
   - No customer, lab, practice or person names. The repository is public.

4. Save it, and check it against history and GitHub:

   ```bash
   node scripts/release/changelog.mjs write --version <version> --file /tmp/section.md
   node scripts/release/changelog.mjs verify --version <version>
   npm run changelog:check
   ```

5. Commit `CHANGELOG/<version>.md`, `CHANGELOG/records/<version>.md` and
   `CHANGELOG.md` together on your branch, push it, and give it to the cut
   or to Flow Release Branch `notes` as `notes_ref`.

6. After Publish, it runs the body check itself. To run it by hand:

   ```bash
   node scripts/release/changelog.mjs verify --version <version> --check-github
   ```

`node scripts/release/changelog.mjs notes --version <version>` prints the
GitHub Release body for that version: the whole section, or, past GitHub's
125,000-character limit, the prose and a link to the tag's record file.
`verify` keeps GitHub's answers in `.git/flow-changelog/`;
`--refresh-github-snapshot` asks again.

## Not copied yet

OpenClaw also publishes a docs-site mirror of each release and rewrites the
GitHub Release body with a full thanks roster after the docs deploy. Flow
has no docs site, so its files stay in their first format.
