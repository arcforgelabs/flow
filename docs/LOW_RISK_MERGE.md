# Low-risk merge lane

A pull request that is a small fix, with no merge risk, merges itself when
its checks are green. All other pull requests wait for a maintainer. A
release always waits for a maintainer (`docs/RELEASING.md`).

Workflow: `.github/workflows/low-risk-merge.yml`. Rules:
`scripts/github/low-risk-merge.mjs`. Tests: `test/low-risk-merge.test.js`.

## The words are ClawSweeper's and Barnacle's

The lane makes no new labels. It uses the labels that OpenClaw's bots use:

| Label | From | Meaning here |
| --- | --- | --- |
| `merge-risk: 🚨 <kind>` | ClawSweeper (`src/clawsweeper-policy.ts`) | The pull request touches a risky surface. It waits for a maintainer. |
| `status: 🚀 automerge armed` | ClawSweeper | The pull request is in the lane. |
| `size: XS` to `size: XL` | Barnacle's labeler | Lines changed, without `docs/` and lockfiles. |

When ClawSweeper reviews a pull request and adds a `merge-risk:` label, or a
person adds one, the lane holds the pull request. The lane never removes a
`merge-risk:` label. To let a held pull request into the lane, a maintainer
removes the label after reading the change.

## In the lane

All of these must be true:

1. A maintainer (owner, member or collaborator) opened it, from a branch of
   this repository (not a fork), against `main`. A Docs Agent pull request
   (`docs/AI_BOTS.md`) counts too: a bot opened it from `docs-agent/refresh`
   and it changes only `docs/**` and `README.md`.
2. The title type is `fix`, `improve`, `docs` or `test`. `feat` is a new
   feature; `refactor` and `chore` are not fixes.
3. The size is `XS`, `S` or `M` (under 500 lines).
4. No file carries a merge risk (below), and no `merge-risk:` label is on it.
5. It is not a draft.
6. Every check on its head commit is done and none failed, and `test` and
   `gitleaks` passed.

Then the workflow merges it (squash) at that exact head commit. If the head
moves, GitHub refuses the merge and the lane decides again on the next event.

## Flow's surfaces and their merge risk

Test files (`test/`, `*.test.js`) never carry a risk.

| Merge risk | Flow surface |
| --- | --- |
| `compatibility` | Schema and migrations (`server/db/`, any `migrations/`, `schema.js`, `tables.js`), imports, dependencies, packaging, deploy, Replit |
| `message-delivery` | How Flow writes to Xero and Seazona: `server/integrations/xero/`, `server/integrations/seazona/`, the adapter port, sending, outbox, queue, pipeline, ledger, links |
| `availability` | Call guards, health, rate limits, the server start |
| `auth-provider` | `server/auth/`, the Xero connection (OAuth, connections, webhooks) |
| `security-boundary` | Secrets, `SECURITY.md`, Gitleaks settings |
| `automation` | `.github/`, `.agents/`, `.claude/`, release and GitHub scripts, the changelog, `AGENTS.md`, `CLAUDE.md` (Barnacle's `triage: risky-infra` surface) |
| `other` | `VISION.md`, `LICENSE` |

A change to the lane itself is `automation`, so it always waits for a
maintainer.

## What a pull request shows

The workflow keeps one comment on the pull request up to date. It says
whether the pull request is armed or held, and why. It edits the comment in
place, so nobody gets a new notification.

## Events

The lane decides again when a pull request opens, gets a push, changes its
title, leaves draft, or gets or loses a label, and when CI or Secret Scan
finishes on it. `workflow_dispatch` with a pull request number decides again
by hand.

## Trust

The workflow runs on `pull_request_target` and `workflow_run`. It checks out
only `scripts/github/` from the default branch and reads the pull request
through the API. It never checks out or runs pull request code.

## Settings

- Repository variable `FLOW_LOW_RISK_MERGE=off` stops the merge. The labels
  and the comment stay.
- The ruleset (`.github/rulesets/main.json`) needs no change: the lane merges
  through a pull request with the required checks green, as a person does.
- Optional: with the Barnacle App installed on this repository
  (`BARNACLE_APP_ID`, `BARNACLE_APP_PRIVATE_KEY`), the App makes the merge,
  so CI and Secret Scan run on the merge commit on `main`. With the
  workflow's own token, GitHub starts no workflow for that push.
