// An invoice's status: the one rule that puts each Flow invoice on one tab of
// the Invoices page. The list, the invoice page and its pager all read it, and
// the list stores the answer on the row (invoices.list_tab, with the time it
// last changed), so a count is one grouped query.
//
//   void             void in Flow, or voided or deleted in the accounting system
//   non_chargeable   No charge: a person or a rule says the work is not billed
//   pending          a person must look: a draft with a problem, a refused
//                    send, or out of sync with the accounting system
//   ready            a Flow draft whose checks pass
//   draft            a draft in the accounting system, or on its way there
//   awaiting_payment approved in the accounting system (or issued with none),
//                    not paid in full; `emailed` says if it went to the customer
//   paid             paid in full in the accounting system
//
// The first that fits wins, in that order.

export const INVOICE_TABS = Object.freeze(['pending', 'ready', 'draft', 'awaiting_payment', 'paid', 'non_chargeable', 'void']);

// Earlier tab names a saved link or view may still use.
export const OLD_TABS = Object.freeze({
  problem: 'pending', to_check: 'ready', issued: 'awaiting_payment', approved: 'awaiting_payment', sent: 'awaiting_payment',
});

// `status` is the Flow invoice's own (draft, issued, void). `view` is its
// draft check (sending.js): problem, non_chargeable, sending, or another.
// `stage` is its stage in the accounting system (the adapter's invoiceStages:
// pending, draft, approved, sent, paid or void), and `connected` says if there
// is one.
export function invoiceTab({ status, view = null, stage = null, connected = false }) {
  if (status === 'void') return 'void';
  if (view === 'non_chargeable') return 'non_chargeable';
  if (view === 'problem') return 'pending';
  if (status === 'draft') return 'ready';
  if (!connected) return 'awaiting_payment';
  if (view === 'sending') return 'draft';
  switch (stage) {
    case 'pending': return 'pending';
    case 'approved':
    case 'sent': return 'awaiting_payment';
    case 'paid': return 'paid';
    case 'void': return 'void';
    default: return 'draft';
  }
}

// The accounting system emailed the invoice to the customer.
export const emailedStage = (stage) => stage === 'sent';
