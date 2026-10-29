# Email invitations: simulated delivery

Related: [#370](https://github.com/arcforgelabs/flow/issues/370), row `r37`.

[The clip](clip.webm) opens People and Invite, enters `demo-invite@example.test`
with the Staff role, and presses **Send invite**. Fake Clerk returns success.
Flow shows its success message and an **Invited** row. The row menu offers
**Email invite again**. The clip opens this menu but does not send again.
[Desktop](desktop.jpg) is 1280 × 800. [Phone](phone.jpg) is 390 × 844;
the phone stacks each person's details.

This proves the invitation form, the response and the saved People row.
No email leaves the harness. It does not prove email delivery, a real provider,
an inbox result or a new person's first sign-in. All records are synthetic.
Xero and Seazona stay disabled. No live credentials or paid services are used.

Use the [shared capture command](../r30/README.md) to make both rows.
The [capture source](../r30/capture.mjs) uses Playwright video capture on the real
Flow application with fake Clerk. [Stored checks](../r30/persistence.json)
record status 201, Staff and Invited. A fresh phone load keeps the invitation.
[Step times](timing.json) and [media checks](../r30/validation.json) record the media.
Flow source: `9af250d7959cfdb96c5e7e636bcfa5e2a35b70c8`.
The clips have a visible pointer and no narration.
