# Dotius narration: review files and handoff

[Issue #428](https://github.com/arcforgelabs/flow/issues/428) owns the next work.
Development is on hold. These files preserve the criticised takes for review;
they are not approved final narration.

## The user's critique

- The workflow is good. Keep it and refine it.
- The voice and model choice are not good enough. Investigate frontier voice
  model modules and use the strongest suitable supported capability.
- The pacing feels off. Make the whole take sound natural, rather than making
  each sentence fit a fixed time slot.
- Dotius should sound like the familiar OpenAI English male voice: relaxed,
  friendly and interested in the feature. Do not perform another identity or
  introduce Dotius each time. The original voice preset is still unknown.
- Keep the words short, clear and factual. Define an unfamiliar term only when
  that helps. The user's reference to Alex Hormozi described directness and
  clarity; it is not a request to impersonate him.
- Give a feature a direct reason to care, show the working path, then end on
  the actual result. Keep that structure flexible. No marketing fluff, fixed
  sign-off, benefit slogan or motivational catchphrase. The user explicitly
  rejected “one less thing to chase”.
- Mention only useful limitations and verified upcoming work. For example,
  creating a client makes this invoice ready; it does not send the invoice.
- The download button failed, and the user could not play any delivered video.
  That problem remains open. A local playback check did not prove delivery.

## What is saved

| File | Purpose |
| --- | --- |
| [xero-paid.mp4](xero-paid.mp4) | Payments reference take, about 16 seconds |
| [reconcile-gap.mp4](reconcile-gap.mp4) | Reconciliation reference take, about 21 seconds |
| [xero-missing-client.mp4](xero-missing-client.mp4) | Create-client reference take, about 21 seconds |
| [flow-narration-review.zip](flow-narration-review.zip) | All three MP4, WebM and WAV files; captions; scripts; cue manifests; original timings; recorder source; voice settings; local verification |
| [manifest.json](manifest.json) | Source commits, byte sizes, hashes and known limits |
| [voice.json](voice.json) | Exact provisional voice and delivery settings |

Only fictional scripts and synthetic demonstration records are included. The
archive contains no credential values, customer editions or raw runtime logs.

The implementation is on `codex/walkthrough-recorder` at
`cb0fd7f27c755d4b058ed1502b3673a473db07db`. The preservation commit is linked
from issue #428. Recorder source and the scripts remain in `scripts/demo/`.
The reference uses `gpt-4o-mini-tts-2025-12-15`, voice `fable`, speed `1`.
Fable is provisional; it is not a verified match to Dotius's live voice.

## Existing workflow

Read `scripts/demo/README.md` before running anything. Use a disposable local
database and the synthetic sign-in harness. Never connect a real integration.

```sh
npm ci
PLAYWRIGHT_BROWSERS_PATH=/workspace/.browsers npx playwright install chromium

# Record a new take against a disposable database.
FLOW_TEST_DATABASE_URL=postgres://flow@127.0.0.1:55432/flow_test \
  node scripts/demo/walkthrough.mjs scripts/demo/shots/xero-paid.json /tmp/flow-review/take

# Narrate an existing synthetic take. Use a new output path.
NODE_USE_ENV_PROXY=1 node scripts/demo/narrate.mjs \
  docs/evidence/report-2026-10/xero-paid/timing.json \
  scripts/demo/narration/xero-paid.json /tmp/flow-review/narrated
```

Recording also needs PostgreSQL, Xvfb and FFmpeg. Read the runtime setup rather
than assuming the example port or browser path exists. The managed speech
binding is text-to-speech-only. Use the supported inherited proxy and certificate
trust. Do not print, copy, change or broaden credentials.

The report workflow is already saved separately in
[pull request #423](https://github.com/arcforgelabs/flow/pull/423), at
`f8e8431548b9f5730e495434bba6d2680e61e9bd`:

- [Customer Report workflow](https://github.com/arcforgelabs/flow/blob/f8e8431548b9f5730e495434bba6d2680e61e9bd/.github/workflows/customer-report.yml)
- [Collector, renderer, config and template](https://github.com/arcforgelabs/flow/tree/f8e8431548b9f5730e495434bba6d2680e61e9bd/scripts/report)
- [Report runbook](https://github.com/arcforgelabs/flow/blob/f8e8431548b9f5730e495434bba6d2680e61e9bd/docs/CUSTOMER_REPORT.md)

That report task owns its handover. No active workflow was changed or dispatched
to preserve these files.

## Proof and limits

The three reference takes passed FFmpeg decoding and end-to-end Chromium
playback in both formats, with decoded audio. Local speech recognition recovered
the scripts. The cue manifests show that no speech was clipped or sped up.
These checks do not judge natural delivery or prove the user's download button.
The test result and exact preservation commit are recorded in issue #428.

The coordinator redelivered native attachments at 09:07 UTC on 29 October 2026.
Phone playback remains unconfirmed. The failing client, device and underlying
delivery error are `NOT_ENOUGH_INFO`. Do not close the delivery problem without
testing the actual delivery surface.

## Pickup and decisions

1. Read the repository instructions and issue #428. Check for a claim before
   starting. Continue the existing branch and coordinate with #423.
2. Download the review archive from GitHub. Inspect the saved voice profile,
   cue times, scripts and recorder. Reproduce the current three takes first.
3. Check current official frontier voice documentation. Separate model research
   from live calls. Confirm what the supported endpoint and credential permit.
4. Review whole-clip rhythm and screen alignment. Fixed cue windows and separate
   speech requests are candidates to examine, not established root causes.
5. Let Samuel hear a short candidate and test play/download in the actual client
   before producing another full edition.

Samuel's decisions still needed: confirm the familiar Dotius voice preset or
accept an approximation; approve the next voice/pacing sample; and approve any
new endpoint access or permissions if the chosen model needs them. Do not
change secrets or permissions to avoid that decision.

No agent was triggered or assigned. No pull request was opened. Deployment,
merge, email, live workflow dispatch and the previously held publication actions
remain outside this handoff. Preserve the separate interface gaps in #413, #417
and #418; do not fabricate missing screens.

Superseded takes remain local in `/workspace/narrated-flow/`,
`/workspace/narrated-flow-relaxed/` and `/workspace/narrated-flow-dotius/`.
The latest take is in `/workspace/narrated-flow-final/`; its usable files are
preserved in this GitHub package. Local paths are not required for pickup.

Source conversation: [coordinator chat](https://chatgpt.com/c/01a1751a-899a-74f0-b038-ce51a940e030)
(access controlled).
