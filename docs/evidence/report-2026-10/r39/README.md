# Invoice tabs: now seven

Related: [#370](https://github.com/arcforgelabs/flow/issues/370), row `r39`.

[The clip](clip.webm) starts on Ready, then opens Pending, Draft, Approved,
Sent, Non-chargeable and Void. It ends on Ready.
[Desktop](desktop.jpg) is 1280 × 800 and shows all seven tabs.
[Phone](phone.jpg) is 390 × 844 and shows Pending; its tab strip scrolls.

The report's six original tabs remain. The current product adds
Non-chargeable before Void. The capture keeps that seventh tab visible.
The index title states this change from the report's older title.

All records come from the phone suite's synthetic seed. Flow source:
`df87ccda9c4a8558406547abdc45dde3134de45e`. Xero and Seazona stay disabled.
The set has eight Pending invoices, 42 Ready invoices and 14 Approved
invoices. Draft, Sent, Non-chargeable and Void are empty.

This proves tab navigation, counts, list rows and empty results. It does not
prove transitions between tabs, Accept change, recheck or a Seazona order
link. No accounting system runs, and no Xero screenshot is supplied.

Run from the repository root, with a **disposable local database**.
The harness recreates its schema. Use no live database or credentials.

```sh
FLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55470/flow_evidence \
  node scripts/demo/walkthrough.mjs \
  docs/evidence/report-2026-10/r39/shots.json /tmp/flow-r39-new-take
FLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55470/flow_evidence \
  node docs/evidence/report-2026-10/r27/stills.mjs
EVIDENCE_SOURCE_COMMIT=df87ccda9c4a8558406547abdc45dde3134de45e \
  node docs/evidence/report-2026-10/r35/verify.mjs r27 r39
```

[Shot list](shots.json) and [step times](timing.json) describe this take.
[Tab checks](../r27/persistence.json) check each tab on desktop and phone;
neither page exceeds its viewport width. [Media checks](../r27/validation.json)
record dimensions, size, full decoding and browser playback for both rows.
All 18 step frames and four stills were inspected. Both clips have a visible
cursor and no narration.
