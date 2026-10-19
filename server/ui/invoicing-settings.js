// Settings, Invoicing (/invoicing-settings): the checks a ready job passes
// before Flow drafts its invoice, and how a checked invoice goes to the
// accounting system (server/core/invoicing-rules.js, /api/invoicing/settings).
// Draft when ready is an automation (server/core/automations.js); the
// Seazona integration page holds the rule that marks a job ready.
// One row for each setting: its name, one short line, and its control. A
// change saves at once. Everyone can read them; an owner or admin changes
// them. The full rules are in docs/INVOICING_RULES.md. app.js passes in its
// shared pieces as `ui`.

import { automationSection } from '/assets/ui/automations.js';

const DOCS = 'https://github.com/arcforgelabs/flow/blob/main/docs/INVOICING_RULES.md';

const SEND_MODES = [
  { value: 'accounting_draft', label: 'Xero draft' },
  { value: 'approve_and_email', label: 'Approved and emailed' },
];

export async function renderInvoicingSettings(main, ui) {
  const { h, flow, toast, notice, pageHeader, me } = ui;
  const host = h('div', { class: 'fx-card', style: { padding: '8px 20px 16px' } }, h('div', { class: 'fx-skeleton' }));
  main.append(pageHeader('Invoicing', { subtitle: 'Checks before a draft, and how invoices go to Xero.' }), host);
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

  const toggle = (key, label) => {
    const button = h('button', { class: 'fx-switch', type: 'button', role: 'switch', 'aria-label': label, 'aria-checked': String(saved[key]), disabled });
    button.addEventListener('click', async () => {
      const next = button.getAttribute('aria-checked') !== 'true';
      if (await save({ [key]: next }, button)) button.setAttribute('aria-checked', String(next));
    });
    return button;
  };

  // A text or number box saves when it loses focus with a new value.
  const box = (key, label, { type = 'text', read = (v) => v, show = (v) => v ?? '', placeholder } = {}) => {
    const input = h('input', { class: 'fx-input', type, value: show(saved[key]), 'aria-label': label, disabled, placeholder });
    input.addEventListener('change', async () => {
      if (!(await save({ [key]: read(input.value) }, input))) input.value = show(saved[key]);
    });
    return input;
  };
  const days = (key, label) => box(key, label, { type: 'number', read: Number });

  const sendMode = h('select', { class: 'fx-select', 'aria-label': 'Send to Xero as', disabled },
    SEND_MODES.map((m) => h('option', { value: m.value, selected: saved.sendMode === m.value }, m.label)));
  sendMode.addEventListener('change', async () => {
    if (!(await save({ sendMode: sendMode.value }, sendMode))) sendMode.value = saved.sendMode;
  });

  const section = (title, ...rows) => h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, title), ...rows);
  host.replaceChildren(...[
    disabled ? notice('Only an owner or admin can change these.', 'info') : null,
    section('Drafts',
      row('Payment terms', 'Days from invoice to due date.', days('paymentTermsDays', 'Payment terms in days')),
      row('Old job limit', 'Older jobs wait for a person (days).', days('staleDays', 'Old job limit in days')),
      row('Practitioner required', 'The job or its customer names one.', toggle('requirePractitioner', 'Practitioner required')),
      row('Rush item code', 'Price item code of a rush charge.', box('rushItemCode', 'Rush item code', { read: (v) => v.trim() || null, placeholder: 'None' })),
      row('Rush share', 'Rush line as % of the other lines.', days('rushPercent', 'Rush share in percent'))),
    automationSection(ui, 'invoicing', 'Automations'),
    section('Sending',
      row('Send to Xero as', 'Draft: approve in Xero. Approved: Xero emails it.', sendMode)),
    h('p', { class: 'fx-dim', style: { margin: '12px 0 0' } }, h('a', { href: DOCS, target: '_blank', rel: 'noopener' }, 'How the rules work')),
  ].filter(Boolean));
}
