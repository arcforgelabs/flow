# Practice portal

A practice signs in and sees its own jobs. The lab approves who may join
and what each work-system status is called. This is step 1: sign-in, jobs
and the practice team (`docs/DATA_MODEL.md`).

Requests, messages, alerts, invoices and file uploads are later steps. The
menu keeps their places hidden. Nothing here writes to Xero or Seazona.

## Who

| Role | Jobs | Team |
| --- | --- | --- |
| Owner | Every job at the practice, and Mine | Invites and removes anyone except the last owner |
| Admin | Every job, and Mine | Invites and removes anyone except an owner |
| Dentist | Every job, and Mine (their own name) | |
| Staff | Every job | |

Mine keeps the jobs whose dentist matches the member's practitioner name.
The first person the lab approves at a practice is its owner. Anyone
approved after that joins as staff. The team can change the role.

A lab owner or admin turns the portal on in Portal, names each status, and
approves or declines a request. View on a contact is read only.

## Join

Someone without an invite opens Join, enters their name, email, practice
and phone, and waits. The lab links the request to the customer contact
with Pick, or declines it. Approving invites them through Clerk. The link
opens `/portal/sign-in`.

An owner or admin invites the rest of the team the same way. An admin
cannot change an owner. The last active owner stays. Removing someone
keeps the row.

## Jobs

Jobs come from the obligation ledger, decorated with the work system's
case, item, dentist, due date and status when the source key matches.
The page shows Case, Item, Dentist, Status and Due. Search, Filter and
Mine narrow that list. A job shows the five portal names as a track.
A status with no portal name is skipped, and the job keeps the last
named stage before it. A due date before today is late until the stage
is Sent.

The page has no patient name, notes or images.

## Scope

`requirePracticeMember` (`server/auth/portal.js`) reads the Clerk session
and the active `practice_members` rows. `?practice=` may only pick among
those rows. Portal routes read through `portalScope`
(`server/portal/scope.js`), which always names that organisation and
contact. A staff session with no member row is refused. A portal session
with no `people` row is refused on a lab route.

Code: `server/portal/`, `server/auth/portal.js`, `server/ui/portal.js`,
`server/ui/portal-settings.js`.
