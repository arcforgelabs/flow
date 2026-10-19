import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createOrganisation } from '../server/core/directory.js';
import { loadMappingContext, mapLine, mappingContext } from '../server/core/line-mapping.js';
import {
  acceptFindings, checkPrices, createPriceItem, findingsFor, linkPriceItem, readCatalogues, readPriceItem, readPriceList, updatePriceItem,
} from '../server/core/price-list.js';
import { priceItemLinks, reviewItems } from '../server/db/schema.js';
import { createRegistry } from '../server/integrations/port.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Flow's own price list, its links to connected systems' lists, and the price
// check. Every code, name and price here is made up.
const quiet = { info() {}, warn() {}, error() {} };

// An accounting system and a work system that each keep a price list in
// Flow's copy. Tests change `accounts` and `products` to change those copies.
let accounts = [];
let products = [];
const accountingSystem = {
  id: 'accounts', name: 'Accounts',
  capabilities: { health: async () => ({ ok: true }), listPriceItems: async () => ({ kind: 'accounting', syncedAt: null, items: accounts }) },
};
const workSystem = {
  id: 'worksystem', name: 'Work system',
  capabilities: { health: async () => ({ ok: true }), listPriceItems: async () => ({ kind: 'work', syncedAt: null, items: products }) },
};

test('a price item is checked before it is saved', () => {
  assert.deepEqual(readPriceItem({ code: ' FLD ', name: 'Full Lower Denture', unitAmountCents: 30000, taxCode: 'GST_FREE' }),
    { code: 'FLD', name: 'Full Lower Denture', description: null, unitAmountCents: 30000, taxCode: 'GST_FREE', accountCode: null });
  assert.throws(() => readPriceItem({ code: '', name: 'X', unitAmountCents: 1 }), /code is required/);
  assert.throws(() => readPriceItem({ code: 'A', name: 'X', unitAmountCents: 1.5 }), /whole cents/);
  assert.throws(() => readPriceItem({ code: 'A', name: 'X', unitAmountCents: 1, taxCode: 'VAT' }), /taxCode/);
  assert.deepEqual(readPriceItem({ unitAmountCents: 100 }, { partial: true }), { unitAmountCents: 100 });
});

test('findings name each difference, and a missing accounting item', () => {
  const item = { id: 'i1', code: 'FLD', unitAmountCents: 30000, taxCode: 'GST_FREE' };
  const catalogues = new Map([
    ['accounts', { id: 'accounts', kind: 'accounting', byId: new Map([['x1', { id: 'x1', code: 'FLD', unitAmountCents: 32000, taxCode: 'GST' }]]) }],
    ['worksystem', { id: 'worksystem', kind: 'work', byId: new Map() }],
  ]);
  const links = [{ system: 'accounts', externalId: 'x1', priceItemId: 'i1' }, { system: 'worksystem', externalId: 'gone', externalCode: '9001', priceItemId: 'i1' }];
  assert.deepEqual(findingsFor(item, links, catalogues).map((f) => f.kind), ['price', 'tax', 'missing']);
  assert.deepEqual(findingsFor(item, [], catalogues), [{ system: 'accounts', kind: 'not_linked', code: 'FLD' }]);
});

test('a linked work system code maps first, and the line price follows the setting', () => {
  const items = [{ id: 'i1', code: 'FLD', name: 'Full Lower Denture', unitAmountCents: 30000, taxCode: 'GST_FREE' }];
  const links = [{ priceItemId: 'i1', externalCode: '9001' }];
  const line = { itemCode: '9001', description: 'Something else entirely', quantity: 1, unitAmountCents: 28000, taxCode: 'GST_FREE' };
  const work = mapLine(line, mappingContext({ items, links }));
  assert.equal(work.itemCode, 'FLD');
  assert.equal(work.mappedBy, 'linked');
  assert.equal(work.unitAmountCents, 28000);
  const list = mapLine(line, mappingContext({ items, links, config: { linePrice: 'list' } }));
  assert.equal(list.unitAmountCents, 30000);
});

