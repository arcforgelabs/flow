# Invoice rules: save an age check

Related: [#370](https://github.com/arcforgelabs/flow/issues/370), row `r27`.

[The clip](clip.webm) opens the Old job rule, then cancels. It opens the rule
again, changes the age check from more than 90 days to more than 60 days,
and saves. A second open shows 60 days and **Wait for a person**.
[Desktop](desktop.jpg) is 1280 × 800. [Phone](phone.jpg) is 390 × 844;
the phone stacks the condition menus.

All records come from the phone suite's synthetic seed. Xero and Seazona
stay disabled. Flow source: `df87ccda9c4a8558406547abdc45dde3134de45e`.
This proves a saved rule edit. It does not show a job reach Ready or an
automation draft an invoice. No Xero screenshot is supplied.

Run from the repository root, with a **disposable local database**.
The harness recreates its schema. Use no live database or credentials.

```sh
FLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55470/flow_evidence \
  node scripts/demo/walkthrough.mjs \
  docs/evidence/report-2026-10/r27/shots.json /tmp/flow-r27-new-take
FLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55470/flow_evidence \
  node docs/evidence/report-2026-10/r27/stills.mjs
EVIDENCE_SOURCE_COMMIT=df87ccda9c4a8558406547abdc45dde3134de45e \
  node docs/evidence/report-2026-10/r35/verify.mjs r27 r39
```

[Shot list](shots.json), [step times](timing.json), [saved-value checks](persistence.json),
and [media checks](validation.json) record the proof. The save returns 200.
Fresh desktop and phone loads retain the rule. The stills command captures
both rows and checks all seven invoice tabs at both sizes.
All 18 step frames and four stills were inspected. Both clips record the
desktop with a visible cursor. They have no narration.
