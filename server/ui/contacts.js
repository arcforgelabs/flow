// Contacts (/contacts, /contacts/<id>). Flow's own customers and suppliers
// (server/core/contacts.js, docs/CONTACTS.md). The list and the record work
// with no integration on. When Xero is connected, the record says whether
// that contact is in Xero and, for an owner or admin, offers Link and Create.
import { columnTable, rowCells, viewSaver } from '/assets/ui/columns.js';
import { lucide } from '/assets/ui/custom-fields.js';
import { CONTACT_COLUMNS, normaliseListView } from '/assets/ui/job-view.js';
import { initialsOf } from '/assets/ui/person.js';
import { findBox } from '/assets/ui/view-bar.js';
import { xeroContactActions } from '/assets/ui/xero-contact.js';

const DOCS = 'https://github.com/arcforgelabs/flow/blob/main/docs/CONTACTS.md';
const KINDS = [['customer', 'Customer'], ['supplier', 'Supplier']];

const field = (h, label, control) => h('label', { class: 'fx-field' }, h('span', { class: 'fx-label' }, label), control);
const input = (h, attrs) => h('input', { class: 'fx-input', autocomplete: 'off', ...attrs });

export async function renderContacts(main, ui, id) {
  if (id) return renderContact(main, ui, id);
  return renderContactList(main, ui);
}

// The list sits in the shared list window (listHead, listFrame, columnTable),
// as Jobs, Invoices and Price list do: it never runs off the page, and each
// column keeps the width the person gives it.
async function renderContactList(main, ui) {
  const { h, flow, toast, notice, dialog, listHead, listFrame, go, me } = ui;
  const canEdit = ['owner', 'admin'].includes(me?.person.role);
  const host = h('div', { class: 'fx-panel' }, h('div', { class: 'fx-skeleton' }));
  let view = normaliseListView(me?.views?.contacts, CONTACT_COLUMNS);
  const saveView = viewSaver(ui, 'contacts');
  const heads = columnTable(h, {
    order: () => view.columns,
    widths: () => view.widths,
    change: (patch) => {
      view = normaliseListView({ ...view, ...patch }, CONTACT_COLUMNS);
      saveView(view);
      draw();
    },
    hidden: () => Object.keys(CONTACT_COLUMNS).filter((id) => !view.columns.includes(id)).map((id) => ({ id, label: CONTACT_COLUMNS[id] })),
  });
  // All, Customers, Suppliers, and Hidden: contacts that are not clients
  // (docs/CONTACTS.md, "Hidden contacts").
  let tab = 'all';
  let query = '';
  const tabs = h('div', { class: 'fx-tabs', role: 'tablist' });
  const find = findBox(h, { label: 'Find a name, email or account', oninput: (words) => { query = words; draw(); } });
  const add = h('button', { class: 'fx-btn fx-btn--primary', type: 'button', hidden: !canEdit, onclick: () => createContact() }, lucide(h, 'plus'), 'New');
  const top = listHead('Contacts', {
    help: { href: DOCS, label: 'How contacts work' }, actions: [add], start: tabs, end: find.element, line: true, sticky: true,
  });
  const frame = listFrame(main, host);
  main.append(...top.nodes, frame.element);

  const COLUMN_DEFS = {
    name: { kind: 'client', phone: 'title', cell: (contact) => h('a', { class: 'fx-person', href: `/contacts/${contact.id}`, onclick: (event) => { event.stopPropagation(); go(event); } },
      h('span', { class: 'fx-avatar', 'aria-hidden': 'true' }, initialsOf(contact.name)),
      h('span', { class: 'fx-person__name' }, contact.name,
        contact.active ? null : h('span', { class: 'fx-tag' }, 'Inactive'),
        contact.hidden ? h('span', { class: 'fx-tag' }, 'Hidden') : null)) },
    kind: { kind: 'status', phone: 'meta', className: 'fx-dim', cell: (contact) => KINDS.find(([value]) => value === contact.kind)?.[1] ?? contact.kind },
    email: { kind: 'text', phone: 'meta', className: 'fx-dim', cell: (contact) => contact.email ?? '' },
    account: { kind: 'text', phone: 'hide', className: 'fx-num', cell: (contact) => contact.accountNumber ?? '' },
  };

  let rows = [];
  const draw = () => {
    const needle = query.trim().toLowerCase();
    const counts = { all: rows.length, ...Object.fromEntries(KINDS.map(([value]) => [value, rows.filter((c) => c.kind === value).length])) };
    tabs.replaceChildren(...[['all', 'All'], ...KINDS.map(([value, label]) => [value, `${label}s`]), ['hidden', 'Hidden']].map(([id, label]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(tab === id), onclick: () => { const was = tab; tab = id; if ((was === 'hidden') !== (id === 'hidden')) load(); else draw(); },
    }, label, id === 'hidden' || listed === 'true' ? null : h('span', { class: 'fx-tabs__count' }, String(counts[id] ?? 0)))));
    const shown = rows.filter((contact) => {
      if (!['all', 'hidden'].includes(tab) && contact.kind !== tab) return false;
      if (!needle) return true;
      return [contact.name, contact.email, contact.accountNumber].some((value) => String(value ?? '').toLowerCase().includes(needle));
    });
    frame.count(`${shown.length} ${shown.length === 1 ? 'contact' : 'contacts'}`);
    if (!shown.length) {
      host.replaceChildren(h('p', { class: 'fx-empty' }, rows.length ? 'Nothing matches.' : 'No contacts.'));
      return;
    }
    const columns = view.columns.map((id) => ({ id, label: CONTACT_COLUMNS[id], ...COLUMN_DEFS[id] }));
    const open = (contact) => go(`/contacts/${contact.id}`);
    host.replaceChildren(heads.table({
      className: 'fx-table--rows fx-contacts__table',
      columns,
      rows: h('tbody', {}, shown.map((contact) => h('tr', {
        class: 'fx-row-link', tabindex: '0', onclick: () => open(contact), onkeydown: (event) => { if (event.key === 'Enter') open(contact); },
      }, rowCells(h, columns, contact), h('td', { class: 'fx-c-end' })))),
    }));
  };

  // The hidden contacts are their own list: the server leaves them out of
  // every other one.
  let listed = null;
  async function load() {
    const hidden = tab === 'hidden' ? 'true' : 'false';
    if (hidden === listed) return draw();
    try {
      ({ contacts: rows } = await flow(`/api/invoicing/contacts?kind=all&active=all&hidden=${hidden}&limit=500`));
      listed = hidden;
      draw();
    } catch (error) {
      host.replaceChildren(notice(error.message, 'danger'));
    }
  }

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

  await load();
}

