# Flow — Vision

Flow is invoicing, bill entry and a financial dashboard for a lab that makes
work to order, first for dental labs.

It is for the person who bills the work and pays the suppliers. Finished feels
like this: completed cases become invoices they check and send, supplier bills
go in once and get approved, and one dashboard shows cash, what is owed to the
lab, what the lab owes, and the GST for the BAS period. Every invoice a
customer was sent can be found again, exactly as it was sent.

Flow is open source so any lab can run its own installation.

## The core and its integrations

The core is invoices, bills, payments, contacts, the price list and the
dashboard. It works with no integration connected.

Everything outside the core is an integration behind one contract (the
integration port):

- **Seazona** is the lab's case system. Its adapter is bundled: it ships in
  the package and is on in the dental preset, and an owner can turn it off.
  It turns completed cases into draft invoices through the Seazona API.
- **Xero** is optional. Its adapter sends issued invoices and approved bills
  to the owner's own Xero organisation and reads payments back.

Adding an integration never changes the core.

## Standing decisions

### Why does Flow keep its own records?

Flow is the store of record for the invoices and bills it issues. Xero gets a
copy and owns bank reconciliation. A lab without Xero still has complete,
correct records.

### Why is a sent invoice never changed?

What a customer was sent is a commercial commitment. A change makes a new
version; the sent one stays as it was, attributed to whoever sent it.

### Why does Flow keep as little patient data as it can?

Dental cases carry health information, which Australian privacy law treats as
sensitive. Flow keeps the case number and the practice. It keeps a patient
reference only when a practice needs one printed on its invoice, and it keeps
no clinical notes or images.

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

- Case management, production tracking and scheduling. The case system owns
  the case.
- Patient records, clinical notes, scans and images.
- Acting as the general ledger. Accounting software owns the ledger and the
  bank feed.
- Browser automation of another product. Integrations use published APIs.

This is a guardrail, not a law of physics. Strong evidence can change it;
record the change in the pull request that edits this file.
