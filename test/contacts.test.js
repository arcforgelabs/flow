import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { readContact } from '../server/core/contacts.js';
import { createOrganisation } from '../server/core/directory.js';
import { createRegistry } from '../server/integrations/port.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

const quiet = { info() {}, warn() {}, error() {} };

test('a contact is checked before it is saved', () => {
  assert.deepEqual(readContact({
    kind: 'customer', name: ' Harbour Dental ', email: 'accounts@harbour.example',
    practitioners: ['Ada Lovelace', { name: 'Grace Hopper', email: 'grace@harbour.example' }],
    address: { line1: '1 Wharf', city: 'Sydney', extra: 'no' },
  }), {
    kind: 'customer',
    name: 'Harbour Dental',
    firstName: null,
    lastName: null,
    email: 'accounts@harbour.example',
    phone: null,
    mobile: null,
    accountNumber: null,
    taxNumber: null,
    taxRate: null,
    address: { line1: '1 Wharf', city: 'Sydney' },
    practitioners: [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper', email: 'grace@harbour.example' }],
    active: true,
  });
  assert.throws(() => readContact({ kind: 'patient', name: 'A' }), /kind must be/);
  assert.throws(() => readContact({ kind: 'customer', name: '  ' }), /name is required/);
  assert.throws(() => readContact({ kind: 'customer', name: 'A', active: 'yes' }), /active must be/);
  assert.deepEqual(readContact({ email: 'a@b.test' }, { partial: true }), { email: 'a@b.test' });
});

describe('contacts against PostgreSQL', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let ownerToken;
  let staffToken;
  const call = (path, options = {}) => request(app, `/api/invoicing${path}`, { token: ownerToken, ...options });

  before(async () => {
    handle = await freshDatabase();
    await createOrganisation(handle.db, { name: 'Example Lab' });
    const integrations = createRegistry({ log: quiet, env: {} });
    const clerk = fakeClerk();
    const owner = await seedFirstOwner(handle.db, 'owner@example.test');
    await invitePerson(handle.db, { email: 'staff@example.test', role: 'staff', invitedBy: owner.id });
    ownerToken = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    staffToken = clerk.signIn(clerk.addUser({ email: 'staff@example.test' }));
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    app = createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations, log: quiet });
  });

  after(async () => handle?.close());

  test('an owner creates a contact, a duplicate is refused, and staff cannot write', async () => {
    const staff = await request(app, '/api/invoicing/contacts', {
      token: staffToken, method: 'POST', body: { kind: 'customer', name: 'Staff Practice' },
    });
    assert.equal(staff.status, 403);
    const created = await call('/contacts', {
      method: 'POST',
      body: {
        kind: 'customer', name: 'Harbour Dental', email: 'accounts@harbour.example',
        phone: '0290000000', taxNumber: '53004085616', taxRate: 'GST',
        address: { line1: '1 Wharf', city: 'Sydney', postalCode: '2000', country: 'Australia' },
        practitioners: [{ name: 'Ada Lovelace' }],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.contact.active, true);
    assert.equal(created.body.contact.address.city, 'Sydney');
    const again = await call('/contacts', { method: 'POST', body: { kind: 'customer', name: 'Harbour Dental' } });
    assert.equal(again.status, 409);
    const bad = await call('/contacts', { method: 'POST', body: { kind: 'customer', name: '' } });
    assert.equal(bad.status, 400);
    const supplier = await call('/contacts', { method: 'POST', body: { kind: 'supplier', name: 'Harbour Dental' } });
    assert.equal(supplier.status, 201);
    const inactive = await call(`/contacts/${created.body.contact.id}`, { method: 'PATCH', body: { active: false } });
    assert.equal(inactive.status, 200);
    assert.equal(inactive.body.contact.active, false);
  });

  test('the invoice client list stays customers who are active', async () => {
    const customers = await call('/contacts');
    assert.equal(customers.status, 200);
    assert.deepEqual(customers.body.contacts.map((c) => c.name), []);
    const all = await call('/contacts?kind=all&active=all');
    assert.deepEqual(all.body.contacts.map((c) => c.kind).sort(), ['customer', 'supplier']);
    const found = await call('/contacts?kind=all&active=all&q=harbour');
    assert.equal(found.body.contacts.length, 2);
  });
});