async function renderContact(main, ui, id) {
  const { h, flow, toast, notice, pageHeader, crumbs, me, go } = ui;
  let canEdit = ['owner', 'admin'].includes(me?.person.role);
  const page = h('div', { class: 'fx-contacts' }, h('div', { class: 'fx-skeleton' }));
  main.append(page);
  let contact;
  try {
    ({ contact } = await flow(`/api/invoicing/contacts/${id}`));
  } catch (error) {
    page.replaceChildren(notice(error.message, 'danger'));
    return;
  }
  // A merged contact is read only, and points at the one it moved into.
  if (contact.mergedIntoId) canEdit = false;

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

  // Merge (docs/CONTACTS.md, "Merge two contacts"): another contact moves
  // into this one, which keeps its name as an alias.
  const merge = h('button', {
    class: 'fx-btn', type: 'button', hidden: !canEdit, title: 'Merge another contact into this one',
    onclick: async () => {
      const picked = await ui.pickOne({
        title: `Merge into ${contact.name}`,
        intro: `Its jobs, invoices, links and rules move to ${contact.name}. Its name stays as another name of ${contact.name}.`,
        label: 'Contacts',
        find: 'Find a contact',
        remote: true,
        load: async (q) => (await flow(`/api/invoicing/contacts?${new URLSearchParams({ q, kind: contact.kind, hidden: 'all', active: 'all', limit: '50' })}`)).contacts
          .filter((row) => row.id !== contact.id),
        item: (row) => ({ value: row.id, title: row.name, meta: row.email ?? null }),
        empty: 'No contact has that name.',
        confirm: 'Merge',
      });
      if (!picked) return;
      merge.disabled = true;
      try {
        const { moved } = await flow(`/api/invoicing/contacts/${id}/merge`, { method: 'POST', body: JSON.stringify({ fromId: picked.id }) });
        toast(`Merged: ${moved.jobs} jobs, ${moved.invoices} invoices.`, 'success');
        go(`/contacts/${id}`);
      } catch (error) {
        toast(error.message, 'danger');
        merge.disabled = false;
      }
    },
  }, 'Merge');
  const mergedNote = contact.mergedIntoId ? h('section', { class: 'fx-card fx-offer' },
    notice('This contact moved into another.', 'info', 'Merged.'),
    h('a', { class: 'fx-btn', href: `/contacts/${contact.mergedIntoId}`, onclick: go }, 'Open')) : null;
  const xero = h('div');
  const billTo = h('div');
  // A contact that is not a client (docs/CONTACTS.md, "Hidden contacts").
  const hiddenNote = h('div');
  const drawHidden = () => {
    if (!contact.hidden) return hiddenNote.replaceChildren();
    const show = canEdit ? h('button', {
      class: 'fx-btn', type: 'button', title: 'Show this contact in the lists',
      onclick: async () => {
        show.disabled = true;
        try {
          ({ contact } = await flow(`/api/invoicing/contacts/${id}`, { method: 'PATCH', body: JSON.stringify({ hidden: false }) }));
          toast('Shown.', 'success');
          drawHidden();
        } catch (error) {
          toast(error.message, 'danger');
          show.disabled = false;
        }
      },
    }, 'Show') : null;
    hiddenNote.replaceChildren(h('section', { class: 'fx-card fx-offer' },
      notice('Not a client: no job and no invoice.', 'info', 'Hidden.'), show));
  };
  drawHidden();
  page.replaceChildren(
    crumbs(['/contacts', 'Contacts'], contact.name),
    pageHeader(contact.name, { actions: [merge, save] }),
    mergedNote,
    contact.mergedIntoId ? null : hiddenNote,
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
    billTo,
    xero,
  );
  const reloadXero = () => loadXero(ui, contact, canEdit, xero);
  if (contact.kind === 'customer' && !contact.mergedIntoId) void loadBillTo(ui, contact, canEdit, billTo, reloadXero);
  void reloadXero();
}

