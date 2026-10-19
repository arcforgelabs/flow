import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { invitePerson } from '../server/auth/people.js';
import { mapInvoice, mapPayment, mirrorResource, nextPosition, toCents } from '../server/integrations/xero/mirror.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, scriptedXero, seedLab, xeroAnswer } from './support/xero.js';

// Flow's copy of Xero invoices, credit notes and payments. Xero is replayed
// with synthetic answers; Clerk is faked.

const at = (iso) => `/Date(${Date.parse(iso)}+0000)/`;
const invoice = (id, updated, extra = {}) => ({
  InvoiceID: id,
  Type: 'ACCREC',
  InvoiceNumber: `INV-${id}`,
  Reference: 'Example Dentist - Example Patient',
  Contact: { ContactID: 'c1' },
  Status: 'AUTHORISED',
  Date: at('2024-03-01T00:00:00Z'),
  DueDate: at('2024-03-31T00:00:00Z'),
  CurrencyCode: 'AUD',
  SubTotal: 200,
  TotalTax: 20,
  Total: 220,
  AmountDue: 220,
  AmountPaid: 0,
  AmountCredited: 0,
  LineItems: [{ LineItemID: `l-${id}`, ItemCode: 'CROWN', Description: 'Crown for Example Patient', Quantity: 1, UnitAmount: 200, LineAmount: 200, TaxAmount: 20, TaxType: 'OUTPUT', AccountCode: '200' }],
  UpdatedDateUTC: at(updated),
  ...extra,
});
const page = (resource, path, list, query = {}) => xeroAnswer(path, { [path]: list }, { query: { pageSize: 2, order: 'UpdatedDateUTC ASC', ...query } });

test('Xero amounts become whole cents without float drift', () => {
  assert.equal(toCents(2.675), 268);
  assert.equal(toCents(-2.675), -268);
  assert.equal(toCents(220), 22000);
  assert.equal(toCents('0.5'), 50);
  assert.equal(toCents(12.3449), 1234);
  assert.equal(toCents(null), null);
});

test('free text that can name a patient is kept only when the lab turns it on', () => {
  const plain = mapInvoice(invoice('a', '2024-03-01T00:00:00Z'));
  assert.equal(plain.reference, null);
  assert.equal(plain.lines[0].description, null);
  assert.equal(plain.lines[0].itemCode, 'CROWN');
  assert.equal(plain.totalCents, 22000);
  assert.equal(plain.issuedOn, '2024-03-01');
  const kept = mapInvoice(invoice('a', '2024-03-01T00:00:00Z'), { keepReference: true });
  assert.equal(kept.reference, 'Example Dentist - Example Patient');
  assert.equal(mapPayment({ PaymentID: 'p', Reference: 'Example Patient', Amount: 1 }).reference, null);
});

test('the cursor pages by change time and never goes back', () => {
  const t = (iso) => ({ xeroUpdatedAt: new Date(iso) });
  const start = { modifiedSince: null, page: 1 };
  assert.deepEqual(nextPosition(start, [t('2024-01-01T00:00:01Z'), t('2024-01-01T00:00:09.500Z')], 2),
    { modifiedSince: new Date('2024-01-01T00:00:08Z'), page: 1, done: false });
  const crowded = { modifiedSince: new Date('2024-01-01T00:00:08Z'), page: 1 };
  assert.deepEqual(nextPosition(crowded, [t('2024-01-01T00:00:09Z'), t('2024-01-01T00:00:09Z')], 2),
    { modifiedSince: new Date('2024-01-01T00:00:08Z'), page: 2, done: false }, 'one second with a full page moves the page');
  assert.deepEqual(nextPosition(crowded, [], 2), { modifiedSince: new Date('2024-01-01T00:00:08Z'), page: 1, done: true });
  assert.deepEqual(nextPosition(crowded, [t('2023-12-31T00:00:00Z')], 2).modifiedSince, new Date('2024-01-01T00:00:08Z'));
});

