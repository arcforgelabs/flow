import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createContact, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice } from '../server/core/invoices.js';
import { xeroContactBody } from '../server/integrations/xero/create-contact.js';
import { resolveXeroSettings } from '../server/integrations/xero/settings.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, scriptedXero, seedLab, xeroAnswer } from './support/xero.js';

const contact = {
  kind: 'customer', name: 'Harbour Dental', firstName: 'Ada', lastName: 'Lovelace',
  email: 'accounts@harbour.example', phone: '0290000000', mobile: '0400000000',
  accountNumber: 'HD-1', taxNumber: '53004085616', taxRate: 'GST',
  address: { line1: '1 Wharf', city: 'Sydney', region: 'NSW', postalCode: '2000', country: 'Australia' },
  practitioners: [
    { name: 'Ada Lovelace', email: 'ada@harbour.example' },
    { name: 'Grace Hopper' },
    { name: 'Three' }, { name: 'Four' }, { name: 'Five' }, { name: 'Six' },
  ],
};

test('a Flow contact becomes one Xero contact, with the first five practitioners', () => {
  const body = xeroContactBody(contact);
  assert.equal(body.Name, 'Harbour Dental');
  assert.equal(body.IsCustomer, true);
  assert.equal(body.EmailAddress, 'accounts@harbour.example');
  assert.equal(body.TaxNumber, '53004085616');
  assert.equal(body.TaxRate, undefined);
  assert.deepEqual(body.Phones.map((phone) => phone.PhoneType), ['DEFAULT', 'MOBILE']);
  assert.deepEqual(body.Addresses.map((address) => address.AddressType), ['POBOX', 'STREET']);
  assert.equal(body.Addresses[0].City, 'Sydney');
  assert.equal(body.ContactPersons.length, 5);
  assert.deepEqual(body.ContactPersons[0], {
    FirstName: 'Ada', LastName: 'Lovelace', EmailAddress: 'ada@harbour.example', IncludeInEmails: false,
  });
  assert.equal(resolveXeroSettings({ XERO_MODE: 'replay' }).createContacts, true);
  assert.equal(resolveXeroSettings({ XERO_MODE: 'replay', XERO_CREATE_CONTACTS: 'off' }).createContacts, false);
});

function xeroContact(id, name, status = 'ACTIVE') {
  return {
    ContactID: id, Name: name, ContactStatus: status, IsCustomer: true,
    EmailAddress: 'accounts@harbour.example', FirstName: 'Ada', LastName: 'Lovelace',
  };
}
const named = (name) => xeroAnswer('Contacts', { Contacts: [] }, { query: { where: `Name=="${name}"` } });

