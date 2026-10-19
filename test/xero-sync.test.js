import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { invitePerson } from '../server/auth/people.js';
import { lastSuccessfulSyncAt, matchContact, mapItem, parseXeroDate } from '../server/integrations/xero/catalogue.js';
import { listPriceItems } from '../server/integrations/xero/lookup.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, seedLab, xeroAnswer, xeroRuntime } from './support/xero.js';

// Copying Xero contacts and items into Flow. Xero is replayed with synthetic
// answers; Clerk is faked.

const contact = (id, name, extra = {}) => ({ ContactID: id, Name: name, ContactStatus: 'ACTIVE', IsCustomer: true, ...extra });
const item = (id, code, price) => ({ ItemID: id, Code: code, Name: code.toLowerCase(), IsSold: true, SalesDetails: { UnitPrice: price, AccountCode: '200', TaxType: 'OUTPUT' } });

test('Xero dates and prices map to Flow types', () => {
  assert.equal(parseXeroDate('/Date(1792000000000+0000)/').toISOString(), new Date(1792000000000).toISOString());
  assert.equal(parseXeroDate('2026-10-18T00:00:00Z').toISOString(), '2026-10-18T00:00:00.000Z');
  assert.equal(parseXeroDate(null), null);
  assert.equal(mapItem(item('i', 'CROWN', 250.255)).salesUnitAmountCents, 25026);
  assert.equal(mapItem({ ItemID: 'i', Code: ' X ' }).salesUnitAmountCents, null);
  assert.equal(mapItem({ ItemID: 'i', Code: ' X ' }).code, 'X');
});

describe('Xero contact and item sync', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let lab;
  let replay;
  let adminToken;

  before(async () => {
    handle = await freshDatabase();
    replay = xeroRuntime([
      xeroAnswer('Contacts', { Contacts: [contact('c1', 'Example Practice', { SalesTrackingCategories: [{ TrackingCategoryName: 'Department', TrackingOptionName: 'Laboratory' }] }), contact('c2', 'Another  Practice'), contact('c3', 'Example Supplier', { IsCustomer: false, IsSupplier: true })] }, { query: { page: 1 } }),
      xeroAnswer('Items', { Items: [item('i1', 'CROWN', 250), item('i2', 'REPAIR', 80), { ItemID: 'i3', Name: 'no code' }] }),
      xeroAnswer('Contacts', { Contacts: [contact('c1', 'Example Practice'), contact('c4', 'example practice')] }, { query: { page: 1 } }),
      xeroAnswer('Items', { Items: [item('i1', 'CROWN', 260)] }),
      xeroAnswer('Contacts', { Message: 'down' }, { query: { page: 1 }, status: 500 }),
    ]);
    const booted = await bootFlow(handle, { runtime: replay.runtime, log: replay.log });
    app = booted.app;
    lab = await seedLab(handle, booted.clerk);
    await invitePerson(handle.db, { email: 'admin@example.test', role: 'admin', invitedBy: lab.owner.id });
    adminToken = booted.clerk.signIn(booted.clerk.addUser({ email: 'admin@example.test' }));
  });
  after(async () => handle?.close());

  const sync = (token) => request(app, '/api/xero/sync', { token, method: 'POST', body: { organisationId: lab.organisation.id } });

  test('before Xero is connected, a sync says so', async () => {
    const res = await sync(lab.ownerToken);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'xero_not_connected');
  });

  test('staff cannot sync; an admin can, and Flow keeps a copy of contacts and coded items', async () => {
    await connectDirectly(handle, replay.runtime, lab.organisation.id);
    assert.equal((await sync(lab.staffToken)).status, 403);

    const res = await sync(adminToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sync.status, 'succeeded');
    assert.equal(res.body.sync.contactCount, 3);
    assert.equal(res.body.sync.itemCount, 2, 'an item with no code is left out');

    const contacts = await request(app, `/api/xero/contacts?organisationId=${lab.organisation.id}&q=practice`, { token: lab.staffToken });
    assert.deepEqual(contacts.body.contacts.map((c) => c.name), ['Another  Practice', 'Example Practice']);
    assert.deepEqual(contacts.body.contacts[1].salesTracking, [{ category: 'Department', option: 'Laboratory' }]);
    const items = await request(app, `/api/xero/items?organisationId=${lab.organisation.id}`, { token: lab.staffToken });
    assert.deepEqual(items.body.items.map((i) => [i.code, i.salesUnitAmountCents, i.salesTaxType]), [['CROWN', 25000, 'OUTPUT'], ['REPAIR', 8000, 'OUTPUT']]);
    // The price list reads the same copy (lookup.js, listPriceItems).
    const list = await listPriceItems(handle.db, lab.organisation.id, { taxTypes: { GST: 'OUTPUT', GST_FREE: 'EXEMPTOUTPUT' } });
    assert.equal(list.kind, 'accounting');
    assert.deepEqual(list.items.map((i) => [i.code, i.unitAmountCents, i.taxCode]), [['CROWN', 25000, 'GST'], ['REPAIR', 8000, 'GST']]);
  });

  test('contacts match by exact name, ignoring case and doubled spaces', async () => {
    assert.equal((await matchContact(handle.db, lab.organisation.id, 'another practice')).contact.xeroContactId, 'c2');
    assert.equal((await matchContact(handle.db, lab.organisation.id, 'Example Practice')).state, 'matched');
    assert.equal((await matchContact(handle.db, lab.organisation.id, 'Example Practise')).state, 'missing');
  });

  test('a later sync replaces the copy: gone records go, changed ones change', async () => {
    const res = await sync(lab.ownerToken);
    assert.equal(res.status, 200);
    const { rows: contacts } = await handle.db.execute(sql`select xero_contact_id from xero_contacts order by xero_contact_id`);
    assert.deepEqual(contacts.map((r) => r.xero_contact_id), ['c1', 'c4']);
    const { rows: items } = await handle.db.execute(sql`select code, sales_unit_amount_cents from xero_items`);
    assert.deepEqual(items, [{ code: 'CROWN', sales_unit_amount_cents: 26000 }]);
    const match = await matchContact(handle.db, lab.organisation.id, 'Example Practice');
    assert.equal(match.state, 'ambiguous', 'two Xero contacts with one name are for a person to fix');
  });

  test('a failed sync keeps the copy and records why', async () => {
    const before = await lastSuccessfulSyncAt(handle.db, lab.organisation.id);
    const res = await sync(lab.ownerToken);
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'xero_api_error');
    assert.equal((await handle.db.execute(sql`select count(*)::int as n from xero_contacts`)).rows[0].n, 2);
    const status = await request(app, `/api/xero/status?organisationId=${lab.organisation.id}`, { token: lab.staffToken });
    assert.equal(status.body.lastSync.status, 'failed');
    assert.equal(status.body.lastSync.error.code, 'xero_api_error');
    assert.deepEqual(await lastSuccessfulSyncAt(handle.db, lab.organisation.id), before);
    assert.ok(status.body.rateLimit.laneCounts.sync >= 5, 'sync calls count against the sync lane');
  });

  test('two syncs for one organisation run one after the other', async () => {
    const order = [];
    const slow = (name, ms) => () => new Promise((resolve) => setTimeout(() => { order.push(name); resolve(name); }, ms));
    await Promise.all([replay.runtime.serial('org', slow('first', 30)), replay.runtime.serial('org', slow('second', 1))]);
    assert.deepEqual(order, ['first', 'second']);
  });
});
