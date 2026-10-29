# Narration refinement: issue #428

The recorder now respects longer shot holds. The three scripts and Cedar
profile are ready for a later speech trial. **No new speech was generated.**
The existing managed token is absent. No new key, permission or provider was used.

Related: [#428](https://github.com/arcforgelabs/flow/issues/428).
Base: preserved recorder commit `a21b14acc9123f4e12b391df362b8b9f7c3f8909`.
This slice targets that recorder branch. It does not replace report
[pull request #423](https://github.com/arcforgelabs/flow/pull/423).

## Before and after

| Item | Preserved take | This slice |
| --- | --- | --- |
| Shot holds | Requests above 1.5 seconds silently became 1.5 seconds | Explicit holds from 1 to 10 seconds; invalid values fail before recording |
| Voice | Provisional Fable | Unheard Cedar candidate; exact Dotius preset still unknown |
| Scripts | Short cues fitted to old timings | Connected sentences with factual screen details and clear results |
| Payments | 15.96 seconds | 19.79 seconds |
| Reconciliation | 20.89 seconds | 24.00 seconds |
| Create client | 21.32 seconds | 24.50 seconds; ready to send, not sent |

The new durations are **screen-only** results. They do not prove a speech fit
or natural delivery. [screen-results.json](screen-results.json) records each
cue window and word count for the later trial. Do not fill spare time with
empty words. Adjust holds after listening to the complete take.

The existing seeds, selectors, cue ranges and narration duration guard remain
the owners. No screen for #413, #417 or #418 was fabricated. The report source
and shared evidence index were not changed.

The [model research](../../../scripts/demo/narration/README.md) records official
sources and access limits. The exact profile is
[voice.json](../../../scripts/demo/narration/voice.json). The current model's
shutdown on 6 January 2027 needs a separately approved endpoint migration.

## Screen and regression proof

Commands ran on Linux with Node 24.5.0, installed Playwright Chromium,
PostgreSQL 16 in an isolated local container, Xvfb and FFmpeg.
Only fictional records and replay adapters were used. The recorder viewport
was **1280 × 800**.

```sh
npm ci --ignore-scripts --no-audit --no-fund
FLOW_TEST_DATABASE_URL='<disposable-local-database>' \
  node --test test/walkthrough.test.js

# Repeat for reconcile-gap and xero-missing-client.
FLOW_TEST_DATABASE_URL='<disposable-local-database>' \
  node scripts/demo/walkthrough.mjs \
  scripts/demo/shots/xero-paid.json /tmp/flow-narration-428/takes/xero-paid
```

The regression sets a 4.5-second hold on the paid result. It fails on the
preserved recorder at the intended assertion, then passes after the repair.
See [before](hold-before.txt) and [after](hold-after.txt).

Each new take completed its real page actions and result checks. Timings and
final screen frames are saved here:

| Example | Timing | Result screen |
| --- | --- | --- |
| Payments | [Timing](xero-paid-timing.json) | [Paid status and Xero link](xero-paid-result.png) |
| Reconciliation | [Timing](reconcile-gap-timing.json) | [Linked job](reconcile-gap-result.png) |
| Create client | [Timing](xero-missing-client-timing.json) | [Ready invoice](xero-missing-client-result.png) |

Generated silent videos remain temporary screen proof. They are not new
accepted narration and do not replace the preserved reference files.

## Delivery investigation

The probe uses the actual unchanged report renderer and template from #423,
commit `f8e8431548b9f5730e495434bba6d2680e61e9bd`. A synthetic report selects
the three preserved narrated MP4 files. A local Express server serves the
rendered page and copied attachments. No report deployment is involved.

See [the manual probe](report-delivery.mjs) and
[the combined results](report-delivery.json).
The probe plays each video to its end with decoded audio, clicks the browser's
native **Download** menu item, and compares the saved file with its source.
This tests the report surface, beyond local file decoding.

```sh
node docs/evidence/narration-428/report-delivery.mjs \
  /tmp/flow-report-delivery-source /tmp/flow-report-delivery-results "$PWD"
```

Use fresh temporary paths outside the repository. The probe reads the pinned
report commit from local Git objects. If it is absent, fetch
`claude/project-thread-a1xeb7` first. Install Playwright Chromium for the
renderer. The media probe uses `/usr/bin/google-chrome`; set
`FLOW_BROWSER_EXECUTABLE` for another Chrome path with the required codecs.
The probe copies synthetic evidence into its temporary report source.

Chrome `156.0.8078.73` on Linux passed all three files at **1280 × 800** and
**390 × 800** with phone emulation. The saved file hashes matched their sources.
Phone emulation is not a physical phone test. The media are the preserved
Fable reference takes, not the new Cedar candidate. View the native download
menu at [desktop width](report-download-desktop.png) and
[phone width](report-download-phone.png).

Cached Chromium `141.0.7390.37` rejects the same MP4 files. Its audio codec
support check returns empty. Changing AAC audio from 96 kHz to 48 kHz does
not fix that client; Chrome plays both. See [codec-comparison.json](codec-comparison.json).
No codec change is claimed as a repair for the user's failure.

The checked-in report index still selects the original silent WebM clips.
The #423 owner must select accepted narrated assets and update the index.
This slice leaves that decision and its files with that owner.

The user's failed attachment client, physical device, download action,
response headers and media error remain **NOT_ENOUGH_INFO**. The local report
result does not close that failure. Hosted access, native chat attachments,
email delivery and Safari were not tested.

## Checks and remaining work

The full-suite result and source commit are recorded in the pull request.
The initial run found one preserved documentation defect: the handoff README
was absent from `docs/docs.json`. This slice indexes both narration review
pages so the documentation check can pass.

No release, deployment, report dispatch, email, merge, credential change or
paid-provider call ran. Samuel still needs to hear and accept the candidate.
The later speech run must prove fit, rhythm and alignment for all three
examples, then play and save them in the actual target client.
