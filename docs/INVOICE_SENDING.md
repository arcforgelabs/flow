# Invoice tabs and Send all ready

The Invoices page has six tabs, left to right: Pending, Ready, Draft,
Approved, Sent and Void. Earlier names: Problem is now Pending, Drafts is
gone (a clean draft is Ready), and Finalised is split into Draft, Approved
and Sent. Code: `server/core/sending.js`, `server/api/invoicing.js`
(`invoiceTabs`) and `server/integrations/xero/reconcile.js` (`stageOf`).

| Tab | An invoice is here when |
| --- | --- |
| Pending | A check failed, or the accounting system refused it. A person must look. |
| Ready | A Flow draft, and no check fails. Nobody has to mark it. |
| Draft | Issued in Flow and a draft in the accounting system, or on its way there. |
| Approved | Approved in the accounting system, not yet sent to the customer. With no accounting system, every issued invoice is here. |
| Sent | The accounting system sent it to the customer, or it is part paid or paid. |
| Void | Voided or deleted. |

A Ready invoice can go to the accounting system at any time. It then moves to
Draft, the lowest stage Xero takes. Draft, Approved and Sent follow Xero's own
status and its `SentToContact` flag, read from Flow's copy of Xero (no extra
Xero calls). An invoice in that copy from before the `sent_to_contact` column
(Xero migration 0009) shows as Approved until Xero changes it and Flow reads
it again.

## Ready

A draft with no problem is in Ready. A saved change keeps it there while the
checks pass. A draft with a problem is in Pending until the problem is fixed;
then it goes to Ready by itself. On the invoice the buttons are, left to
right, **Preview**, **Save as draft**, then **Send to Xero** (accounting
system on) or **Approve** (no accounting system). A Pending draft has no send
button. While the draft's job changed after it was made (below), send and
Approve are off: fix the job at its source, or accept the change.

### Bulk bar

Ticking rows on any tab of the Invoices list brings up the bulk bar
(server/ui/bulk-bar.js). It floats at the foot of the page, and the tabs,
search stay at the top while the rows scroll under them. The bar
shows **N selected ×** (× or Esc clears the ticks), then the tab's actions in
groups, then **More**, a searchable menu of every action plus Tick all shown,
Invert ticks and Clear ticks. An icon-only action shows its name on hover.

| Tab | Actions |
| --- | --- |
| Pending | **Retry** (send-again for the ticked issued ones the accounting system refused), Copy references, Export CSV |
| Ready | **Send to Xero** (send-ready for the ticked ids; **Approve** with no accounting system), Copy references, Export CSV |
| Draft, Approved, Sent | Copy numbers, Export CSV, Download PDFs, Void (asks first; Flow does not change the accounting system) |
| Void | Copy numbers, Export CSV, Download PDFs |

## Checks

Flow checks its own data first. The Problem column shows a short fact for
each failed check; the full text is its hover title.

| Check | Short fact | Full text |
| --- | --- | --- |
| The draft has lines | No lines | The invoice has no lines. |
| The total is above zero | Total $0 | The total is $0.00 or less. |
| Every line has a price item | Line N: no item | Line N has no price item. |
| The job is not in review | Line 4 added, Client changed, Job changed, Job deleted, Status moved back, Job needs a look | The job needs a look before this invoice goes: (the review reason). |

When an accounting system is on and connected, its own checks are added
(`checkDrafts`). For Xero these come from Flow's copy of Xero, so they cost no
Xero calls: the customer matches one Xero contact (Client not in Xero, Client
twice in Xero), and every item is in Xero (CODE not in Xero).

An issued invoice that the accounting system refused is in Pending (Send
failed). It shows the refusal until a person sends it again.

## Send all ready

On the Ready tab, an owner or admin ticks the rows (the head tick takes every
row shown), then presses **Send to Xero** (or **Approve**) in the bulk bar. It
asks first. There is no separate send bar. Then:

1. Flow stops before it issues anything when the accounting system is on but
   not connected, or does not take writes (`XERO_ALLOW_LIVE_WRITES`).
