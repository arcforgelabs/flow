# Custom fields on jobs

Related: [#370](https://github.com/arcforgelabs/flow/issues/370), row `r34`.

[The clip](clip.webm) opens case 48200, sets Rush, chooses shade B1, and sets
Scan received. It closes and opens the job again. All three values remain.
[Desktop](desktop.jpg) is 1280 × 800. [Phone](phone.jpg) is 390 × 844;
the phone shows the custom fields in one column.

All records come from the phone suite's synthetic seed. Xero and Seazona
stay disabled. Flow source: `9e5d330377d3e8576786f7547a6fac90e7f1e77d`.
This proves saved custom values in Flow. It does not prove field creation,
a board move, conflict handling, or a Seazona hand-off. The work-system stage
control is visible but unused. No live integration or Xero screenshot is used.

Run from the repository root, with a **disposable local database**.
The harness recreates its schema. Use no live database or credentials.

```sh
FLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55470/flow_evidence \
  node scripts/demo/walkthrough.mjs \
  docs/evidence/report-2026-10/r34/shots.json /tmp/flow-r34-new-take
```

[Shot list](shots.json) and [step times](timing.json) record ten passed steps.
[The shared stills command](../r32/stills.mjs) also checks each value after fresh
page loads on desktop and phone. [Saved values](../r32/persistence.json) and
[media checks](../r32/validation.json) hold the results.

The first stills run tried to press the side panel's Close control on a phone.
That control is hidden at this width. The corrected capture scrolls to the
custom fields and passes. Both submitted clips passed on their first take.
