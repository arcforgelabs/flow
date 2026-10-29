# Own price list

Related: [#370](https://github.com/arcforgelabs/flow/issues/370), row `r32`.

[The clip](clip.webm) opens CR-ZR, cancels, then changes its price before tax
from $160.00 to $175.00. Save changes the list. A second open shows $175.00.
[Desktop](desktop.jpg) is 1280 × 800. [Phone](phone.jpg) is 390 × 844;
the phone puts each code and tax below its name and price.

All records come from the phone suite's synthetic seed. Xero and Seazona
stay disabled. Flow source: `9e5d330377d3e8576786f7547a6fac90e7f1e77d`.
This proves Flow's own price edit. It does not prove external price links,
comparison, or a live integration. No Xero screenshot is supplied.

Run from the repository root, with a **disposable local database**.
The harness recreates its schema. Use no live database or credentials.

```sh
FLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55470/flow_evidence \
  node scripts/demo/walkthrough.mjs \
  docs/evidence/report-2026-10/r32/shots.json /tmp/flow-r32-new-take
FLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55470/flow_evidence \
  node docs/evidence/report-2026-10/r32/stills.mjs
EVIDENCE_SOURCE_COMMIT=9e5d330377d3e8576786f7547a6fac90e7f1e77d \
  node docs/evidence/report-2026-10/r35/verify.mjs r32 r34
```

[Shot list](shots.json), [step times](timing.json), [saved-value checks](persistence.json),
and [media checks](validation.json) record the proof. The stills command captures
both rows after fresh page loads on desktop and phone. All four saves return 200.
Each desktop take records the screen with a visible cursor. All 20 step frames
and four stills were inspected. The clips have no narration.
