# Flow — Vision

Flow is job management, invoicing, bill approval and a financial dashboard
for a lab that makes work to order, first for dental labs. It is a complete
application with its own database. It is not a sync engine between other
products.

It is for the lab manager, the staff who move the work, and the person who
bills it and pays the suppliers. Finished feels like this: Flow opens on a
job board that shows every job by stage, with due dates and late jobs marked;
completed jobs become invoices they check and send; supplier bills are
reviewed and approved; and one dashboard shows cash, what is owed to the lab,
what the lab owes, and the GST for the BAS period. Every invoice a customer
was sent can be found again, exactly as it was sent.

Flow is open source so any lab can run its own installation.

## The core and its integrations

The core is jobs and the job board, invoices, bills, payments, credit notes,
contacts, the price list, approvals and the dashboard. The core holds its own copy of
every record it shows, so it works with no integration connected and an owner
can build reports and features on its data.

Everything outside the core is an integration behind one contract (the
integration port):

- **Seazona** is the lab's case system. Its adapter is bundled: it ships in
  the package and is on in the dental preset, and an owner can turn it off.
  It turns completed cases into draft invoices through the Seazona API.
- **Xero** is optional. Its adapter sends issued invoices and approved bills
  to the owner's own Xero organisation and reads payments back.

Adding an integration never changes the core. Every integration uses the same
data spine (`docs/DATA_SPINE.md`): its records come into a mirror, get a Flow
identity, and become core records; Flow's writes leave through an outbox; a
conflict goes to one review queue; one job queue runs the work.

## Job management

Flow links each job to its client and its invoice. That link is the heart
of the product: a job card shows what was ordered, who it is for, and how it
was billed and paid.

Flow does a few parts of job management well now, and more later. It does
not try to replace the lab's case system.

- **Now:** update job cards and process a job's information for invoicing,
  and update jobs from paper forms.
- **Later:** full job management.

The job board is Flow's main view: a standard board of jobs by stage (a
column per stage, a card per job), with a list view of the same jobs. It
shows every job from the case system and from Flow, with its practice, due
date and department. Lab staff and the manager work from it.

Two parts follow the board (#48):

- **An intake reader.** A photo, a form or a note becomes a proposed job
  action: update a job, create one, or add a note. A handwriting reader and a
  low-cost decision model propose it; a person confirms it. Nothing changes
  until a person accepts. The model steps are optional and cost money per
  page, so the manager sees the month's cost.
- **A practice portal.** Practice staff sign in to follow their own jobs,
  on desktop first, with a simpler view on phones. The server limits each
  person to their practice.

Job management is a bundled module, built the same way as the integrations,
and a lab can remove it. Where the case system cannot take a change through
its API, the change becomes a short checklist for a person (#49).

## Standing decisions

### Why does Flow keep its own records?

Flow is the store of record for the invoices it issues. Xero gets a copy and
owns bank reconciliation. A lab without Xero still has complete, correct
records.

Flow also keeps a read-only copy of the accounting history from before it
was installed (#54), so its reports and its dashboard cover years, not only
the days since install.

### Why does Flow hold its data instead of passing it through?

An app that only passes records from one system to another cannot answer
questions about them, cannot show history, and breaks when one side is down.
Flow stores what each integration reports, links it to its own records, and
acts from its own database. Sync is how the data arrives and leaves. It is
not the product.

### Who wins when two systems disagree?

The case system, Flow and the accounting system each own their own records,
and the data moves both ways. Flow records which system each change came
from. When two systems disagree, Flow never overwrites one silently: it opens
an alert in the review queue. The alert shows each system's value and writes
nothing. A person fixes the record where they choose, then presses
**Resolved, re-check**: Flow checks that one difference again, and the alert
closes only when the systems agree.

### Why are approvals in Flow?

The person who bills checks work before it leaves Flow. Writes to the
accounting system are drafts, and a person approves them. An approval is a
record in Flow with who, when and what they saw.

### Why is a sent invoice never changed?

What a customer was sent is a commercial commitment. A change makes a new
version; the sent one stays as it was, attributed to whoever sent it.

### Why does Flow keep as little patient data as it can?

Dental cases carry health information, which Australian privacy law treats as
sensitive. Flow keeps the case number and the practice. It keeps a patient
reference only when a practice needs one printed on its invoice, and it keeps
no clinical notes or images. A form photo the intake reader reads is not kept
after its job is updated.

### Why does Flow keep its records in PostgreSQL only?

One database is less to run, back up and upgrade. Every record lives in
PostgreSQL, with `jsonb` for evidence and documents. Files (PDFs, payment
proof, exports) go through one object storage port, and PostgreSQL keeps only
each file's key, owner, size, type and hash. A need that seems to call for
another kind of database is raised as a decision first. The goal is an
installation that needs little maintenance (`docs/DATA_MODEL.md`, "Storage").

### Why does each lab get its own installation?

Labs' customers, prices and credentials must never meet. Each installation has
its own data, configuration and secrets.

## Out of scope

- Replacing the case system, for now. The case system owns the case record.
  Flow's job board shows and updates the work, and does not do clinical
  case management or production scheduling.
- Patient records, clinical notes, scans and images.
- Acting as the general ledger. Accounting software owns the ledger and the
  bank feed.
- Browser automation of another product. Integrations use published APIs.

This is a guardrail, not a law of physics. Strong evidence can change it;
record the change in the pull request that edits this file.