describe('price list against PostgreSQL', { skip: skipWithoutDatabase }, () => {
  let handle;
  let lab;
  let integrations;
  let app;
  let ownerToken;
  let staffToken;
  const catalogues = () => readCatalogues(lab.id, integrations.with('listPriceItems'));
  const call = (path, options = {}) => request(app, `/api/invoicing${path}`, { token: ownerToken, ...options });

  before(async () => {
    handle = await freshDatabase();
    lab = await createOrganisation(handle.db, { name: 'Example Lab' });
    integrations = createRegistry({ log: quiet, env: {} });
    integrations.register(accountingSystem);
    integrations.register(workSystem);
    integrations.enable('accounts');
    integrations.enable('worksystem');
    await integrations.start(handle.db);
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

  test('the price list works with no system connected', async () => {
    const item = await createPriceItem(handle.db, lab.id, { code: 'SPT', name: 'Special Tray', unitAmountCents: 5500, taxCode: 'GST_FREE' });
    await assert.rejects(createPriceItem(handle.db, lab.id, { code: 'SPT', name: 'Again', unitAmountCents: 1 }), /already on the price list/);
    const changed = await updatePriceItem(handle.db, lab.id, item.id, { unitAmountCents: 6000 });
    assert.equal(changed.unitAmountCents, 6000);
    const list = await readPriceList(handle.db, lab.id, { catalogues: new Map() });
    assert.deepEqual(list.items.map((i) => [i.code, i.findings.length]), [['SPT', 0]]);
    assert.deepEqual(list.systems, []);
  });

  test('the check links by code, raises one alert per item, and closes it when prices agree', async () => {
    const fld = await createPriceItem(handle.db, lab.id, { code: 'FLD', name: 'Full Lower Denture', unitAmountCents: 30000, taxCode: 'GST_FREE' });
    accounts = [
      { id: 'x-fld', code: 'FLD', name: 'Full Lower Denture', unitAmountCents: 32000, taxCode: 'GST_FREE', sold: true },
      { id: 'x-spt', code: 'SPT', name: 'Special Tray', unitAmountCents: 6000, taxCode: 'GST_FREE', sold: true },
      { id: 'x-new', code: 'NEW', name: 'Only in accounts', unitAmountCents: 100, taxCode: 'GST', sold: true },
    ];
    products = [{ id: 'p-1', code: '9001', name: 'Full Lower', unitAmountCents: 30000, taxCode: 'GST_FREE', sold: true }];
    const first = await checkPrices(handle.db, lab.id, { catalogues: await catalogues() });
    assert.equal(first.linked, 2);
    assert.equal(first.opened, 1);
    const again = await checkPrices(handle.db, lab.id, { catalogues: await catalogues() });
    assert.equal(again.opened, 0);
    const open = await handle.db.select().from(reviewItems).where(eq(reviewItems.flowId, fld.id));
    assert.equal(open.length, 1);
    assert.equal(open[0].seenCount, 2);
    assert.equal(open[0].moneyAtRiskCents, 2000);

    const list = await readPriceList(handle.db, lab.id, { catalogues: await catalogues() });
    assert.deepEqual(list.unlinked.find((u) => u.system === 'accounts').records.map((r) => r.code), ['NEW']);
    assert.deepEqual(list.unlinked.find((u) => u.system === 'worksystem').records.map((r) => r.code), ['9001']);

    accounts[0].unitAmountCents = 30000;
    const agreed = await checkPrices(handle.db, lab.id, { catalogues: await catalogues() });
    assert.equal(agreed.closed, 1);
  });

  test('Mark resolved accepts a finding; the same finding stays closed, a new one opens', async () => {
    const [{ id }] = (await readPriceList(handle.db, lab.id, { catalogues: await catalogues() })).items.filter((i) => i.code === 'FLD');
    accounts[0].unitAmountCents = 31000;
    await checkPrices(handle.db, lab.id, { catalogues: await catalogues() });
    assert.deepEqual(await acceptFindings(handle.db, lab.id, id, { catalogues: await catalogues(), actor: 'person:test' }), { state: 'accepted' });
    const same = await checkPrices(handle.db, lab.id, { catalogues: await catalogues() });
    assert.equal(same.opened, 0);
    assert.equal(same.accepted, 1);
    accounts[0].unitAmountCents = 31500;
    const changed = await checkPrices(handle.db, lab.id, { catalogues: await catalogues() });
    assert.equal(changed.opened, 1);
  });

  test('a person links work system products; the pipeline maps their lines by code', async () => {
    const [fld] = (await readPriceList(handle.db, lab.id, { catalogues: await catalogues() })).items.filter((i) => i.code === 'FLD');
    await linkPriceItem(handle.db, lab.id, fld.id, { system: 'worksystem', externalId: 'p-1' }, { catalogues: await catalogues() });
    await assert.rejects(linkPriceItem(handle.db, lab.id, fld.id, { system: 'worksystem', externalId: 'nope' }, { catalogues: await catalogues() }), /not found/i);
    const context = await loadMappingContext(handle.db, lab.id, {}, { system: 'worksystem' });
    const mapped = mapLine({ itemCode: '9001', description: 'Full Lower', quantity: 1, unitAmountCents: 30000 }, context);
    assert.equal(mapped.itemCode, 'FLD');
    assert.equal(mapped.mappedBy, 'linked');
    const links = await handle.db.select().from(priceItemLinks).where(eq(priceItemLinks.priceItemId, fld.id));
    assert.deepEqual(links.map((l) => [l.system, l.matchedBy]).sort(), [['accounts', 'code'], ['worksystem', 'person']]);
  });

  test('an accounting item links to one price item only', async () => {
    const [fld, spt] = ['FLD', 'SPT'].map((code) => code);
    const list = await readPriceList(handle.db, lab.id, { catalogues: await catalogues() });
    const fldId = list.items.find((i) => i.code === fld).id;
    const sptId = list.items.find((i) => i.code === spt).id;
    await linkPriceItem(handle.db, lab.id, fldId, { system: 'accounts', externalId: 'x-new' }, { catalogues: await catalogues() });
    const accountLinks = await handle.db.select().from(priceItemLinks).where(eq(priceItemLinks.system, 'accounts'));
    assert.deepEqual(accountLinks.map((l) => [l.priceItemId === fldId ? 'FLD' : l.priceItemId === sptId ? 'SPT' : '?', l.externalId]).sort(),
      [['FLD', 'x-new'], ['SPT', 'x-spt']]);
  });

  test('the API: anyone reads the list, an owner or admin changes it', async () => {
    const read = await call('/price-list');
    assert.equal(read.status, 200);
    assert.ok(read.body.items.length >= 2);
    assert.deepEqual(read.body.systems.map((s) => [s.id, s.kind]), [['accounts', 'accounting'], ['worksystem', 'work']]);
    const refused = await call('/price-items', { method: 'POST', token: staffToken, body: { code: 'BB', name: 'Bite Block', unitAmountCents: 4500 } });
    assert.equal(refused.status, 403);
    const made = await call('/price-items', { method: 'POST', body: { code: 'BB', name: 'Bite Block', unitAmountCents: 4500 } });
    assert.equal(made.status, 201);
    const changed = await call(`/price-items/${made.body.item.id}`, { method: 'PUT', body: { unitAmountCents: 4600, accountCode: '200' } });
    assert.equal(changed.body.item.unitAmountCents, 4600);
    assert.equal(changed.body.item.accountCode, '200');
    const archived = await call(`/price-items/${made.body.item.id}/archive`, { method: 'POST', body: { archived: true } });
    assert.ok(archived.body.item.archivedAt);
    const check = await call('/price-list/check', { method: 'POST', body: {} });
    assert.equal(check.status, 200);
    assert.equal(typeof check.body.summary.checked, 'number');
    const bad = await call('/price-items', { method: 'POST', body: { code: 'X', name: 'X', unitAmountCents: -1 } });
    assert.equal(bad.status, 400);
  });
});
