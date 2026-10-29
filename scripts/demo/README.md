# Synthetic walkthrough recorder

Related: #412 and #388. This recorder changes no application, schema or workflow.
It uses `test/mobile/server.js`, fake Clerk sign-in and synthetic records only.
The shipped Xero and Seazona adapters remain disabled. Never use live credentials
or a live database. `FLOW_TEST_DATABASE_URL` is a disposable database: the harness
recreates its schema.

Requirements: Node 24, `npm ci`, Playwright Chromium (`npx playwright install
chromium`), PostgreSQL, Xvfb and ffmpeg on PATH. No customer account is needed.

```sh
FLOW_TEST_DATABASE_URL=postgres://localhost/flow_video \
  node scripts/demo/walkthrough.mjs scripts/demo/sample-shots.json /private/takes/contacts
```

The runner starts its own Xvfb display and one headed Chromium window. The shot
list chooses a seed module in `scripts/demo/seeds/` and one initial local path.
Subsequent navigation uses clicks. Browser requests outside the local harness
and fake Clerk are blocked. Each seed must use synthetic stand-ins only.

Supported actions: `hover`, `click`, `type` (`text`), `press` (`key`), `scroll`
(`dy`), `wait` (`ms`). `target` is a strict Playwright selector. `expect` and
`expectHidden` assert the result. Cursor movement takes 20 timed points, with a
400ms target pause; typing uses 50ms keystrokes and results hold 1–1.5 seconds.
The take must last 15–45 seconds. A standard white arrow with a black outline
is drawn on the page; its tip marks the click position.

A successful take writes `<out>.mp4`, `<out>.webm`, `<out>.json` (step timings)
and `<out>-frames/NN.png` (screen frames at the end of each step). Existing output
is refused. A failed step discards the temporary take and exits 1. Inspect every
step frame and play the video before using it in an edition.

`basic` uses the harness's Example Lab and contacts. The integration scenarios
in #413–#418 still need their own synthetic seeds and shot lists. Keep generated
account editions outside the public repository. The generic sample is not proof
of any Xero or Seazona integration scenario.

## Integration scenarios

Shot lists are in `scripts/demo/shots/`. Seeds select replay mode before Flow
starts; they never use a live adapter. `xero-refusal` also starts the real send
worker against its replay adapter and stops it when the take finishes.

Validated clips and step frames are in `docs/evidence/report-2026-10/`:

- `xero-paid`: real synthetic payment sync, Sent list and Linked card (#414).
- `reconcile-gap`: job, best invoice match, link and invoice's Linked card (#415).
- `xero-missing-client`: pending client problem, Create confirmation, Ready result (#416).

The existing evidence index is updated for these three clips, preserving other
pull-request mappings. Reconcile that index with PR #423 when integrating.

Remaining UI limitations (no app changes in recorder scope): #413 asks for Xero
icons on the Contacts list, which this version does not render; the locally
recorded alternative shows the matched contact's Xero panel. #417 asks for a
sweep-status control that this version's Seazona page does not expose. The seed
validates the first-read horizon with a recent invoice copied and an older one
excluded, then a sweep with zero misses. #418 stores the refusal code/message
correctly but Pending shows a short label and hover message; the issued record
omits the send failure. Its local take is partial and is not a report highlight.

Local workflow checks can validate the schedule/release/dispatch configuration
and run collect/render with synthetic API replies. They do not prove the hosted
GitHub scheduler or artifact upload. No workflow dispatch is performed here.
