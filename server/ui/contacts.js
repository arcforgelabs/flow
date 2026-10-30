// Contacts (/contacts, /contacts/<id>). Flow's own customers and suppliers
// (server/core/contacts.js, docs/CONTACTS.md). The list and the record work
// with no integration on. When Xero is connected, the record says whether
// that contact is in Xero and, for an owner or admin, offers Link and Create.
import { initialsOf } from '/assets/ui/person.js';
import { mountPortalSection } from '/assets/ui/portal-lab.js';
import { xeroContactActions } from '/assets/ui/xero-contact.js';

const DOCS = 'https://github.com/arcforgelabs/flow/blob/main/docs/CONTACTS.md';
const KINDS = [['customer', 'Customer'], ['supplier', 'Supplier']];

const field = (h, label, control) => h('label', { class: 'fx-field' }, h('span', { class: 'fx-label' }, label), control);
const input = (h, attrs) => h('input', { class: 'fx-input', autocomplete: 'off', ...attrs });

export async function renderContacts(main, ui, id) {
  if (id) return renderContact(main, ui, id);
  return renderContactList(main, ui);
}

async function renderContactList(main, ui) {
  const { h, flow, toast, notice, dialog, pageHeader, go, me } = ui;
  const canEdit = ['owner', 'admin'].includes(me?.person.role);
  const host = h('div', { class: 'fx-panel' }, h('div', { class: 'fx-skeleton' }));
  const search = input(h, { type: 'search', 'aria-label': 'Search', placeholder: 'Search', class: 'fx-input fx-contacts__search' });
  const kind = h('select', { class: 'fx-select', 'aria-label': 'Kind' },
    h('option', { value: 'all', selected: true }, 'All'),
    ...KINDS.map(([value, label]) => h('option', { value }, `${label}s`)));
  const page = h('div', { class: 'fx-contacts' });
  const add = h('button', { class: 'fx-btn fx-btn--primary', type: 'button', hidden: !canEdit, onclick: () => createContact() }, 'New');
  page.append(
    pageHeader('Contacts', { help: { href: DOCS, label: 'How contacts work' }, actions: [add] }),
    host,
  );
  main.append(page);

  let rows = [];
  const draw = () => {
    const needle = search.value.trim().toLowerCase();
    const shown = rows.filter((contact) => {
      if (kind.value !== 'all' && contact.kind !== kind.value) return false;
      if (!needle) return true;
      return [contact.name, contact.email, contact.accountNumber].some((value) => String(value ?? '').toLowerCase().includes(needle));
    });
    const body = shown.length
      ? h('table', { class: 'fx-table fx-people' },
        h('thead', { class: 'fx-sr' }, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Kind'), h('th', {}, 'Account'))),
        h('tbody', {}, shown.map((contact) => h('tr', {},
          h('td', {}, h('a', { class: 'fx-person', href: `/contacts/${contact.id}`, onclick: go },
            h('span', { class: 'fx-avatar', 'aria-hidden': 'true' }, initialsOf(contact.name)),
            h('span', { class: 'fx-person__text' },
              h('span', { class: 'fx-person__name' }, contact.name, contact.active ? null : h('span', { class: 'fx-tag' }, 'Inactive')),
              contact.email ? h('span', { class: 'fx-person__email' }, contact.email) : null))),
          h('td', {}, KINDS.find(([value]) => value === contact.kind)?.[1] ?? contact.kind),
          h('td', {}, contact.accountNumber ?? '')))))
      : h('p', { class: 'fx-empty' }, rows.length ? 'Nothing matches.' : 'No contacts.');
    host.replaceChildren(
      h('div', { class: 'fx-contacts__tools' }, search, kind),
      body,
    );
  };

  search.addEventListener('input', draw);
  kind.addEventListener('change', draw);

  async function createContact() {
    const name = input(h, { name: 'name', required: true, 'aria-label': 'Name' });
    const kindInput = h('select', { class: 'fx-select', name: 'kind', 'aria-label': 'Kind' },
      ...KINDS.map(([value, label]) => h('option', { value, selected: value === 'customer' }, label)));
    const email = input(h, { name: 'email', type: 'email', 'aria-label': 'Email' });
    const confirmed = await dialog({
      title: 'New contact',
      confirm: 'Create',
      body: h('div', { class: 'fx-fields' },
        field(h, 'Name', name),
        field(h, 'Kind', kindInput),
        field(h, 'Email', email)),
    });
    if (!confirmed) return;
    try {
      const body = await flow('/api/invoicing/contacts', {
        method: 'POST',
        body: JSON.stringify({
          name: String(confirmed.get('name') ?? ''),
          kind: String(confirmed.get('kind') ?? 'customer'),
          email: String(confirmed.get('email') ?? '').trim() || null,
        }),
      });
      go(`/contacts/${body.contact.id}`);
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  try {
    ({ contacts: rows } = await flow('/api/invoicing/contacts?kind=all&active=all&limit=200'));
    draw();
  } catch (error) {
    host.replaceChildren(notice(error.message, 'danger'));
  }
}

async function renderContact(main, ui, id) {
  const { h, flow, toast, notice, pageHeader, crumbs, me } = ui;
  const canEdit = ['owner', 'admin'].includes(me?.person.role);
  const page = h('div', { class: 'fx-contacts' }, h('div', { class: 'fx-skeleton' }));
  main.append(page);
  let contact;
  try {
    ({ contact } = await flow(`/api/invoicing/contacts/${id}`));
  } catch (error) {
    page.replaceChildren(notice(error.message, 'danger'));
    return;
  }

  const values = {
    name: input(h, { value: contact.name ?? '' }),
    kind: h('select', { class: 'fx-select', 'aria-label': 'Kind' },
      ...KINDS.map(([value, label]) => h('option', { value, selected: value === contact.kind }, label))),
    firstName: input(h, { value: contact.firstName ?? '' }),
    lastName: input(h, { value: contact.lastName ?? '' }),
    email: input(h, { type: 'email', value: contact.email ?? '' }),
    phone: input(h, { value: contact.phone ?? '' }),
    mobile: input(h, { value: contact.mobile ?? '' }),
    accountNumber: input(h, { value: contact.accountNumber ?? '' }),
    taxNumber: input(h, { value: contact.taxNumber ?? '' }),
    taxRate: input(h, { value: contact.taxRate ?? '' }),
  };
  const address = contact.address ?? {};
  const addressInputs = {
    line1: input(h, { value: address.line1 ?? '', 'aria-label': 'Address line 1' }),
    line2: input(h, { value: address.line2 ?? '', 'aria-label': 'Address line 2' }),
    city: input(h, { value: address.city ?? '', 'aria-label': 'City' }),
    region: input(h, { value: address.region ?? '', 'aria-label': 'Region' }),
    postalCode: input(h, { value: address.postalCode ?? '', 'aria-label': 'Postal code' }),
    country: input(h, { value: address.country ?? '', 'aria-label': 'Country' }),
  };
  const practitioners = h('textarea', {
    class: 'fx-input', rows: '4', 'aria-label': 'Practitioners',
  }, (contact.practitioners ?? []).map((person) => person.name).join('\n'));
  const active = h('input', { type: 'checkbox', checked: contact.active });
  for (const control of [...Object.values(values), ...Object.values(addressInputs), practitioners, active]) {
    if (!canEdit) control.disabled = true;
  }

  const save = h('button', {
    class: 'fx-btn fx-btn--primary', type: 'button', hidden: !canEdit,
    onclick: async () => {
      const addressBody = Object.fromEntries(Object.entries(addressInputs).map(([key, control]) => [key, control.value.trim()]));
      const people = practitioners.value.split('\n').map((line) => line.trim()).filter(Boolean).map((name) => ({ name }));
      save.disabled = true;
      try {
        const body = await flow(`/api/invoicing/contacts/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: values.name.value,
            kind: values.kind.value,
            firstName: values.firstName.value,
            lastName: values.lastName.value,
            email: values.email.value,
            phone: values.phone.value,
            mobile: values.mobile.value,
            accountNumber: values.accountNumber.value,
            taxNumber: values.taxNumber.value,
            taxRate: values.taxRate.value,
            address: Object.values(addressBody).some(Boolean) ? addressBody : null,
            practitioners: people,
            active: active.checked,
          }),
        });
        toast('Saved.', 'success');
        contact = body.contact;
      } catch (error) {
        toast(error.message, 'danger');
      } finally {
        save.disabled = false;
      }
    },
  }, 'Save');

  const xero = h('div');
  const portal = h('div');
  page.replaceChildren(
    crumbs(['/contacts', 'Contacts'], contact.name),
    pageHeader(contact.name, { actions: [save] }),
    h('section', { class: 'fx-card' },
      h('div', { class: 'fx-contacts__grid' },
        field(h, 'Name', values.name),
        field(h, 'Kind', values.kind),
        field(h, 'First name', values.firstName),
        field(h, 'Last name', values.lastName),
        field(h, 'Email', values.email),
        field(h, 'Phone', values.phone),
        field(h, 'Mobile', values.mobile),
        field(h, 'Account', values.accountNumber),
        field(h, 'Tax number', values.taxNumber),
        field(h, 'Tax rate', values.taxRate),
        h('div', { class: 'fx-contacts__wide fx-fields' },
          field(h, 'Address', addressInputs.line1),
          addressInputs.line2,
          h('div', { class: 'fx-contacts__grid' },
            field(h, 'City', addressInputs.city),
            field(h, 'Region', addressInputs.region),
            field(h, 'Postal code', addressInputs.postalCode),
            field(h, 'Country', addressInputs.country))),
        h('label', { class: 'fx-field fx-contacts__wide' },
          h('span', { class: 'fx-label' }, 'Practitioners'),
          practitioners),
        h('label', { class: 'fx-check' }, active, 'Active'))),
    portal,
    xero,
  );
  void mountPortalSection(ui, contact, portal);
  void loadXero(ui, contact, canEdit, xero);
}

async function loadXero(ui, contact, canEdit, host) {
  const { h, flow, toast, notice } = ui;
  let context;
  try {
    context = await flow('/api/invoicing/context');
  } catch {
    return;
  }
  const organisationId = context.organisations?.[0]?.id;
  if (!organisationId) return;
  let match;
  try {
    match = await flow(`/api/xero/contacts/match?organisationId=${encodeURIComponent(organisationId)}&contactId=${encodeURIComponent(contact.id)}`);
  } catch {
    return;
  }
  if (match.state === 'off') return;
  const actions = canEdit ? xeroContactActions(ui, {
    organisationId, contact, offerLink: match.offerLink, offerCreate: match.offerCreate,
    done: (outcome) => host.replaceChildren(h('section', { class: 'fx-card' },
      notice(outcome === 'linked' ? `${contact.name} is linked to Xero.` : `${contact.name} is in Xero.`, 'success'))),
  }) : [];
  const text = match.state === 'matched'
    ? `In Xero${match.name ? ` as ${match.name}` : ''}.`
    : match.state === 'ambiguous'
      ? `More than one Xero contact is named "${contact.name}".`
      : `No Xero contact is named "${contact.name}".`;
  // Fields both sides changed (Two-way edits): alert only. A person makes the
  // two the same, here or in Xero, and the next check clears it.
  const differs = match.differs ?? [];
  const clash = differs.length
    ? notice(`Changed in both: ${differs.map((d) => FIELD_LABELS[d.field] ?? d.field).join(', ')}. Make Flow and Xero the same.`, 'warn', 'Xero differs.')
    : null;
  host.replaceChildren(h('section', { class: 'fx-card fx-offer' },
    clash ?? notice(text, match.state === 'matched' ? 'success' : 'danger', match.state === 'matched' ? 'Xero.' : 'Xero.'),
    ...actions));
}

const FIELD_LABELS = {
  name: 'Name', firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone',
  mobile: 'Mobile', accountNumber: 'Account', taxNumber: 'Tax number', address: 'Address',
};
