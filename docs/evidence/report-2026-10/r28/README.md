# Job board stages

Related: [#370](https://github.com/arcforgelabs/flow/issues/370), row `r28`.

This take shows Flow on the phone-suite synthetic seed. All names and records
are made up. Xero and Seazona are disabled. The source is
`a21b14acc9123f4e12b391df362b8b9f7c3f8909`.

- [Clip](clip.webm): open a job, inspect its client, stage and price code,
  then switch between List and Board.
- [Desktop](desktop.jpg): 1280 × 800. The board has six stages and 42 jobs.
  Four stages fit on the screen; the others are across the board.
- [Phone](phone.jpg): 390 × 844. Stage tabs sit above one lane.
- [Shot list](shots.json) and [step times](timing.json).

Run the existing recorder against a **disposable local database**. Its setup
recreates the database schema. Use no live database or credentials.

```sh
FLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55470/flow_evidence \
  node scripts/demo/walkthrough.mjs \
  docs/evidence/report-2026-10/r28/shots.json /tmp/flow-r28-new-take
```

The recorder makes WebM, MP4, step times and one frame per step. Copy the WebM
and step times into this folder after review. Do not publish a failed take.
[The stills command](../r35/stills.mjs) captures all three selected rows.
[Validation](../r35/validation.json) records sizes, hashes, decoding and playback.

The job uses the synthetic work-system adapter. This proves Flow's board and
its mapped line display. It does not prove a live Seazona read or client match.
No Xero Demo Company connection or Xero screenshot was used.
