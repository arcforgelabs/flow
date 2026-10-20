---
name: flow-changelog-update
description: Write a Flow release's changelog file (CHANGELOG/<version>.md) from the pull requests merged since the previous release. Use when cutting a beta or stable release, or when asked to write or fix release notes.
---

# Flow changelog update

This follows openclaw/openclaw's `openclaw-changelog-update` skill, scaled to
Flow. `CONTRIBUTING.md` holds the rules; `scripts/release/changelog.mjs`
holds the tool and the check.

## When

At the release cut, in a `docs(changelog): <version> notes` pull request,
merged before the beta that will become stable (`docs/RELEASING.md`, Cut a
release). That pull request has no row in the record. Never in a feature
pull request. Flow Release Prepare refuses the stable release while the
record misses a pull request, and Flow Release Publish uses the file as the
GitHub Release notes. Write it once per version: a beta gets its own
file (`CHANGELOG/<version>-beta.<n>.md`), and the stable release gets a new,
cumulative file.

## Steps

1. Get the full history. A shallow clone gives a short range, and the tool
   refuses it:

   ```bash
   git fetch --unshallow --tags origin   # or: git fetch --tags origin
   ```

2. Draft the section. Before the tag exists, the target is `HEAD`:

   ```bash
   node scripts/release/changelog.mjs draft --version <version> --output /tmp/section.md
   ```

   The draft has every `feat`, `improve` and `fix` pull request under
   Changes or Fixes, the first five of them as Highlights, and a complete
   record of every pull request in the range. Direct commits have no row.

3. Edit the prose, not the record:
   - Highlights: one user story per bullet, in one sentence, with every pull
     request that tells it linked. A stable release with changes has 1 to 8;
     a beta has 0 to 8. Leave out internal work.
   - Changes and Fixes: plain words a lab manager reads. Group pull requests
     that tell one story into one bullet. Drop release-process words such as
     "release 2026.10.31" from a title.
   - Put the user-visible fixes first: data safety, then sending and sync,
     then screens.
   - No customer, lab, practice or person names. The repository is public.

4. Save it, and check it against history:

   ```bash
   node scripts/release/changelog.mjs write --version <version> --file /tmp/section.md
   node scripts/release/changelog.mjs verify --version <version>
   npm run changelog:check
   ```

5. Commit `CHANGELOG/<version>.md` and `CHANGELOG.md` together.

`node scripts/release/changelog.mjs notes --version <version>` prints the
GitHub Release body for that version: the whole section, or the prose and a
link to the record when GitHub's 125,000-character limit would refuse it.
