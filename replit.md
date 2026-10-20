# replit.md

Replit Agent reads this file. Read `VISION.md` before starting work.
`README.md` indexes all other documentation; check it first.

## If this workspace runs an installation

An installation runs published Flow releases. It does not develop Flow.

| Task | Read |
| --- | --- |
| Set up a new installation on Replit | `docs/SELF_HOSTING.md` (start-up settings, "Sign-in (Clerk)"), then `docs/REPLIT.md` ("Configuration", "Publishing") |
| Update to a new release | `docs/REPLIT.md`, "Publishing" (steps), "The workspace database" and "The workspace updater" |
| `git pull` fails | `docs/REPLIT.md`, "The workspace updater" (take the deploy files from the newest stable tag) |
| Turn on and connect Seazona or Xero | `docs/SEAZONA.md`, "Turn it on"; `docs/XERO.md`, "Connect Xero" |
| Pin a release or roll back | `docs/REPLIT.md`, "Pinning a release and rolling back" |
| Check what is live | `GET /health`: `build.release`, `build.checks` |

Rules for an installation:

- Do not change Flow's code here. A code change goes to the repository as a
  pull request and reaches the installation as a release.
- Never push or sync to GitHub. The workspace is fetch-only
  (`docs/REPLIT.md`, "A production installation: fetch only").
- Put secrets and start-up settings in Replit Secrets, and in Publishing >
  Adjust settings > Secrets. Put business settings in Flow's own screens.
  Never put them in a file in git (`docs/REPLIT.md`, "Where an
  installation's settings go").
- When Replit shows "Development database changes detected", always press
  Cancel. Never pick an option there. Flow migrates production itself when
  it starts.
- The workspace's database follows production by itself
  (`docs/REPLIT.md`, "The workspace database"). To do it by hand:
  `bash scripts/replit-deploy.sh update-workspace` (the Run button). Never
  run `flow-server migrate` here: it applies this checkout's migrations,
  which can be ahead of production.
- Do not run SQL by hand on the production database.

## If this workspace develops Flow

Work on a branch and open a pull request (`CONTRIBUTING.md`). GitHub steps:
`.agents/skills/github-sync/SKILL.md`.
