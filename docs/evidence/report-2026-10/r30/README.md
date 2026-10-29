# Drafts go to Ready

Related: [#370](https://github.com/arcforgelabs/flow/issues/370), row `r30`.

[The clip](clip.webm) shows **Draft when ready** and **Ready when drafted** on.
The capture command then runs Flow's real automations once, outside the browser.
It opens Invoices and the new draft. The page shows **Ready invoice**, a client,
a price line and a total of $176.00. Nobody marks the invoice Ready.
[Desktop](desktop.jpg) is 1280 × 800. [Phone](phone.jpg) is 390 × 844.

The command creates one synthetic shipped job with no invoice. The automation
marks the job ready, drafts one invoice and marks one draft ready.
[Stored checks](persistence.json) record these counts, the automation actor,
the draft status, its ready time, no ready person and no issued version.
The desktop and a fresh phone load show the Ready invoice.
Flow source: `9af250d7959cfdb96c5e7e636bcfa5e2a35b70c8`.

Run from the repository root with a **disposable local database**.
The harness recreates its schema. Use no live database or credentials.
The take directory must not exist. The command captures `r30` and `r37`.

```sh
FLOW_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55470/flow_evidence \
  node docs/evidence/report-2026-10/r30/capture.mjs /tmp/flow-r30-r37-new-take
EVIDENCE_SOURCE_COMMIT=9af250d7959cfdb96c5e7e636bcfa5e2a35b70c8 \
  node docs/evidence/report-2026-10/r35/verify.mjs r30 r37
```

[Capture source](capture.mjs), [step times](timing.json), [stored checks](persistence.json)
and [media checks](validation.json) record the proof. All records are synthetic.
Xero and Seazona stay disabled. Browser requests outside Flow and fake Clerk
are blocked. The clips have no narration. No paid service is used.

This checks the automation code, not the scheduled worker. It shows no
work-system order link, accounting send or Xero result. The synthetic job
has no order in an external work system, so the Linked card has no order link.
No `xero.jpg` is supplied. No application, schema or workflow changed.

The review base is `cursor/report-highlights-r27-9e2e` (draft #437).
The index preserves all ten earlier rows and adds these two rows.
This does not complete all 24 rows in #370. Keep other main-branch index rows
when this stack reaches `main`.

All ten step frames and four stills were inspected. Both clips passed full
video decoding and end-to-end Chromium playback. The media checks record
dimensions, duration, file size and hashes. Report-download playback was not tested.
