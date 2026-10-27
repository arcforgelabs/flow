// Link and Create for a Flow contact that is not a Xero contact
// (docs/CONTACTS.md). The Pending invoice and the contact page both show
// them. Link picks the Xero client when the names differ or Xero has the
// name twice; Flow writes only its own link. Create adds the client to Xero.
// `done(outcome)` runs after either one works.

const SMALL = new Set(['the', 'and', 'of', 'pty', 'ltd', 'limited', 'co', 'inc']);

function words(name) {
  return new Set(String(name ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((word) => word && !SMALL.has(word)));
}

// How many words two names share.
export function closeness(a, b) {
  const mine = words(a);
  let shared = 0;
  for (const word of words(b)) if (mine.has(word)) shared += 1;
  return shared;
}

// The Xero contacts nearest the name first, then A to Z.
export function nearestFirst(name, contacts) {
  return contacts
    .map((contact) => ({ contact, score: closeness(name, contact.name) }))
    .sort((a, b) => b.score - a.score || a.contact.name.localeCompare(b.contact.name))
    .map(({ contact }) => contact);
}

async function xeroContacts(ui, organisationId, q) {
  const query = new URLSearchParams({ organisationId, q, limit: '1000' });
  const { contacts } = await ui.flow(`/api/xero/contacts?${query}`);
  return contacts.filter((contact) => contact.status === 'ACTIVE');
}

export function xeroContactActions(ui, { organisationId, contact, offerLink = false, offerCreate = false, done }) {
  const { h, flow, toast } = ui;
  const failed = (button, error) => {
    toast(error.message, error.status === 429 ? 'info' : 'danger');
    if (error.retryAfterMs) ui.holdButton(button, error.retryAfterMs);
    else button.disabled = false;
  };

  const link = offerLink ? h('button', {
    class: `fx-btn ${offerCreate ? 'fx-btn--ghost' : 'fx-btn--primary'}`, type: 'button', title: 'Link this client to its Xero client',
    onclick: async (event) => {
      const button = event.currentTarget;
      const picked = await ui.pickOne({
        title: `Link ${contact.name} to Xero`,
        intro: 'Pick the Xero client. Flow links the two. Xero does not change.',
        label: 'Xero clients',
        find: 'Find a Xero client',
        remote: true,
        load: async (q) => nearestFirst(contact.name, await xeroContacts(ui, organisationId, q)),
        item: (row) => ({ value: row.xeroContactId, title: row.name, meta: [row.email, row.accountNumber].filter(Boolean).join(' · ') }),
        empty: 'No Xero client has that name. Sync Xero, or use Create.',
        confirm: 'Link',
      });
      if (!picked) return;
      button.disabled = true;
      try {
        await flow('/api/xero/contacts/link', { method: 'POST', body: JSON.stringify({ organisationId, contactId: contact.id, xeroContactId: picked.xeroContactId }) });
        toast(`${contact.name} is linked to ${picked.name} in Xero.`, 'success');
        await done('linked');
      } catch (error) {
        failed(button, error);
      }
    },
  }, 'Link') : null;

  const create = offerCreate ? h('button', {
    class: 'fx-btn fx-btn--primary', type: 'button', title: 'Create this client in Xero',
    onclick: async (event) => {
      const button = event.currentTarget;
      // A close name in Xero is often this client: say so before a second one.
      let close = [];
      try {
        close = (await xeroContacts(ui, organisationId, '')).filter((row) => closeness(contact.name, row.name) > 0);
      } catch { /* Create still works without the list. */ }
      const names = nearestFirst(contact.name, close).slice(0, 3).map((row) => row.name);
      const confirmed = await ui.dialog({
        title: `Create ${contact.name} in Xero?`,
        body: h('div', { class: 'fx-pick__body' },
          h('p', {}, 'Flow adds this client to Xero from the contact.'),
          names.length ? ui.notice(`Xero has ${names.join(', ')}. If one is this client, use Link.`, 'info', 'Close names.') : null),
        confirm: 'Create',
      });
      if (!confirmed) return;
      button.disabled = true;
      try {
        await flow('/api/xero/contacts', { method: 'POST', body: JSON.stringify({ organisationId, contactId: contact.id }) });
        toast(`${contact.name} is in Xero.`, 'success');
        await done('created');
      } catch (error) {
        failed(button, error);
      }
    },
  }, 'Create') : null;

  return [link, create].filter(Boolean);
}
