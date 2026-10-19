// Settings, Invoicing (/invoicing-settings): payment terms, the draft
// automation, and the lab's own rules a ready job passes before Flow drafts
// its invoice (invoice-rules.js, docs/INVOICE_RULES.md). Invoicing needs no integration: how an invoice
// goes to Xero is on the Xero integration page (sendModeSection).
// Draft when ready is an automation (server/core/automations.js); the
// Seazona integration page holds the rule that marks a job ready.
// One row for each setting: its name, one short line, and its control. A
// change saves at once. Everyone can read them; an owner or admin changes
// them. The full rules are in docs/INVOICING_RULES.md. app.js passes in its
// shared pieces as `ui`.

import { automationSection } from '/assets/ui/automations.js';
import { rulesSection } from '/assets/ui/invoice-rules.js';

const DOCS = 'https://github.com/arcforgelabs/flow/blob/main/docs/INVOICING_RULES.md';

const SEND_MODES = [
  { value: 'accounting_draft', label: 'Xero draft' },
  { value: 'approve_and_email', label: 'Approved and emailed' },
];

export async function renderInvoicingSettings(main, ui) {
  const { h, flow, toast, notice, pageHeader, me } = ui;
  const host = h('div', { class: 'fx-card', style: { padding: '8px 20px 16px' } }, h('div', { class: 'fx-skeleton' }));
  main.append(pageHeader('Invoicing', { subtitle: 'How Flow drafts invoices. No integration needed.' }), host);
  let body;
  try {
    body = await flow('/api/invoicing/settings');
  } catch (error) {
    host.replaceChildren(notice(error.message, 'danger'));
    return;
  }
  const disabled = !['owner', 'admin'].includes(me?.person.role);
  let saved = body.settings;

  async function save(changes, control) {
    control.disabled = true;
    try {
      saved = (await flow('/api/invoicing/settings', { method: 'PUT', body: JSON.stringify(changes) })).settings;
      toast('Saved.', 'success');
      return true;
    } catch (error) {
      toast(error.message, 'danger');
      return false;
    } finally {
      control.disabled = false;
    }
  }

  const row = (name, hint, control) => h('div', { class: 'fx-set__row' },
    h('div', { class: 'fx-set__text' }, h('span', { class: 'fx-set__name' }, name), h('span', { class: 'fx-set__hint' }, hint)),
    h('div', { class: 'fx-set__control' }, control));

  // A text or number box saves when it loses focus with a new value.
  const box = (key, label, { type = 'text', read = (v) => v, show = (v) => v ?? '', placeholder } = {}) => {
    const input = h('input', { class: 'fx-input', type, value: show(saved[key]), 'aria-label': label, disabled, placeholder });
    input.addEventListener('change', async () => {
      if (!(await save({ [key]: read(input.value) }, input))) input.value = show(saved[key]);
    });
    return input;
  };
  const days = (key, label) => box(key, label, { type: 'number', read: Number });

  const section = (title, ...rows) => h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, title), ...rows);
  host.replaceChildren(...[
    disabled ? notice('Only an owner or admin can change these.', 'info') : null,
    section('Drafts',
      row('Payment terms', 'Days from invoice to due date.', days('paymentTermsDays', 'Payment terms in days'))),
    automationSection(ui, 'invoicing', 'Automations'),
    rulesSection(ui),
  ].filter(Boolean));
}

// The Xero integration page's "Sending" section: how a checked invoice goes to
// Xero. A customer can have its own mode (/api/invoicing/contacts/:id/billing).
export function sendModeSection(ui) {
  const { h, flow, toast, notice, me } = ui;
  const disabled = !['owner', 'admin'].includes(me?.person.role);
  const select = h('select', { class: 'fx-select', 'aria-label': 'Send to Xero as', disabled },
    SEND_MODES.map((m) => h('option', { value: m.value }, m.label)));
  const section = h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, 'Sending'),
    h('div', { class: 'fx-set__row' },
      h('div', { class: 'fx-set__text' }, h('span', { class: 'fx-set__name' }, 'Send to Xero as'), h('span', { class: 'fx-set__hint' }, 'Draft: approve in Xero. Approved: Xero emails it.')),
      h('div', { class: 'fx-set__control' }, select)),
    h('p', { class: 'fx-dim', style: { margin: '8px 0 0' } }, h('a', { href: DOCS, target: '_blank', rel: 'noopener' }, 'How sending works')));
  let saved = null;
  (async () => {
    try {
      saved = (await flow('/api/invoicing/settings')).settings;
      select.value = saved.sendMode;
    } catch (error) {
      section.append(notice(error.message, 'danger'));
    }
  })();
  select.addEventListener('change', async () => {
    select.disabled = true;
    try {
      saved = (await flow('/api/invoicing/settings', { method: 'PUT', body: JSON.stringify({ sendMode: select.value }) })).settings;
      toast('Saved.', 'success');
    } catch (error) {
      toast(error.message, 'danger');
      if (saved) select.value = saved.sendMode;
    } finally {
      select.disabled = disabled;
    }
  });
  return section;
}
