import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { invoices } from '../server/db/schema.js';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { draftInvoiceForObligation, explainObligation, jobChangeFor, observeJob, setHold, useSourceLines } from '../server/core/ledger.js';
import { mapLines, mappingContext } from '../server/core/line-mapping.js';
import { getInvoice, issueInvoice, listInvoiceVersions } from '../server/core/invoices.js';
import { invoiceView, markReady, sendAgain, sendAllReady } from '../server/core/sending.js';
import { listReview } from '../server/core/review.js';
import { readBillableOrder } from '../server/integrations/seazona/feed.js';
import { createSeazonaClient } from '../server/integrations/seazona/client.js';
import { runSeazonaSync } from '../server/integrations/seazona/lanes.js';
import { createReplayFetch } from '../server/integrations/seazona/replay.js';
import { resolveSeazonaSettings } from '../server/integrations/seazona/settings.js';
import { fakeClock, freshSeazonaDatabase } from './support/seazona.js';
import { skipWithoutDatabase } from './support/db.js';

// Every record and amount is synthetic. No live integration is used.
describe('source invoice tax through the Seazona feed and ledger', { skip: skipWithoutDatabase }, () => {
  let handle, db, lab, contact, context;
  const clock = fakeClock('2026-08-12T12:00:00Z');
  const settings = resolveSeazonaSettings({ SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: 'synthetic' });
  before(async () => {
    handle = await freshSeazonaDatabase();
    db = handle.db;
    lab = await createOrganisation(db, { name: 'Sample Workshop' });
    contact = await createContact(db, lab.id, { kind: 'customer', name: 'Sample Customer' });
    const items = await Promise.all([
      createPriceItem(db, lab.id, { code: 'PRODUCT', name: 'Sample product', unitAmountCents: 10000, taxCode: 'GST' }),
      createPriceItem(db, lab.id, { code: 'FREE', name: 'Sample free product', unitAmountCents: 10000, taxCode: 'GST_FREE' }),
      createPriceItem(db, lab.id, { code: 'SHIP', name: 'Sample shipping', unitAmountCents: 1000, taxCode: 'GST_FREE' }),
    ]);
    context = mappingContext({ items });
  });
  after(async () => handle?.close());

  async function read(ref, { products, invoiceProducts = products, discounts = [], subtotal, tax, total }) {
    const invoice = { id: 'INV-' + ref, invoiceNumber: ref, clientId: 'CLIENT', company: 'Sample Customer', status: 'Open', invoiceDate: '12/08/2026', subtotal, tax, total, productServiceItems: invoiceProducts, discountItems: discounts };
    const order = { id: 'ORDER-' + ref, invoiceNumber: ref, clientId: 'CLIENT', company: 'Sample Customer', status: 'Shipped', ordered: '12/08/2026', products };
    const responses = [
      { path: 'invoices/', query: { lastModified: '*' }, body: [invoice] },
      { path: 'invoices/INV-' + ref, body: invoice },
      { path: 'orders/', query: { ordered: '*' }, body: [order] },
      { path: 'orders/ORDER-' + ref, body: order },
      { path: 'clients/', body: [{ id: 'CLIENT', company: 'Sample Customer', taxRate: 0 }] },
      { path: 'clients/CLIENT', body: { id: 'CLIENT', company: 'Sample Customer', taxRate: 0 } },
    ];
    await runSeazonaSync(db, createSeazonaClient({ settings, db, fetchImpl: createReplayFetch({ responses }), now: clock.now, sleepFn: clock.sleep }), { settings, now: clock.now, only: ['invoices', 'orders_recent', 'clients'], force: true });
    const { item } = await readBillableOrder(db, order.id);
    return { ...item.ledgerJob, contactId: contact.id, lines: mapLines(item.ledgerJob.lines, context) };
  }

  test('a zero-tax source invoice retains its total despite a taxable product flag', async () => {
    const job = await read('SAMPLE-A', {
      products: [ { code: 'PRODUCT', name: 'Sample product', price: 100, taxable: true }, { code: 'SHIP', name: 'Sample shipping', price: 10, taxable: false } ],
      subtotal: 110, tax: 0, total: 110,
    });
    const row = await observeJob(db, lab.id, job);
    assert.deepEqual([row.subtotalCents, row.taxCents, row.totalCents], [11000, 0, 11000]);
    assert.equal(row.lines[0].taxCode, 'GST', 'do not invent a line allocation from an invoice total or current client rate');
    const detail = await explainObligation(db, lab.id, row.id, { now: new Date(clock.now()) });
    assert.equal(detail.view, 'review_required');
    await assert.rejects(draftInvoiceForObligation(db, lab.id, row.id, { actor: 'test', liveCheck: null, now: new Date(clock.now()) }), { code: 'not_ready' });
  });

  test('an invoice without lines retains its single-job totals and blocks conflicting tax', async () => {
    const job = await read('SAMPLE-EMPTY', {
      products: [{ code: 'PRODUCT', name: 'Sample product', price: 100, taxable: true }],
      invoiceProducts: [], subtotal: 100, tax: 0, total: 100,
    });
    const row = await observeJob(db, lab.id, job);
    assert.deepEqual([row.subtotalCents, row.taxCents, row.totalCents], [10000, 0, 10000]);
    assert.equal((await explainObligation(db, lab.id, row.id)).view, 'review_required');
    await assert.rejects(draftInvoiceForObligation(db, lab.id, row.id, { actor: 'test', liveCheck: null, now: new Date(clock.now()) }), { code: 'not_ready' });
  });

  test('a later source conflict blocks a draft and leaves issued versions unchanged', async () => {
    const job = await read('SAMPLE-C', {
      products: [{ code: 'PRODUCT', name: 'Sample product', price: 100, taxable: true }],
      subtotal: 100, tax: 10, total: 110,
    });
    const row = await observeJob(db, lab.id, job);
    const { invoice } = await draftInvoiceForObligation(db, lab.id, row.id, { actor: 'test', liveCheck: null, now: new Date(clock.now()) });
    const conflict = { ...job, sourceTotals: { subtotalCents: 10000, taxCents: 0, totalCents: 10000 } };
    await observeJob(db, lab.id, conflict);
    const draft = await getInvoice(db, lab.id, invoice.id);
    assert.equal(draft.totalCents, 11000, 'a source read never rewrites an invoice');
    assert.equal((await invoiceView(db, lab.id, draft)).view, 'problem');
    const approval = await markReady(db, lab.id, [invoice.id], { personId: 'test' });
    assert.equal(approval.marked, 0);
    assert.ok(approval.refused[0].problems.some((problem) => problem.code === 'job_review'));
    await assert.rejects(useSourceLines(db, lab.id, row.id, { actor: 'test', accept: true }), { code: 'not_ready' });
    await assert.rejects(sendAllReady(db, lab.id, { personId: 'test', issueDate: '2026-08-12', invoiceIds: [invoice.id] }), { code: 'not_ready' });
    await observeJob(db, lab.id, job);
    assert.equal((await invoiceView(db, lab.id, draft)).view, 'ready');
    await issueInvoice(db, lab.id, invoice.id, { issuedBy: 'test', issueDate: '2026-08-12' });
    const versions = await listInvoiceVersions(db, lab.id, invoice.id);
    await observeJob(db, lab.id, conflict);
    assert.equal((await getInvoice(db, lab.id, invoice.id)).totalCents, 11000);
    assert.deepEqual(await listInvoiceVersions(db, lab.id, invoice.id), versions);
    assert.equal(await jobChangeFor(db, lab.id, invoice.id), null, 'an issued invoice does not gain a draft source review');
    // Retry keeps the issued version. It does not apply the later source totals.
    await db.update(invoices).set({ sendState: 'failed', sendError: { code: 'sample_refusal', message: 'Sample refusal.' } }).where(eq(invoices.id, invoice.id));
    const accounting = { capabilities: { sendStatus: async () => ({ connected: true, writesAllowed: true }) } };
    assert.deepEqual(await sendAgain(db, lab.id, { accounting, personId: null, invoiceIds: [invoice.id] }), { queued: 1 });
    const retried = await getInvoice(db, lab.id, invoice.id);
    assert.equal(retried.sendState, 'queued');
    assert.equal(retried.totalCents, 11000);
    assert.deepEqual(await listInvoiceVersions(db, lab.id, invoice.id), versions);
  });

  test('an unmapped discount keeps unknown tax and the authoritative zero total', async () => {
    const job = await read('SAMPLE-B', {
      products: [{ code: 'FREE', name: 'Sample free product', price: 100, taxable: false }],
      discounts: [{ name: 'Sample custom discount', amount: 100, taxable: null }], subtotal: 0, tax: 0, total: 0,
    });
    const row = await observeJob(db, lab.id, job);
    assert.deepEqual([row.subtotalCents, row.taxCents, row.totalCents], [0, 0, 0]);
    assert.equal(row.lines[1].taxCode, null);
    assert.equal(row.lines[1].taxCents, null);
    assert.equal(row.mappingComplete, false);
    assert.equal((await explainObligation(db, lab.id, row.id)).view, 'review_required');
    const reviews = await listReview(db, lab.id, { kind: 'job.source_totals' });
    assert.equal(reviews.filter((r) => r.flowId === row.id).length, 1);
    await setHold(db, lab.id, row.id, { actor: 'test', holdState: 'held', reason: 'Sample hold' });
    const again = await observeJob(db, lab.id, job);
    assert.equal(again.holdState, 'held');
    assert.equal(again.holdReason, 'Sample hold');
    await setHold(db, lab.id, row.id, { actor: 'test', holdState: 'none' });
    await assert.rejects(draftInvoiceForObligation(db, lab.id, row.id, { actor: 'test', liveCheck: null, now: new Date(clock.now()) }), { code: 'not_ready' });
  });
});
