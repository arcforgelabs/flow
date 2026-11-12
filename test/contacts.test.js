import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { sql } from 'drizzle-orm';
import { readContact } from '../server/core/contacts.js';
import { linkRecord } from '../server/core/links.js';
import { linkCustomers } from '../server/core/pipeline.js';
import { rewriteConditions } from '../server/core/merge-contacts.js';
import { createOrganisation } from '../server/core/directory.js';
import { createRegistry } from '../server/integrations/port.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

const quiet = { info() {}, warn() {}, error() {} };

test('a merge changes the merged contact in rule values only where a test names an id', () => {
  const rules = [
    { field: 'customer', test: 'is', value: 'from' },
    { field: 'customer', test: 'is_one_of', value: ['from', 'keep', 'other'] },
    { field: 'customer', test: 'contains', value: 'from' },
    { field: 'job_total', test: 'at_most', value: 0 },
  ];
  assert.deepEqual(rewriteConditions(rules, 'from', 'keep'), [
    { field: 'customer', test: 'is', value: 'keep' },
    { field: 'customer', test: 'is_one_of', value: ['keep', 'other'] },
    { field: 'customer', test: 'contains', value: 'from' },
    { field: 'job_total', test: 'at_most', value: 0 },
  ]);
  assert.equal(rewriteConditions([{ field: 'customer', test: 'is', value: 'other' }], 'from', 'keep'), null);
});

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

  test('a hidden contact is out of every list but its own, and a person shows it again', async () => {
    const made = await call('/contacts', { method: 'POST', body: { kind: 'customer', name: 'Office Rent' } });
    assert.equal(made.body.contact.hidden, false);
    const id = made.body.contact.id;
    assert.equal((await call(`/contacts/${id}`, { method: 'PATCH', body: { hidden: 'yes' } })).status, 400);
    const hid = await call(`/contacts/${id}`, { method: 'PATCH', body: { hidden: true } });
    assert.equal(hid.body.contact.hidden, true);
    assert.deepEqual((await call('/contacts')).body.contacts.map((c) => c.name), []);
    assert.deepEqual((await call('/contacts?hidden=true')).body.contacts.map((c) => c.name), ['Office Rent']);
    assert.ok((await call('/contacts?kind=all&active=all&hidden=all')).body.contacts.some((c) => c.name === 'Office Rent'));
    assert.equal((await call('/contacts?hidden=maybe')).status, 400);
    // Saving the record's other fields leaves it hidden.
    assert.equal((await call(`/contacts/${id}`, { method: 'PATCH', body: { email: 'rent@example.test' } })).body.contact.hidden, true);
    const back = await call(`/contacts/${id}`, { method: 'PATCH', body: { hidden: false } });
    assert.equal(back.body.contact.hidden, false);
    assert.deepEqual((await call('/contacts')).body.contacts.map((c) => c.name), ['Office Rent']);
  });

  test('a person merges two contacts: jobs, invoices, links, rules and Bill to move, and the merged one stays out of the lists', async () => {
    const make = async (name) => (await call('/contacts', { method: 'POST', body: { kind: 'customer', name } })).body.contact;
    const keep = await make('Example Clinic');
    const from = await make('Example Clinic Pty Ltd Trading');
    const client = await make('Example Branch');
    const payer = await make('Example Group');
    const [{ id: organisationId }] = (await handle.db.execute(sql`select id from organisations`)).rows;
    const { rows: [job] } = await handle.db.execute(sql`insert into billing_obligations (organisation_id, source_system, source_job_ref, contact_id,
        lines, line_fingerprint, subtotal_cents, tax_cents, total_cents, mapping_complete, source_seen_at, accounting_checked_at)
      values (${organisationId}, 'work', 'merge-1', ${from.id}, '[]'::jsonb, 'f', 100, 10, 110, true, now(), now()) returning id`);
    const { rows: [invoice] } = await handle.db.execute(sql`insert into invoices (organisation_id, contact_id) values (${organisationId}, ${from.id}) returning id`);
    await linkRecord(handle.db, organisationId, { entity: 'contact', flowId: keep.id, system: 'work', externalId: 'w1', matchedBy: 'imported' });
    await linkRecord(handle.db, organisationId, { entity: 'contact', flowId: from.id, system: 'xero', externalId: 'x1', matchedBy: 'imported' });
    const rule = await call('/rules', { method: 'POST', body: { name: 'Merged client', conditions: [{ field: 'customer', test: 'is', value: from.id }], action: { kind: 'wait' } } });
    assert.equal(rule.status, 201, JSON.stringify(rule.body));
    assert.equal((await call(`/contacts/${client.id}/billing`, { method: 'PUT', body: { billToContactId: from.id } })).status, 200);
    assert.equal((await call(`/contacts/${from.id}/billing`, { method: 'PUT', body: { billToContactId: payer.id } })).status, 400, 'a payer bills to itself');

    assert.equal((await request(app, `/api/invoicing/contacts/${keep.id}/merge`, { token: staffToken, method: 'POST', body: { fromId: from.id } })).status, 403);
    assert.equal((await call(`/contacts/${keep.id}/merge`, { method: 'POST', body: { fromId: keep.id } })).status, 400);
    assert.equal((await call(`/contacts/${keep.id}/merge`, { method: 'POST', body: { fromId: 'nope' } })).status, 400);
    const merged = await call(`/contacts/${keep.id}/merge`, { method: 'POST', body: { fromId: from.id } });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.deepEqual(merged.body.moved, { jobs: 1, invoices: 1, links: 1, rules: 1, billTo: 1 });
    assert.deepEqual(merged.body.contact.aliases, ['Example Clinic Pty Ltd Trading']);

    const { rows: [moved] } = await handle.db.execute(sql`select contact_id, accounting_checked_at from billing_obligations where id = ${job.id}`);
    assert.equal(moved.contact_id, keep.id);
    assert.equal(moved.accounting_checked_at, null, 'the unbilled job goes back to the matcher');
    const { rows: [event] } = await handle.db.execute(sql`select actor, evidence from obligation_events where obligation_id = ${job.id} and kind = 'contact_merged'`);
    assert.deepEqual(event.evidence, { from: from.id, to: keep.id });
    assert.match(event.actor, /^person:/);
    assert.equal((await handle.db.execute(sql`select contact_id from invoices where id = ${invoice.id}`)).rows[0].contact_id, keep.id);
    const { rows: links } = await handle.db.execute(sql`select system, flow_id from external_links where entity = 'contact' and state = 'active' and system in ('work', 'xero') order by system`);
    assert.deepEqual(links.map((l) => [l.system, l.flow_id]), [['work', keep.id], ['xero', keep.id]]);
    const { rows: [savedRule] } = await handle.db.execute(sql`select conditions from invoice_rules where id = ${rule.body.rule.id}`);
    assert.equal(savedRule.conditions[0].value, keep.id);
    assert.equal((await call(`/contacts/${client.id}/billing`)).body.billing.billToContactId, keep.id);

    // The merged contact stays, out of every list; search finds the kept one by the old name.
    const gone = await call(`/contacts/${from.id}`);
    assert.equal(gone.body.contact.mergedIntoId, keep.id);
    assert.equal(gone.body.contact.active, false);
    assert.ok(!(await call('/contacts?kind=all&active=all&hidden=all')).body.contacts.some((c) => c.id === from.id));
    assert.deepEqual((await call('/contacts?q=trading')).body.contacts.map((c) => c.id), [keep.id]);
    assert.equal((await call(`/contacts/${from.id}`, { method: 'PATCH', body: { email: 'x@example.test' } })).status, 400);
    assert.equal((await call(`/contacts/${keep.id}/merge`, { method: 'POST', body: { fromId: from.id } })).status, 409, 'only once');
    const again = await call('/contacts', { method: 'POST', body: { kind: 'customer', name: 'Example Clinic Pty Ltd Trading' } });
    assert.equal(again.status, 409);
    assert.equal(again.body.details.contactId, keep.id, 'a new contact with the merged name points at the kept one');
    // Another system's client with the merged name links to the kept contact.
    const named = await linkCustomers(handle.db, organisationId, { system: 'other', customers: [{ id: 'o1', name: 'Example Clinic Pty Ltd Trading' }] });
    assert.equal(named.linked, 1);
    const { rows: [byAlias] } = await handle.db.execute(sql`select flow_id from external_links where system = 'other' and external_id = 'o1' and state = 'active'`);
    assert.equal(byAlias.flow_id, keep.id);
  });

  test('a merge keeps Bill to one level whichever contact has its own settings, and moves review items', async () => {
    const make = async (name) => (await call('/contacts', { method: 'POST', body: { kind: 'customer', name } })).body.contact;
    const billing = (id, body) => call(`/contacts/${id}/billing`, { method: 'PUT', body });
    const [{ id: organisationId }] = (await handle.db.execute(sql`select id from organisations`)).rows;
    const payer = await make('Bill Group');
    const other = await make('Bill Other Group');

    // Both have a row; the merged one bills to a payer: the kept one takes the payer.
    const a = await make('Bill Clinic A');
    const b = await make('Bill Clinic B');
    assert.equal((await billing(a.id, { billable: true })).status, 200);
    assert.equal((await billing(b.id, { billToContactId: payer.id })).status, 200);
    const { rows: [job] } = await handle.db.execute(sql`insert into billing_obligations (organisation_id, source_system, source_job_ref, contact_id,
        lines, line_fingerprint, subtotal_cents, tax_cents, total_cents, mapping_complete, source_seen_at, accounting_checked_at)
      values (${organisationId}, 'work', 'merge-keep-1', ${a.id}, '[]'::jsonb, 'f', 100, 10, 110, true, now(), now()) returning id`);
    const proposed = await linkRecord(handle.db, organisationId, { entity: 'contact', flowId: b.id, system: 'xero', externalId: 'x-bill-b', matchedBy: 'name' });
    assert.equal(proposed.outcome, 'proposed');
    assert.equal((await call(`/contacts/${a.id}/merge`, { method: 'POST', body: { fromId: b.id } })).status, 200);
    assert.equal((await call(`/contacts/${a.id}/billing`)).body.billing.billToContactId, payer.id);
    const { rows: [left] } = await handle.db.execute(sql`select bill_to_contact_id from customer_billing_settings where contact_id = ${b.id}`);
    assert.equal(left.bill_to_contact_id, null, 'the merged row names no payer');
    const { rows: [requeued] } = await handle.db.execute(sql`select accounting_checked_at from billing_obligations where id = ${job.id}`);
    assert.equal(requeued.accounting_checked_at, null, "the kept contact's own job goes back to the matcher");
    const { rows: items } = await handle.db.execute(sql`select flow_id from review_items where kind = 'link.proposed' and state = 'open' and evidence->>'linkId' = ${proposed.link.id}`);
    assert.deepEqual(items.map((i) => i.flow_id), [a.id], 'the review item moved with its link');
    // The kept contact can take the merged name; the merged row freed it.
    assert.equal((await call(`/contacts/${a.id}`, { method: 'PATCH', body: { name: 'Bill Clinic B' } })).status, 200);

    // The kept one pays for the merged one, both with rows: no payer is left on either.
    const c = await make('Bill Clinic C');
    const d = await make('Bill Clinic D');
    assert.equal((await billing(c.id, { billable: true })).status, 200);
    assert.equal((await billing(d.id, { billToContactId: c.id })).status, 200);
    assert.equal((await call(`/contacts/${c.id}/merge`, { method: 'POST', body: { fromId: d.id } })).status, 200);
    assert.equal((await call(`/contacts/${c.id}/billing`)).body.billing.billToContactId, null);
    assert.equal((await billing(c.id, { billToContactId: other.id })).status, 200, 'the kept one is free to name a payer');

    // Different payers, and a payer with clients, are refused.
    const e = await make('Bill Clinic E');
    const f = await make('Bill Clinic F');
    assert.equal((await billing(e.id, { billToContactId: payer.id })).status, 200);
    assert.equal((await billing(f.id, { billToContactId: other.id })).status, 200);
    assert.equal((await call(`/contacts/${e.id}/merge`, { method: 'POST', body: { fromId: f.id } })).status, 409);
    const g = await make('Bill Clinic G');
    assert.equal((await billing(g.id, { billToContactId: other.id })).status, 200);
    assert.equal((await call(`/contacts/${g.id}/merge`, { method: 'POST', body: { fromId: payer.id } })).status, 409, 'a payer with clients cannot move into a contact that bills to a payer');
  });

  test('a merged contact is out of the rule menu and cannot be named in a rule, and merges chain', async () => {
    const make = async (name) => (await call('/contacts', { method: 'POST', body: { kind: 'customer', name } })).body.contact;
    const x = await make('Chain X');
    const y = await make('Chain Y');
    const z = await make('Chain Z');
    assert.equal((await call(`/contacts/${y.id}/merge`, { method: 'POST', body: { fromId: x.id } })).status, 200);
    assert.equal((await call(`/contacts/${z.id}/merge`, { method: 'POST', body: { fromId: y.id } })).status, 200);
    assert.equal((await call(`/contacts/${x.id}`)).body.contact.mergedIntoId, z.id, 'an earlier merge points at the last kept contact');
    assert.deepEqual((await call(`/contacts/${z.id}`)).body.contact.aliases.sort(), ['Chain X', 'Chain Y']);
    const fields = await call('/rule-fields');
    assert.ok(!JSON.stringify(fields.body).includes(x.id));
    const rule = await call('/rules', { method: 'POST', body: { name: 'Old client', conditions: [{ field: 'customer', test: 'is', value: y.id }], action: { kind: 'wait' } } });
    assert.equal(rule.status, 400);
    const named = await call('/contacts', { method: 'POST', body: { kind: 'customer', name: 'Chain X' } });
    assert.equal(named.status, 409);
    assert.equal(named.body.details.contactId, z.id);
  });

  test('a merge is refused when both contacts are linked in one system', async () => {
    const make = async (name) => (await call('/contacts', { method: 'POST', body: { kind: 'customer', name } })).body.contact;
    const a = await make('Linked One');
    const b = await make('Linked Two');
    const [{ id: organisationId }] = (await handle.db.execute(sql`select id from organisations`)).rows;
    await linkRecord(handle.db, organisationId, { entity: 'contact', flowId: a.id, system: 'xero', externalId: 'x-a', matchedBy: 'imported' });
    await linkRecord(handle.db, organisationId, { entity: 'contact', flowId: b.id, system: 'xero', externalId: 'x-b', matchedBy: 'imported' });
    const refused = await call(`/contacts/${a.id}/merge`, { method: 'POST', body: { fromId: b.id } });
    assert.equal(refused.status, 409);
    assert.equal((await call(`/contacts/${b.id}`)).body.contact.mergedIntoId, null, 'nothing changed');
  });
});