describe('Xero mirror', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let lab;
  let xero;
  let adminToken;

  before(async () => {
    handle = await freshDatabase();
    xero = scriptedXero({ XERO_MIRROR_PAGE_SIZE: '2' });
    const booted = await bootFlow(handle, { runtime: xero.runtime, log: xero.log });
    app = booted.app;
    lab = await seedLab(handle, booted.clerk);
    await invitePerson(handle.db, { email: 'admin@example.test', role: 'admin', invitedBy: lab.owner.id });
    adminToken = booted.clerk.signIn(booted.clerk.addUser({ email: 'admin@example.test' }));
    await connectDirectly(handle, xero.runtime, lab.organisation.id);
  });
  after(async () => handle?.close());

  const mirror = (token, body = {}) => request(app, '/api/xero/mirror', { token, method: 'POST', body: { organisationId: lab.organisation.id, ...body } });
  const count = async (table) => (await handle.db.execute(sql.raw(`select count(*)::int as n from ${table}`))).rows[0].n;

  test('staff cannot start a copy', async () => {
    assert.equal((await mirror(lab.staffToken)).status, 403);
  });

  test('the first copy reads the whole history, page by page, and re-reads a boundary record without a change', async () => {
    const replay = xero.script([
      page('invoices', 'Invoices', [invoice('i1', '2024-01-01T00:00:01Z'), invoice('i2', '2024-01-02T00:00:00Z')], { page: 1 }),
      page('invoices', 'Invoices', [invoice('i2', '2024-01-02T00:00:00Z'), invoice('i3', '2024-01-03T00:00:00Z')], { page: 1 }),
      page('invoices', 'Invoices', [invoice('i3', '2024-01-03T00:00:00Z')], { page: 1 }),
      page('credit_notes', 'CreditNotes', [], { page: 1 }),
      page('payments', 'Payments', [{ PaymentID: 'p1', PaymentType: 'ACCRECPAYMENT', Status: 'AUTHORISED', Invoice: { InvoiceID: 'i1' }, Date: at('2024-02-01T00:00:00Z'), Amount: 220, IsReconciled: true, UpdatedDateUTC: at('2024-02-01T00:00:00Z') }], { page: 1 }),
    ]);
    const res = await mirror(adminToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [invoices, credits, payments] = res.body.results;
    assert.deepEqual({ ...invoices, resource: undefined }, { resource: undefined, pages: 3, read: 5, inserted: 3, changed: 0, unchanged: 2, stopped: 'done' });
    assert.equal(credits.stopped, 'done');
    assert.equal(payments.inserted, 1);
    assert.deepEqual(res.body.counts, { invoices: 3, credit_notes: 0, payments: 1 });
    assert.equal(replay.unused().length, 0);

    const headers = replay.calls.filter((c) => c.path.endsWith('/Invoices')).map((c) => c.headers['If-Modified-Since'] ?? null);
    assert.deepEqual(headers, [null, '2024-01-01T23:59:59', '2024-01-02T23:59:59']);

    const { rows: [row] } = await handle.db.execute(sql`select reference, total_cents, amount_due_cents, issued_on::text, lines from xero_invoices where xero_invoice_id = 'i1'`);
    assert.equal(row.reference, null, 'no patient text without XERO_KEEP_REFERENCE');
    assert.equal(row.total_cents, '22000');
    assert.equal(row.issued_on, '2024-03-01');
    assert.equal(row.lines[0].description, null);
  });

  test('a later copy reads only changes, from where the last one ended', async () => {
    const replay = xero.script([
      page('invoices', 'Invoices', [invoice('i1', '2024-05-01T00:00:00Z', { Status: 'PAID', AmountDue: 0, AmountPaid: 220, FullyPaidOnDate: at('2024-05-01T00:00:00Z') })], { page: 1 }),
    ]);
    const res = await mirror(adminToken, { resources: ['invoices'] });
    assert.equal(res.status, 200);
    assert.equal(res.body.results[0].changed, 1);
    assert.equal(replay.calls[0].headers['If-Modified-Since'], '2024-01-02T23:59:59');
    const { rows: [row] } = await handle.db.execute(sql`select status, fully_paid_on::text from xero_invoices where xero_invoice_id = 'i1'`);
    assert.deepEqual(row, { status: 'PAID', fully_paid_on: '2024-05-01' });
    const cursor = res.body.cursors.find((c) => c.resource === 'invoices');
    assert.equal(cursor.passes, 2);
    assert.equal(new Date(cursor.modifiedSince).toISOString(), '2024-04-30T23:59:59.000Z');
  });

  test('a failed page keeps the cursor and records why', async () => {
    xero.script([xeroAnswer('Invoices', { Message: 'down' }, { status: 500, query: { page: 1 } })]);
    const res = await mirror(adminToken, { resources: ['invoices'] });
    assert.equal(res.status, 500);
    const status = await request(app, `/api/xero/mirror?organisationId=${lab.organisation.id}`, { token: lab.staffToken });
    const cursor = status.body.cursors.find((c) => c.resource === 'invoices');
    assert.match(cursor.lastError, /xero_api_error/);
    assert.equal(new Date(cursor.modifiedSince).toISOString(), '2024-04-30T23:59:59.000Z');
    assert.equal(await count('xero_invoices'), 3);
  });

  test('the copy stops before it spends the calls kept for drafts and people', async () => {
    const tight = scriptedXero({ XERO_MIRROR_RESERVE_FRACTION: '1' });
    await connectDirectly(handle, tight.runtime, lab.organisation.id);
    const replay = tight.script([]);
    const result = await mirrorResource(handle.db, tight.runtime, lab.organisation.id, 'invoices');
    assert.equal(result.stopped, 'budget');
    assert.equal(replay.calls.length, 0);
  });

  test('a bad resource list is refused', async () => {
    assert.equal((await mirror(adminToken, { resources: ['bills'] })).status, 400);
  });
});
