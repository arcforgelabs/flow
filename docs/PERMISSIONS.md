# Permissions

An owner opens **Permissions** (in the account menu) and sets what Admin and
Staff may do. The same list gates the routes and the buttons.

A fresh installation has no rows. The defaults are today's access:

| | Owner | Admin | Staff |
| --- | --- | --- | --- |
| Send, Approve, Void, Draft, Price list, Rules, Fields, Run | yes | yes | no |
| Connect | yes | no | no |
| People | yes | no | no |

Send is sending invoices to the accounting system. Approve is issuing and
revising. Void is voiding. Draft is making a draft from a job, accepting its
new lines, marking no invoice, and linking a job. Price list, Rules and
Fields are the edits on those pages. Run is a sync, a mirror, a payment
read, a recheck, and a history import. Connect is connecting and
disconnecting Xero, and opening Integrations. People is the people list.

The owner column stays on. People cannot be granted or taken away: those
routes still require an owner, and a verified owner sign-in.

A person row beats the role. On the People page, ⋯ then Permissions sets
Inherit, Allow or Deny for that person. Inherit removes the row.

Connecting and disconnecting still need a verified sign-in (a second factor,
or Google Workspace on the owner domain with no password), the same check an
owner action uses. Opening Integrations needs Connect. Saving integration
settings stays with a verified owner.

Each change writes a `permission_events` row: who, the role or the person,
the key, and the old value and the new one.
