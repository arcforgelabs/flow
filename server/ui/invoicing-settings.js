// Settings, Rules (/invoicing-settings): a section of cards for each part,
// like Claude's Customize page, and one page for each
// (/invoicing-settings/<key>).
// Drafts holds payment terms and the Reference; Price codes the lines with no
// price item (line-mappings.js); Invoices the checks a ready job passes
// before Flow drafts its invoice (invoice-rules.js, docs/INVOICE_RULES.md).
// Automations have their own page (automations.js).
// How an invoice goes to Xero is on the Xero integration page
// (sendModeSection). A change saves at once. Everyone can read them; an owner
// or admin changes them. The full rules are in docs/INVOICING_RULES.md.
// app.js passes in its shared pieces as `ui`.

import { ruleSummary, rulesSection } from '/assets/ui/invoice-rules.js';
import { lineMappingSection } from '/assets/ui/line-mappings.js';

const DOCS = 'https://github.com/arcforgelabs/flow/blob/main/docs/INVOICING_RULES.md';

const SEND_MODES = [
  { value: 'accounting_draft', label: 'Xero draft' },
  { value: 'approve_and_email', label: 'Approved and emailed' },
];

// The parts of Rules, each on its own page (/invoicing-settings/<key>).
const PARTS = [
  { key: 'invoices', title: 'Invoices', mount: (ui) => rulesSection(ui, 'Invoices') },
  { key: 'drafts', title: 'Drafts', mount: (ui) => draftsSection(ui) },
  { key: 'price-codes', title: 'Price codes', mount: (ui) => lineMappingSection(ui) },
];

// What a rule does, as its card's mark and meta line.
const KIND = {
  pending: { mark: 'flag', label: 'Pending' },
  wait: { mark: 'clock', label: 'Waits' },
  skip: { mark: 'ban', label: 'Never drafted' },
};
const SHOWN = 6;

export function renderInvoicingSettings(main, ui, id) {
  const { h, flow, notice, pageHeader, tileCard, tileSection, crumbs } = ui;
  if (id) {
    const part = PARTS.find((p) => p.key === id);
    main.append(crumbs(['/invoicing-settings', 'Rules'], part?.title ?? 'Not found'),
      part ? h('div', { class: 'fx-card', style: { padding: '8px 20px 16px' } }, part.mount(ui)) : notice('No such part of Rules.', 'danger'));
    return;
  }
  // The landing is Claude's Customize page: a section for each part, two
  // columns of cards, and "Show all" to the part's own page.
  const host = h('div', { style: { display: 'grid', gap: '20px' } }, h('div', { class: 'fx-skeleton' }));
  main.append(pageHeader('Rules'), host);
  const page = (key) => `/invoicing-settings/${key}`;
  (async () => {
    let settings;
    let labels;
    let rules;
    let meta;
    try {
      [{ settings }, { labels }, { rules }, meta] = await Promise.all([
        flow('/api/invoicing/settings'), flow('/api/invoicing/line-labels'), flow('/api/invoicing/rules'), flow('/api/invoicing/rule-fields')]);
    } catch (error) {
      host.replaceChildren(notice(error.message, 'danger'));
      return;
    }
    const ruleCard = (rule) => {
      const kind = KIND[rule.action.kind] ?? { mark: 'list-checks', label: rule.action.kind };
      return tileCard({
        row: true, href: page('invoices'), mark: kind.mark, title: rule.name,
        blurb: ruleSummary(rule, meta).split(' · ')[0],
        meta: `${kind.label} · ${rule.enabled ? 'On' : 'Off'}`,
      });
    };
    const waiting = labels.filter((l) => l.unmapped > 0).length;
    host.replaceChildren(
      tileSection('Invoices', rules.length ? rules.slice(0, SHOWN).map(ruleCard) : [h('p', { class: 'fx-dim' }, 'No rules yet.')],
        { href: page('invoices'), more: rules.length > SHOWN ? `Show all ${rules.length}` : 'Show all' }),
      tileSection('Drafts', [
        tileCard({ row: true, href: page('drafts'), mark: 'calendar-clock', title: 'Payment terms', blurb: `Due ${settings.paymentTermsDays} days after the invoice date.` }),
        tileCard({ row: true, href: page('drafts'), mark: 'text-cursor-input', title: 'Reference', blurb: settings.referenceTemplate || '{practitioner} - {patient}' }),
      ], { href: page('drafts') }),
      tileSection('Price codes', [
        tileCard({
          row: true, href: page('price-codes'), mark: 'tag', title: 'Line labels',
          blurb: waiting ? `${waiting} with no price item.` : 'Every line has a price item.',
          status: waiting ? { label: `${waiting} wait`, tone: 'warn' } : { label: 'All mapped', tone: 'success' },
        }),
      ], { href: page('price-codes') }),
    );
  })();
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
