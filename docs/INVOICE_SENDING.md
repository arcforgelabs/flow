# Drafts, Problem, Ready and Send all ready

The Invoices page has five tabs: Drafts, Problem, Ready, Issued and Void.
Drafts, Problem and Ready are views of the draft invoices; every draft is in
one of them. Code: `server/core/sending.js`.

| View | A draft is here when |
| --- | --- |
| Drafts | No check failed, and no person has marked it ready yet. |
| Problem | A check failed. |
| Ready | A person marked it ready, and no check fails. |

## Ready

A draft the draft routine made from a job ready to invoice goes to Ready on
its own while no person has changed it (server/core/automations.js), and so
does a draft whose job change a person adopted. Any other draft waits in
Drafts. On the invoice the buttons are, left to right, **Preview**, **Save as
draft** and **Finalise**. With an accounting system on, **Finalise** saves the
draft, checks it and moves it to the Ready tab; nothing is sent until **Send
all ready**. In the list, a person ticks drafts and presses **Move N to
Ready**. A draft with a problem stays where it is and shows in Problem. While
the draft's job changed after it was made (below), Finalise is off: fix the
job at its source, or adopt the change. A saved change keeps a draft ready;
Flow's checks still run on it. **Move to Drafts**, on the invoice's Status
card or for ticked rows in the list, takes it back. `invoices.ready_at` and
`ready_by` record who marked it and when.

## Checks

Flow checks its own data first:

| Check | Problem text |
| --- | --- |
| The draft has lines | The invoice has no lines. |
| The total is above zero | The total is $0.00 or less. |
| Every line has a price item | Line N has no price item. |
| The job is not in review | The job needs a look before this invoice goes: (the review reason). |

When an accounting system is on and connected, its own checks are added
(`checkDrafts`). For Xero these come from Flow's copy of Xero, so they cost no
Xero calls: the customer matches one Xero contact, and every item is in Xero.

An issued invoice that the accounting system refused is also a problem. It
shows the refusal until a person sends it again.

## Send all ready

One press, on the Ready tab, by an owner or admin:

1. Flow stops before it issues anything when the accounting system is on but
   not connected, or does not take writes (`XERO_ALLOW_LIVE_WRITES`).
2. Read before act (issue #141): the job behind each ready draft whose work
   system report is over two hours old is read again from the work system,
   one call per job, at most 20 a press. A job that changed after its
   draft, or that the work system deleted or no longer bills, goes to
   review and its draft to Problem. A draft whose job could not be read
   waits for the next press (`waiting` in the answer).
   Then the accounting system reads its latest changes (issue #45, see
   [XERO.md](XERO.md#read-before-draft-and-send)). When that read cannot
   run, nothing is issued and every draft in the press waits.
3. Each ready draft (marked by a person) is issued and gets its number. One press takes up to 100
   drafts; the rest wait for the next press.
4. Each issued invoice is queued for the accounting system.
5. The send worker sends the queue in the background, every 30 seconds, on the
   job queue. For Xero, each invoice goes as a Xero draft by default; the
   customer's send mode can make it an approved invoice that Xero emails.
6. A sent invoice leaves the queue. A refused invoice moves to Problem.
   An invoice that waits for Xero's call limits stays queued.

With no accounting system on, the button issues the ready drafts only.

One ready invoice has its own **Send to Xero** button (**Send to Xero and
email** when the customer's send mode is approve and email). It does the same
steps for that invoice only. A draft that is not ready has no send button:
finalise it first. With no accounting system on, **Finalise** gives the
invoice the next number and locks it, and sends nothing. **Preview** comes
first, then **Save as draft**, then Finalise or the send button. With no
accounting system, Finalise is greyed until the invoice has a client and a due
date. Finalise is also greyed while the draft's job change is open.

## New invoice from a job

A new invoice can start blank or from a job. A strip above the form says
"Billing a job?". Its **Choose a job** button lists the jobs with no invoice
yet (client, practitioner, shipped date, total), with a search. Picking one makes its draft the way the
invoicing rules do (`POST /api/invoicing/jobs/:id/draft`): the client, the
Reference from the Reference rule, and the job's lines, linked to the job. A
job the rules refuse is not drafted, and the toast names the reason. An
invoice with no job stays allowed.

After a send, the next invoice of the list opens. The count in the bar holds
(1 of 35, then 2 of 35): the sent invoice stays in the bar's list until the
person goes back. Previous opens it again, issued, with a greyed **Sent to
Xero** button: an invoice that is queued, sent, or found in Xero cannot be
sent twice. Back reloads the list, where the sent invoice is under Issued.
After the last invoice of the list, the list opens.

Drafts work the same way. **Finalise** and **Save as draft** open the next
invoice of the list, so a person reviews drafts one after another without
going back. **Adopt changes** stays on the invoice, to show the result. An
invoice opened from somewhere else (the job board, search, a link) steps
through its own tab: Drafts, Ready, Problem, Issued or Void.

## Records

`invoices.send_state` is `queued`, `sent` or `failed` (null when the invoice
was never queued). `send_error` holds `{ code, message }` while failed.
Revising an issued invoice clears both.

## API

- `GET /api/invoicing/invoices?status=to_check|ready|problem` lists a view.
  Each invoice carries `view` (`to_check`, `ready`, `problem` or `sending`)
  and `problems`. `counts` includes `to_check`, `ready` and `problem`. One
  invoice (`GET /invoices/:id`) carries the same `view` and `problems`, and,
  for a draft, `sendsTo` and `sendMode` (this customer's mode, and whether
  the accounting system is connected and takes writes).
- `POST /api/invoicing/invoices/mark-ready` `{ invoiceIds }`: answers
  `{ marked, refused: [{ invoiceId, problems }] }`.
- `POST /api/invoicing/invoices/mark-not-ready` `{ invoiceIds }`.
- `POST /api/invoicing/invoices/send-ready` `{ issueDate, invoiceIds? }`:
  with `invoiceIds`, only those drafts, and each must be ready (`not_ready`).
- `POST /api/invoicing/invoices/send-again` `{ invoiceIds? }`.

## The job changed after the draft was made

When the work system's job changes after Flow made its draft
(docs/DATA_SPINE.md, three-way compare), the draft is in Problem and the
invoice page shows a banner: one row for each changed fact (client, a line's
item, description, quantity or price, an added or removed line, and the
total), with what it **Was** when the draft was made and what it is **Now in**
the work system. Flow never writes to the work system.

| Button | What it does |
| --- | --- |
| **Open in Seazona** | Opens the job in Seazona's own web app, to fix it there. It needs the Seazona setting **Order page link** (docs/SEAZONA.md); without it, it opens the lab's Seazona home page when the API address names it. |
| **Adopt Seazona changes** | Only when the work system alone changed and the draft is not sent. The draft takes the Now column, and the problem closes. Nothing goes to Seazona or the accounting system. |

A fix made in the work system closes the problem when Flow next reads the job.
