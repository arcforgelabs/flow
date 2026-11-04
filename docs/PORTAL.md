# Practice portal

A practice signs in at `/portal` and sees its own jobs. The lab approves
who gets in. Roles stay in Flow. Clerk only checks identity and sends the
invitation email.

This is step 1 (issue #359) plus the health-data controls marked step 1 in
issue #363. Requests, messages, alerts and file uploads come later.

## Who

A practice is one customer contact. A person can belong to more than one
practice; `?practice=` picks among their own rows and no others.

| Role | Jobs | Team |
| --- | --- | --- |
| Owner | All | All members |
| Admin | All | Not owners |
| Dentist | All, and Mine | No |
| Staff | All | No |

The first approved member of a practice is its owner. An admin cannot
change an owner. The practice keeps one owner. Removing someone keeps the
row.

## Join and invite

`POST /portal/api/join` stores a request. It needs no session, and it is
rate-limited per address and per email. A lab owner or admin approves it
on Settings > Portal, or from the contact, and links a customer with Pick.
Flow then sends the Clerk invitation. The link opens `/portal/sign-in`.

Owners and admins invite the rest of the team from Team.

A lab person cannot open `/portal/api`. A practice member cannot open a
staff route.

## Jobs

Jobs come from the obligation ledger, limited to the member's contact.
The portal shows Case, Item, Dentist, Status and Due. Status is the portal
name of the work-system status (Ordered, Received, In work, Quality check,
Sent), set on Settings > Portal. A status with no portal name is hidden;
the job shows the last named stage before it. A due date before today uses
the accent colour.

## Health data

Every portal read of a job, and every member change, writes an
`audit_events` row: who, practice, action, record, time and IP. The row
cannot be updated or deleted. Lab owners and admins see the latest rows
on the contact's Portal section.

A portal session ends after 12 hours with no request. Staff sign a member
out from that same section; a token issued before that moment is refused.

Join, the sign-in page and the portal API are rate-limited. Portal API
answers send `Cache-Control: no-store`, a Content Security Policy, and
HSTS when the request is HTTPS. What the host must do (region, encryption,
backups, who can reach the database) is in `docs/SELF_HOSTING.md`,
"Health data". Clerk multi-factor is available to members and required for
lab owners and admins in the installation's own Clerk application, as that
section says.

## Turn it off

Settings > Portal. Off: portal routes answer `403 portal_off`.
