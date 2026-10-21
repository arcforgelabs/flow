// Settings, Rules (/invoicing-settings): a card for each part, like the
// Integrations page, and one page for each (/invoicing-settings/<key>).
// Drafts holds payment terms and the Reference; Price codes the lines with no
// price item (line-mappings.js); Invoices the checks a ready job passes
// before Flow drafts its invoice (invoice-rules.js, docs/INVOICE_RULES.md).
// Automations have their own page (automations.js).
// How an invoice goes to Xero is on the Xero integration page
// (sendModeSection). A change saves at once. Everyone can read them; an owner
// or admin changes them. The full rules are in docs/INVOICING_RULES.md.
// app.js passes in its shared pieces as `ui`.

import { rulesSection } from '/assets/ui/invoice-rules.js';
import { lineMappingSection } from '/assets/ui/line-mappings.js';

const DOCS = 'https://github.com/arcforgelabs/flow/blob/main/docs/INVOICING_RULES.md';

const SEND_MODES = [
  { value: 'accounting_draft', label: 'Xero draft' },
  { value: 'approve_and_email', label: 'Approved and emailed' },
];

const onCount = (list) => ({ label: `${list.filter((x) => x.enabled).length} on`, tone: list.some((x) => x.enabled) ? 'success' : 'mute' });

// Each card: its page, its mark, and its state once the data is in. No
// blurb: the name and the state say enough.
const PARTS = [
  { key: 'drafts', title: 'Drafts', mark: 'draft', mount: (ui) => draftsSection(ui) },
  { key: 'price-codes', title: 'Price codes', mark: 'tag', mount: (ui) => lineMappingSection(ui),
    summary: async (flow) => {
      const { labels } = await flow('/api/invoicing/line-labels');
      const waiting = labels.filter((l) => l.unmapped > 0).length;
      return waiting ? { status: { label: `${waiting} wait`, tone: 'warn' }, action: 'Fix' } : { status: { label: 'All mapped', tone: 'success' } };
    } },
  { key: 'invoices', title: 'Invoices', mark: 'rules', mount: (ui) => rulesSection(ui, 'Invoices'),
    summary: async (flow) => ({ status: onCount((await flow('/api/invoicing/rules')).rules) }) },
];

export function renderInvoicingSettings(main, ui, id) {
  const { h, flow, notice, pageHeader, tileCard, crumbs } = ui;
  if (id) {
    const part = PARTS.find((p) => p.key === id);
    main.append(crumbs(['/invoicing-settings', 'Rules'], part?.title ?? 'Not found'),
      part ? h('div', { class: 'fx-card', style: { padding: '8px 20px 16px' } }, part.mount(ui)) : notice('No such part of Rules.', 'danger'));
    return;
  }
  const grid = h('div', { class: 'fx-int-grid' });
  main.append(pageHeader('Rules'), grid);
  // Each card shows at once and fills in its state when its data comes back.
  for (const part of PARTS) {
    const href = `/invoicing-settings/${part.key}`;
    const slot = tileCard({ href, mark: part.mark, title: part.title });
    grid.append(slot);
    if (part.summary) {
      part.summary(flow)
        .then((more) => slot.replaceWith(tileCard({ href, mark: part.mark, title: part.title, ...more })))
        .catch(() => {});
    }
  }
}

// Payment terms and the Reference template.
function draftsSection(ui) {
  const { h, flow, toast, notice, me } = ui;
  const disabled = !['owner', 'admin'].includes(me?.person.role);
  const section = h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, 'Drafts'), h('div', { class: 'fx-skeleton' }));
  let saved;

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

  (async () => {
    try {
      saved = (await flow('/api/invoicing/settings')).settings;
    } catch (error) {
      section.replaceChildren(h('h2', { class: 'fx-set__title' }, 'Drafts'), notice(error.message, 'danger'));
      return;
    }
    section.replaceChildren(...[
      h('h2', { class: 'fx-set__title' }, 'Drafts'),
      disabled ? notice('Only an owner or admin can change these.', 'info') : null,
      row('Payment terms', 'Days from invoice to due date.', box('paymentTermsDays', 'Payment terms in days', { type: 'number', read: Number })),
      row('Reference', 'The Reference on each invoice. Use {practitioner} and {patient}.',
        box('referenceTemplate', 'Reference rule', { placeholder: '{practitioner} - {patient}' })),
    ].filter(Boolean));
  })();
  return section;
}

// The Xero integration page's "Sending" section: how a checked invoice goes to
// Xero. A customer can have its own mode (/api/invoicing/contacts/:id/billing).
export function sendModeSection(ui) {
  const { h, flow, toast, notice, me } = ui;
  const disabled = !['owner', 'admin'].includes(me?.person.role);
  const select = h('select', { class: 'fx-select', 'aria-label': 'Send to Xero as', disabled },
    SEND_MODES.map((m) => h('option', { value: m.value }, m.label)));
  const section = h('section', { class: 'fx-set' }, ui.sectionTitle('Sending', { href: DOCS, label: 'How sending works' }),
    h('div', { class: 'fx-set__row' },
      h('div', { class: 'fx-set__text' }, h('span', { class: 'fx-set__name' }, 'Send to Xero as'), h('span', { class: 'fx-set__hint' }, 'Draft: approve in Xero. Approved: Xero emails it.')),
      h('div', { class: 'fx-set__control' }, select)));
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