2. Read before act (issue #141): the job behind each ready draft whose work
   system report is over two hours old is read again from the work system,
   one call per job, at most 20 a press. A job that changed after its
   draft, or that the work system deleted or no longer bills, goes to
   review and its draft to Pending. A draft whose job could not be read
   waits for the next press (`waiting` in the answer).
   Then the accounting system reads its latest changes (issue #45, see
   [XERO.md](XERO.md#read-before-draft-and-send)). When that read cannot
   run, nothing is issued and every draft in the press waits.
   Every draft check then runs again, the lab's pending rules
   ([INVOICE_RULES.md](INVOICE_RULES.md#pending-rules)) included. A draft
   that fails one now stays on Pending and is not sent. When a person ticked
   drafts, the rest go and the answer counts the ones held (`held`); when
   every ticked draft fails, nothing is sent and the answer names the first
   problem.
3. Each ready draft is issued and gets its number. One press takes up to 100
   drafts; the rest wait for the next press.
4. Each issued invoice is queued for the accounting system, and shows in
   Draft with the status Sending.
5. The send worker sends the queue in the background, every 30 seconds, on the
   job queue. For Xero, each invoice goes as a Xero draft by default; the
   customer's send mode can make it an approved invoice that Xero emails.
6. A sent invoice leaves the queue. A refused invoice moves to Pending.
   An invoice that waits for Xero's call limits stays queued.
7. With an integration on, every tab has a **Linked** column: one icon for
   each connected system (Seazona, Xero), never one column per system. A dot
   gives the state of this invoice's link: green linked and in step, amber
   not in Xero yet, red out of step with Xero. A dashed grey icon means no
   link. The Xero icon shows on issued and void invoices; its title gives
   Xero's number and state. An icon with a link opens the record there.
8. One invoice's page has a **Linked** card with the same systems: the work
   system row gives the order number, the accounting row gives Xero's number
   and state, and each has **Open**. A separate Xero card shows only when
   Xero differs from what Flow sent.

With no accounting system on, the button is **Approve all N ready**: it
issues the ready drafts only, and they go to Approved.

One ready invoice has its own **Send to Xero** button (**Send to Xero and
email** when the customer's send mode is approve and email). It does the same
steps for that invoice only. With no accounting system on, **Approve** gives
the invoice the next number and locks it, and sends nothing. It is greyed
until the invoice has a client and a due date, and while the draft's job
change is open.

## New invoice from a job

A new invoice can start blank or from a job. **From a job**, in the page
header, lists the jobs with no invoice
yet (client, practitioner, shipped date, total), with a search. Picking one makes its draft the way the
invoicing rules do (`POST /api/invoicing/jobs/:id/draft`): the client, the
Reference from the Reference rule, and the job's lines, linked to the job. A
job the rules refuse is not drafted, and the toast names the reason. An
invoice with no job stays allowed.

After a send, the next invoice of the list opens. The count in the bar holds
(1 of 35, then 2 of 35): the sent invoice stays in the bar's list until the
person goes back. Previous opens it again, issued, with a greyed **Sent to
Xero** button: an invoice that is queued, sent, or found in Xero cannot be
sent twice. Back reloads the list, where the sent invoice is under Draft.
After the last invoice of the list, the list opens.

**Approve** and **Save as draft** open the next invoice of the list too, so a
person reviews invoices one after another without going back. **Accept
change** stays on the invoice, to show the result. An invoice opened from
somewhere else (the job board, search, a link) steps through its own tab.

## Records

`invoices.send_state` is `queued`, `sent` or `failed` (null when the invoice
was never queued). `send_error` holds `{ code, message }` while failed.
Revising an issued invoice clears both. `xero_invoices.sent_to_contact` holds
Xero's `SentToContact` flag.

## API

- `GET /api/invoicing/invoices?status=pending|ready|draft|approved|sent|void`
  lists a tab. The old names `problem`, `to_check` and `issued` still work.
  Each invoice carries `tab`, `sending` and `problems`. `counts` has one
  number per tab. One invoice (`GET /invoices/:id`) carries the same `tab`,
  `view` (`problem` or `ready`, for a draft) and `problems`, and, for a draft,
  `sendsTo` and `sendMode` (this customer's mode, and whether the accounting
  system is connected and takes writes).
- `POST /api/invoicing/invoices/mark-ready` and `mark-not-ready` stay for
  older pages; they no longer change the tab.
- `POST /api/invoicing/invoices/send-ready` `{ issueDate, invoiceIds? }`:
  with `invoiceIds`, only those drafts, and each must be ready (`not_ready`).
- `POST /api/invoicing/invoices/send-again` `{ invoiceIds? }`.
- `POST /api/invoicing/jobs/:id/use-new-lines` `{ accept? }`: the draft takes
  the work system's lines. With `accept: true` it also replaces lines changed
  in both places, while the invoice is not sent.
- `POST /api/invoicing/jobs/:id/recheck`: reads this one job from the work
  system now (at most once per job every 10 seconds), runs the checks again,
  and answers the invoice.

## The job changed after the draft was made

When the work system's job changes after Flow made its draft
(docs/DATA_SPINE.md, three-way compare), the draft is in Pending and the
invoice page shows a banner: one row for each changed fact (client, a line's
item, description, quantity or price, an added or removed line, and the
total), with what it **Was** when the draft was made and what it is **Now in**
the work system. Flow never writes to the work system.

| Button | What it does |
| --- | --- |
| **Open in Seazona** | Opens this order in Seazona's own web app by its id (`OrderEdit.aspx?id=…`), to fix it there. The Seazona setting **Order address** (docs/SEAZONA.md) overrides the address. With no order id, it opens the lab's Seazona home page. |
| **Accept change** | Only while the invoice is not sent. The draft takes the Now column, also for a line changed in both places (it asks first, and replaces the change made here). The problem closes, and the draft goes to Ready when no other check fails. Nothing goes to Seazona or the accounting system. |
| Recheck (round arrow icon) | Reads this job from Seazona again now, for when Seazona was wrong and is fixed. When it matches the draft, the problem closes. |

A fix made in the work system closes the problem when Flow next reads the job.

The Jobs page shows the same review. What a job must fix is a chip beside its
stage, such as **Job changed** (**+1** when there is more), so the panel keeps
one layout with or without a fix. Hover shows each fix in one line with its
link. A click on **Job changed** opens the panel's sidecar on the right (in
place of Activity) on Review, with this banner and its buttons, so a person
checks and accepts the change without leaving the job. The sidecar has
tabs (Activity, Review) and closes with ×; closed, the job's details take the
full width. The panel icon at the top reopens it.

The job and its draft hold one fact: the job is in review. Flow stores it once
(the job's hold, and one open review item for each job; a second report
updates that item). The panel shows it once: the draft's copy of the hold
(`job_review`) is left out, as on the invoice page. Accept change, a recheck
that matches, or a fix in the work system clears the hold and closes the item.