describe('creating the Xero contact for a Flow contact', { skip: skipWithoutDatabase }, () => {
  let handle;
  let lab;
  let app;
  let xero;
  let crown;
  const org = () => lab.organisation.id;
  const call = (path, options = {}) => request(app, path, { token: lab.ownerToken, ...options });

  before(async () => {
    handle = await freshDatabase();
    xero = scriptedXero();
    const booted = await bootFlow(handle, { runtime: xero.runtime });
    app = booted.app;
    lab = await seedLab(handle, booted.clerk);
    crown = await createPriceItem(handle.db, org(), { code: 'CROWN', name: 'Crown', unitAmountCents: 25000 });
    await connectDirectly(handle, xero.runtime, org());
    await handle.db.execute(sql`insert into xero_items (organisation_id, xero_item_id, code, name) values (${org()}, 'i1', 'CROWN', 'Crown')`);
  });

  after(async () => handle?.close());

  async function make(name) {
    const row = await createContact(handle.db, org(), { ...contact, name });
    const invoice = await createDraftInvoice(handle.db, org(), { contactId: row.id, lines: [{ priceItemId: crown.id }] });
    return { contact: row, invoice };
  }

  async function problem(invoiceId) {
    const res = await call(`/api/invoicing/invoices/${invoiceId}`);
    assert.equal(res.status, 200, res.text);
    return res.body.invoice.problems.find((item) => item.code === 'xero_contact_missing') ?? null;
  }

  test('a pending invoice offers Create, and Create clears the check', async () => {
    const made = await make('Harbour Dental');
    const missing = await problem(made.invoice.id);
    assert.equal(missing.offerCreate, true);
    assert.match(missing.message, /Create the client in Xero/);
    const before = await call(`/api/xero/contacts/match?organisationId=${org()}&contactId=${made.contact.id}`);
    assert.equal(before.body.state, 'missing');
    assert.equal(before.body.offerCreate, true);

    const replay = xero.script([
      named('Harbour Dental'),
      xeroAnswer('Contacts', { Contacts: [xeroContact('00000000-0000-4000-8000-0000000000c9', 'Harbour Dental')] }, {
        method: 'POST', query: { summarizeErrors: 'false' },
      }),
    ]);
    const created = await call('/api/xero/contacts', {
      method: 'POST', body: { organisationId: org(), contactId: made.contact.id },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.outcome, 'created');
    const post = replay.calls.find((item) => item.method === 'POST');
    assert.match(post.headers['Idempotency-Key'], /^flow-xero-contact-[0-9a-f]{40}$/);
    assert.equal(post.body.Contacts[0].Name, 'Harbour Dental');
    assert.equal(post.body.Contacts[0].ContactPersons.length, 5);
    const copy = await handle.db.execute(sql`select xero_contact_id from xero_contacts where organisation_id = ${org()} and name = 'Harbour Dental'`);
    assert.equal(copy.rows[0].xero_contact_id, '00000000-0000-4000-8000-0000000000c9');
    const link = await handle.db.execute(sql`select matched_by, state from external_links where flow_id = ${made.contact.id}`);
    assert.equal(link.rows[0].matched_by, 'created_by_flow');
    assert.equal(link.rows[0].state, 'active');

    assert.equal(await problem(made.invoice.id), null);
    const ready = await call(`/api/invoicing/invoices/${made.invoice.id}`);
    assert.equal(ready.body.invoice.view, 'ready');

    const again = xero.script([]);
    const existing = await call('/api/xero/contacts', {
      method: 'POST', body: { organisationId: org(), contactId: made.contact.id },
    });
    assert.equal(existing.status, 200, JSON.stringify(existing.body));
    assert.equal(existing.body.outcome, 'existing');
    assert.equal(again.calls.length, 0);
  });

  test('staff cannot create a Xero contact', async () => {
    const made = await make('Staff Dental');
    const res = await request(app, '/api/xero/contacts', {
      token: lab.staffToken, method: 'POST', body: { organisationId: org(), contactId: made.contact.id },
    });
    assert.equal(res.status, 403);
  });

  test('one live contact of that name is adopted and nothing is created', async () => {
    const made = await make('Adopted Dental');
    const replay = xero.script([
      xeroAnswer('Contacts', { Contacts: [xeroContact('00000000-0000-4000-8000-0000000000d1', 'Adopted Dental')] }, {
        query: { where: 'Name=="Adopted Dental"' },
      }),
    ]);
    const res = await call('/api/xero/contacts', {
      method: 'POST', body: { organisationId: org(), contactId: made.contact.id },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.outcome, 'existing');
    assert.equal(replay.calls.filter((item) => item.method === 'POST').length, 0);
    const link = await handle.db.execute(sql`select matched_by from external_links where flow_id = ${made.contact.id}`);
    assert.equal(link.rows[0].matched_by, 'exact_name');
  });

  test('an archived Xero contact is not recreated', async () => {
    const made = await make('Archived Dental');
    xero.script([
      xeroAnswer('Contacts', { Contacts: [xeroContact('00000000-0000-4000-8000-0000000000d2', 'Archived Dental', 'ARCHIVED')] }, {
        query: { where: 'Name=="Archived Dental"' },
      }),
    ]);
    const res = await call('/api/xero/contacts', {
      method: 'POST', body: { organisationId: org(), contactId: made.contact.id },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'xero_contact_archived');
  });

  test('two Xero contacts of the same name are refused', async () => {
    const made = await make('Twin Dental');
    xero.script([
      xeroAnswer('Contacts', { Contacts: [
        xeroContact('00000000-0000-4000-8000-0000000000d3', 'Twin Dental'),
        xeroContact('00000000-0000-4000-8000-0000000000d4', 'Twin Dental'),
      ] }, { query: { where: 'Name=="Twin Dental"' } }),
    ]);
    const res = await call('/api/xero/contacts', {
      method: 'POST', body: { organisationId: org(), contactId: made.contact.id },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'xero_contact_ambiguous');
  });

  test('Create is not offered when the setting is off', async () => {
    xero.runtime.settings.createContacts = false;
    try {
      const made = await make('Quiet Dental');
      const missing = await problem(made.invoice.id);
      assert.equal(missing.offerCreate, undefined);
      assert.match(missing.message, /Add it in Xero, then sync/);
      const res = await call('/api/xero/contacts', {
        method: 'POST', body: { organisationId: org(), contactId: made.contact.id },
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'xero_create_contacts_off');
    } finally {
      xero.runtime.settings.createContacts = true;
    }
  });
});
