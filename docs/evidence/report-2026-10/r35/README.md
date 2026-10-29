# Group, sort and filter

Related: [#370](https://github.com/arcforgelabs/flow/issues/370), row `r35`.

[The clip](clip.webm) groups jobs by Client, sorts them by Due, then filters
Status to Shipped. Seven of 42 jobs remain. [Desktop](desktop.jpg) is
1280 × 800. [Phone](phone.jpg) is 390 × 844. All records are synthetic.
The source is `a21b14acc9123f4e12b391df362b8b9f7c3f8909`.

[The persistence result](persistence.json) comes from the real Flow pages.
A fresh page restores the first account's choices. The same account sees seven
jobs on the phone. A second account keeps Status, no sort, no filter and 42 jobs.
The persistence check is separate from the clip.

## Reproduce

Install the dependencies with `npm ci`. Use the existing
[recorder guide](../../../../scripts/demo/README.md). These commands need
PostgreSQL, Chromium, Xvfb and ffmpeg. They use no live integration or credential.
The database must be disposable: the harness recreates its schema.

```sh
FLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55470/flow_evidence \
  node scripts/demo/walkthrough.mjs \
  docs/evidence/report-2026-10/r35/shots.json /tmp/flow-r35-new-take

FLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55470/flow_evidence \
  node docs/evidence/report-2026-10/r35/stills.mjs

node docs/evidence/report-2026-10/r35/verify.mjs
```

The stills command captures desktop and phone images for `r28`, `r35` and `r38`.
It also checks account persistence and separation. It writes no live data.
The verification command checks the index paths, image dimensions, file sizes,
clip duration, full video decoding and end-to-end Chromium playback at fourfold
speed. [Validation](validation.json) records each file's hash and the results.

All 29 recorder step frames and all six screenshots were inspected locally.
The shots show the expected controls and results. Playback proves local media
support. It does not prove playback through the report's download control.
The clips have no narration. No paid speech service was used.

## Index repair and limits

The selected rows already had older media. Commit `ed04409` replaced the index
with three recorder rows. This change adds `r28`, `r35` and `r38` back, refreshes
their media and preserves those three recorder rows and their change mappings.
It does not claim that all 24 report rows are complete.

The review base is `codex/walkthrough-recorder`. When this work reaches `main`,
keep the other report rows from that branch's full index. Do not replace them
with this branch's six-row index.

No live Xero, Xero Demo Company or Seazona flow ran. No `xero.jpg` is supplied.
The selected flows need Flow only. Other Xero rows in #370 still need their
Demo Company result. No application, schema, workflow or changelog changed.
