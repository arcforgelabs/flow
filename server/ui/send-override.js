// Override (docs/INVOICE_SENDING.md, "Override"): an owner or admin sends one
// Pending draft although it has a warning. The dialog is the extra step: one
// tick for each warning, a reason from the list, and a note. The invoice page
// opens it; the server checks the role, the ticks and the limit again
// (POST /api/invoicing/invoices/:id/send-anyway). Answers the sent invoice,
// or null when the person cancels.
export async function chooseOverride(ui, { invoice, to, issueDate }) {
  const { h } = ui;
  const warnings = invoice.problems ?? [];
  const reasons = Object.entries(invoice.overrideReasons ?? {});
  const ticks = warnings.map((p) => h('div', {}, h('label', { class: 'fx-check' },
    h('input', { type: 'checkbox', name: 'warning', value: p.key, required: true }),
    h('span', {}, p.message))));
  const reason = h('select', { class: 'fx-select', name: 'reason', required: true },
    h('option', { value: '' }, 'Choose a reason'),
    ...reasons.map(([value, label]) => h('option', { value }, label)));
  const note = h('textarea', { class: 'fx-input', name: 'note', rows: 2, maxlength: 200 });
  // "Other" needs a note: the form's own check stops Send until it has one.
  reason.addEventListener('change', () => { note.required = reason.value === 'other'; });
  const count = warnings.length;
  const form = await ui.dialog({
    title: `Send with ${count} ${count === 1 ? 'warning' : 'warnings'}?`,
    tone: 'danger',
    body: h('div', {},
      ...ticks,
      h('label', { class: 'fx-field' }, h('span', {}, 'Reason'), reason),
      h('label', { class: 'fx-field' }, h('span', {}, 'Note'), note),
      h('p', { class: 'fx-dim' }, `Goes to ${to} as a draft. Shows on Reconcile until closed.`)),
    confirm: 'Send',
  });
  if (!form) return null;
  const body = await ui.flow(`/api/invoicing/invoices/${invoice.id}/send-anyway`, {
    method: 'POST',
    body: JSON.stringify({
      issueDate, acknowledged: form.getAll('warning'), reasonCode: form.get('reason'), note: String(form.get('note') ?? '').trim() || null,
    }),
  });
  return body.invoice;
}

const day = (value) => new Date(value).toLocaleDateString('en-AU', { dateStyle: 'medium' });

// On the sent invoice: who sent this version with a warning, and when, with
// a link to its row on Reconcile.
export function overrideNotice(ui, invoice) {
  const override = (invoice.overrides ?? []).find((o) => o.version === invoice.issuedVersion);
  if (!override) return null;
  const count = override.problems.length;
  const shorts = [...new Set(override.problems.map((p) => p.short).filter(Boolean))].join(', ');
  const who = override.person?.name ?? 'A person';
  const state = override.review?.state === 'open' ? '' : ' Closed on Reconcile.';
  const line = ui.notice(`Sent with ${count} ${count === 1 ? 'warning' : 'warnings'}${shorts ? `. ${shorts}` : ''}. ${who}, ${day(override.createdAt)}.${state}`, 'warn', 'Override.');
  return ui.h('div', { class: 'fx-offer' }, line,
    ui.h('a', { class: 'fx-btn fx-btn--sm fx-btn--ghost', href: `/reconcile/${override.id}?kind=override`, onclick: (event) => ui.go(event) }, 'Reconcile'));
}
