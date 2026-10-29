# Reconcile finds the gaps

Related: [#370](https://github.com/arcforgelabs/flow/issues/370), row `r38`.

[The clip](clip.webm) opens a job with no invoice. Flow offers a matching draft.
Link this invoice removes the gap: the count drops from 66 to 65. The next gap
is an invoice with no job. The take then opens the linked draft on Ready.
Its Linked card names `SYNTHETIC-GAP`.

[Desktop](desktop.jpg) is 1280 × 800. [Phone](phone.jpg) is 390 × 844.
The desktop compares candidates in columns. The phone shows cards.
All records are synthetic. The source is
`a21b14acc9123f4e12b391df362b8b9f7c3f8909`.

[The shot list](shots.json) reuses the existing `reconcile-gap` seed.
Its known job is the first row: Bayview Clinic, 30 September, $458.70.
The row shows no case reference. The draft reference appears in the comparison
and on the invoice. [Step times](timing.json) record each passed screen check.

```sh
FLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55470/flow_evidence \
  node scripts/demo/walkthrough.mjs \
  docs/evidence/report-2026-10/r38/shots.json /tmp/flow-r38-new-take
```

Use a disposable local database. The harness recreates its schema.
[The stills command](../r35/stills.mjs) captures this comparison before the link.
[Validation](../r35/validation.json) records sizes, hashes, decoding and playback.

The first attempted take used the case reference as a row selector. That failed
because the list does not show it. The recorder discarded that take. This clip
uses the seeded row and passes all eight steps.

Make invoice and Skip are visible, but this take does not use them. It proves
the link path and both gap types. Xero and Seazona stay disabled. No Xero Demo
Company connection or Xero screenshot was used.
