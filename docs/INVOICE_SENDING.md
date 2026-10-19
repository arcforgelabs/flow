# Ready, Problem and Send all ready

The Invoices page has five tabs: Drafts, Problem, Ready, Issued and Void.
Problem and Ready are views of the drafts. Code: `server/core/sending.js`.

## Ready or Problem

Every draft is ready or has a problem. Flow checks its own data first:

| Check | Problem text |
| --- | --- |
| The draft has lines | The invoice has no lines. |
| The total is above zero | The total is $0.00 or less. |
| Every line has a price item | Line N has no price item. |

When an accounting system is on and connected, its own checks are added
(`checkDrafts`). For Xero these come from Flow's copy of Xero, so they cost no
Xero calls: the customer matches one Xero contact, and every item is in Xero.

An issued invoice that the accounting system refused is also a problem. It
shows the refusal until a person sends it again.

## Send all ready

One press, on the Ready tab, by an owner or admin:

1. Flow stops before it issues anything when the accounting system is on but
   not connected, or does not take writes (`XERO_ALLOW_LIVE_WRITES`).
2. Each ready draft is issued and gets its number. One press takes up to 100
   drafts; the rest wait for the next press.
3. Each issued invoice is queued for the accounting system.
4. The send worker sends the queue in the background, every 30 seconds, on the
   job queue. For Xero, each invoice goes as a Xero draft by default; the
   customer's send mode can make it an approved invoice that Xero emails.
5. A sent invoice leaves the queue. A refused invoice moves to Problem.
   An invoice that waits for Xero's call limits stays queued.

With no accounting system on, the button issues the ready drafts only.

## Records

`invoices.send_state` is `queued`, `sent` or `failed` (null when the invoice
was never queued). `send_error` holds `{ code, message }` while failed.
Revising an issued invoice clears both.

## API

- `GET /api/invoicing/invoices?status=ready|problem` lists a view. Each
  invoice carries `view` (`ready`, `problem` or `sending`) and `problems`.
  `counts` includes `ready` and `problem`.
- `POST /api/invoicing/invoices/send-ready` `{ issueDate }`.
- `POST /api/invoicing/invoices/send-again` `{ invoiceIds? }`.
