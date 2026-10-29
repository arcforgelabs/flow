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

## Spoken narration

`narration/voice.json` records the provider, model, voice, pace and delivery
instructions. Dotius gives a relaxed, friendly look at a feature we have made:
connected thoughts, natural contractions and room to look at the result. Keep
the words factual. Avoid sales language, formal click instructions and clipped
one-word cues. The current Fable voice is a provisional English male take;
Dotius's original saved preset has not been recovered. Each clip has a concise
script in `narration/<seed>.json`; cues
refer to the recorded step numbers and can span several steps. Keep those
settings consistent across editions. This uses OpenAI's speech endpoint only,
not ChatGPT live voice or Realtime. The API key needs text-to-speech Request
permission and must be injected as `VOICE_EXPLAINER_TOKEN` by the environment.

Give each feature a short reason to care, a clear story through the working
path, and an honest action or result to end on. Do not introduce Dotius or use
a fixed sign-off, benefit slogan or motivational catchphrase. Keep the words
short, factual and clear. Define an unfamiliar term only when it helps. Mention
a limitation only when it helps the viewer. Name
upcoming work only when it is verified; never invent a roadmap promise. Closing
words must match what the clip proves: creating a Xero client, for example,
makes this invoice ready but does not send it.

```sh
node scripts/demo/narrate.mjs \
  docs/evidence/report-2026-10/xero-paid/timing.json \
  scripts/demo/narration/xero-paid.json \
  /private/narrated/xero-paid
```

The command generates a WAV for each cue, checks that it fits its recorded
step range, and uses ffmpeg to combine audio with the existing MP4 and WebM
video streams. It never cuts off or speeds up speech. If a cue is too long,
shorten its script or record a longer hold. Outputs include MP4, WebM, WAV and
a `.narration.json` manifest with the exact voice profile, cue times and audio
hashes. Existing outputs are refused. Temporary audio is discarded on failure.
No key value enters the output or logs. Narration is disclosed as AI-generated
in the manifest; the report publisher must show that disclosure to viewers.

Live speech generation was verified on 29 October 2026 with the managed
`VOICE_EXPLAINER_TOKEN` binding and the initial Marin profile. The three synthetic
scenarios produced narrated MP4, WebM, WAV and timing manifests. The short
payment and reconciliation cues were shortened to fit the original shot times.
In a managed runtime with an inherited HTTP proxy, prefix the command with
`NODE_USE_ENV_PROXY=1` so Node uses that supported request path. Keep the
injected credentials, proxy and certificate trust settings unchanged.

Reference: https://developers.openai.com/api/docs/guides/text-to-speech