// Bill to (docs/CONTACTS.md): another customer, the payer, whose accounting
// contact this client's work is billed to. Many clients may name one payer.
async function loadBillTo(ui, contact, canEdit, host, changed) {
  const { h, flow, toast, notice } = ui;
  let payer = null;
  const save = async (billToContactId, button) => {
    if (button) button.disabled = true;
    try {
      await flow(`/api/invoicing/contacts/${contact.id}/billing`, { method: 'PUT', body: JSON.stringify({ billToContactId }) });
      toast(billToContactId ? 'Bill to saved.' : 'Bill to cleared.', 'success');
      await load();
      await changed();
    } catch (error) {
      toast(error.message, 'danger');
      if (button) button.disabled = false;
    }
  };
  const pick = async (event) => {
    const button = event.currentTarget;
    const picked = await ui.pickOne({
      title: `Bill ${contact.name} to`,
      intro: 'Pick the customer that pays for this client. Its Xero contact gets the invoices.',
      label: 'Customers',
      find: 'Find a customer',
      remote: true,
      load: async (q) => (await flow(`/api/invoicing/contacts?${new URLSearchParams({ q, limit: '50' })}`)).contacts
        .filter((row) => row.id !== contact.id),
      item: (row) => ({ value: row.id, title: row.name, meta: row.email ?? null }),
      empty: 'No customer has that name.',
      confirm: 'Save',
    });
    if (picked) await save(picked.id, button);
  };
  const draw = () => {
    const change = canEdit ? h('button', { class: 'fx-btn', type: 'button', title: 'Pick the customer that pays', onclick: pick }, payer ? 'Change' : 'Set') : null;
    const clear = canEdit && payer ? h('button', {
      class: 'fx-btn fx-btn--ghost', type: 'button', title: 'Bill this client itself',
      onclick: (event) => save(null, event.currentTarget),
    }, 'Clear') : null;
    host.replaceChildren(h('section', { class: 'fx-card fx-offer' },
      notice(payer ? `Billed to ${payer.name}.` : 'Billed to itself.', 'info', 'Bill to.'),
      change, clear));
  };
  async function load() {
    try {
      const { billing } = await flow(`/api/invoicing/contacts/${contact.id}/billing`);
      payer = billing.billToContactId ? (await flow(`/api/invoicing/contacts/${billing.billToContactId}`)).contact : null;
      draw();
    } catch (error) {
      host.replaceChildren(notice(error.message, 'danger'));
    }
  }
  await load();
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
  const text = match.billTo
    ? (match.state === 'matched'
      ? `Billed to ${match.billTo.name}, in Xero as ${match.name}.`
      : `Billed to ${match.billTo.name}, which is not linked to Xero. Link it on its contact page.`)
    : match.state === 'matched'
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
