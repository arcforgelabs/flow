import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createOrganisation } from '../server/core/directory.js';
import { explainObligation, ledgerView, observeJob, observeWithdrawn } from '../server/core/ledger.js';
import { createSeazonaClient } from '../server/integrations/seazona/client.js';
import { listWork, readBillableWork } from '../server/integrations/seazona/feed.js';
import { runSeazonaSync } from '../server/integrations/seazona/lanes.js';
import { ledgerLinesFor, toLedgerJob } from '../server/integrations/seazona/ledger.js';
import { seazonaInvoices, seazonaOrders } from '../server/integrations/seazona/schema.js';
import { shipDays } from '../server/integrations/seazona/ship-days.js';
import { billingObligations } from '../server/db/schema.js';
import { createReplayFetch, loadReplay } from '../server/integrations/seazona/replay.js';
import { resolveSeazonaSettings } from '../server/integrations/seazona/settings.js';
import { skipWithoutDatabase } from './support/db.js';
import { fakeClock, freshSeazonaDatabase } from './support/seazona.js';

// Synthetic data only (CONTRIBUTING.md).

const BILLING_REPLAY = fileURLToPath(new URL('./fixtures/seazona/billing.json', import.meta.url));

test('an invoice that carries several orders is never split: each job keeps its own order lines', () => {
  const item = {
    sourceId: 'ORD-1',
    invoiceNumber: '9001',
    syncedAt: '2026-10-01T00:00:00.000Z',
    lines: [{ description: 'Example crown', code: 'CRN', amountCents: 23000, taxable: true }],
    invoice: { lines: [{ description: 'Example crown', code: 'CRN', amountCents: 23000 }, { description: 'Example denture', code: 'DEN', amountCents: 45050 }] },
    invoiceOrderCount: 2,
  };
  assert.equal(ledgerLinesFor(item).linesFrom, 'order');
  assert.deepEqual(toLedgerJob(item).lines, [{ itemCode: 'CRN', description: 'Example crown', quantity: 1, unitAmountCents: 23000, taxCode: 'GST' }]);
  assert.equal(ledgerLinesFor({ ...item, invoiceOrderCount: 1 }).linesFrom, 'invoice');
  const unknown = toLedgerJob({ ...item, lines: [{ description: 'Example crown', code: 'CRN', amountCents: null }] }).lines[0];
  assert.equal(unknown.unitAmountCents, undefined, 'an unknown amount is left for the price list');
  assert.equal(unknown.taxCode, null, 'an unknown tax treatment stays explicit until a price item supplies it');
  assert.equal(toLedgerJob(item).sourceTotals, null, 'shared invoice totals never become one order total');
  assert.equal(toLedgerJob(item).remake, false);
  assert.equal(toLedgerJob({ ...item, remake: true }).remake, true, "Seazona's remake flag reaches the job");
});

describe('Seazona work in the billing ledger', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  const clock = fakeClock('2026-10-01T12:00:00.000Z');
  const settings = resolveSeazonaSettings({ SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: BILLING_REPLAY, SEAZONA_ORDER_LOOKBACK_DAYS: '1' });
  const sync = (responses, only) => runSeazonaSync(db, createSeazonaClient({
    settings, db, fetchImpl: createReplayFetch({ responses }), now: clock.now, sleepFn: clock.sleep,
  }), { settings, now: clock.now, only, force: true });

  before(async () => {
    handle = await freshSeazonaDatabase();
    db = handle.db;
    lab = await createOrganisation(db, { name: 'Example Lab' });
  });
  after(async () => handle?.close());

  test('the ship-days backfill gives a shipped job with no day its Seazona invoice date, after a dry run', async () => {
    const at = new Date('2026-09-01T00:00:00Z');
    await db.insert(seazonaInvoices).values({
      invoiceNumber: '7701', invoiceDateText: '20/08/2026', recordHash: 'h', firstSeenAt: at, lastSyncedAt: at, lastChangedAt: at,
    });
    const shipped = await observeJob(db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: 'ORD-7701', sourceInvoiceRef: '7701', caseRef: 'ORD-7701', sourceStatus: 'Shipped', shipped: true,
      lines: [{ description: 'Example crown', quantity: 1, unitAmountCents: 10000, taxCode: 'GST' }], observedAt: '2026-09-01T00:00:00Z', actor: 'seazona',
    });
    const none = await observeJob(db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: 'ORD-7702', caseRef: 'ORD-7702', sourceStatus: 'Shipped', shipped: true,
      lines: [{ description: 'Example crown', quantity: 1, unitAmountCents: 10000, taxCode: 'GST' }], observedAt: '2026-09-01T00:00:00Z', actor: 'seazona',
    });
    const dry = await shipDays(db, lab.id);
    const rowOf = (result, id) => result.rows.find((r) => r.obligationId === id);
    assert.deepEqual(rowOf(dry, shipped.id), { obligationId: shipped.id, caseRef: 'ORD-7701', invoiceRef: '7701', shippedOn: '2026-08-20', from: 'invoice_date' });
    assert.equal(rowOf(dry, none.id).shippedOn, null, 'no invoice, no day: never a guess');
    assert.equal(dry.set, 0);
    const [still] = await db.select().from(billingObligations).where(eq(billingObligations.id, shipped.id));
    assert.equal(still.shippedOn, null, 'a dry run writes nothing');

    const applied = await shipDays(db, lab.id, { apply: true, actor: 'person:test' });
    assert.ok(applied.set >= 1);
    const [filled] = await db.select().from(billingObligations).where(eq(billingObligations.id, shipped.id));
    assert.equal(filled.shippedOn, '2026-08-20');
    assert.equal(rowOf(await shipDays(db, lab.id), shipped.id), undefined, 'a job with a day is not listed again');
  });

  test('a feed item becomes one obligation with the lines the lab billed in Seazona', async () => {
    await sync(loadReplay(BILLING_REPLAY).responses, ['invoices', 'orders_recent', 'clients']);
    const { items } = await readBillableWork(db);
    const [crown] = items;
    assert.equal(crown.linesFrom, 'invoice', 'invoice 5001 carries this order only');

    const obligation = await observeJob(db, lab.id, { ...crown.ledgerJob, contactId: null });
    assert.equal(obligation.sourceSystem, 'seazona');
    assert.equal(obligation.sourceJobRef, 'ORD-1001');
    assert.equal(obligation.sourceInvoiceRef, '5001');
    assert.equal(obligation.caseRef, 'ORD-1001');
    assert.equal(obligation.practitioner, 'Dr Example');
    // Crown 230.00 less a 10.00 discount, GST 10% per line: what Seazona's invoice says.
    assert.deepEqual([obligation.subtotalCents, obligation.taxCents, obligation.totalCents], [22000, 2200, 24200]);
    assert.equal(obligation.sourceSeenAt.toISOString(), crown.syncedAt);
    assert.ok(!JSON.stringify(obligation).includes('Synthetic Patient'));

    // The discount has no tax flag. Its invoice totals stay authoritative,
    // but Flow cannot assign the discount tax without evidence.
    const { view, reasons } = ledgerView(obligation, { now: new Date(clock.now()) });
    assert.equal(view, 'review_required');
    assert.ok(reasons.includes('a source line has unknown tax treatment'));

    // The same report again changes nothing.
    const again = await observeJob(db, lab.id, { ...crown.ledgerJob, contactId: null });
    assert.equal(again.id, obligation.id);
    assert.equal((await explainObligation(db, lab.id, obligation.id)).events.length, 1);
  });

  test("Seazona's remake flag reaches the job from the list row, with no detail read", async () => {
    clock.advance(5 * 60_000);
    // The same lists again, but order 1001 is now a remake. No order detail
    // answers are given: a detail read would fail this sync.
    const responses = loadReplay(BILLING_REPLAY).responses
      .filter((r) => !/^orders\/ORD-/.test(r.path))
      .map((r) => (r.path === 'orders/' ? { ...r, body: r.body.map((o) => (o.id === 'ORD-1001' ? { ...o, isRemake: true } : o)) } : r));
    const [before] = await db.select().from(seazonaOrders).where(eq(seazonaOrders.id, 'ORD-1001'));
    assert.equal(before.remake, false);
    await sync(responses, ['orders_recent']);
    const [order] = await db.select().from(seazonaOrders).where(eq(seazonaOrders.id, 'ORD-1001'));
    assert.equal(order.remake, true);
    assert.ok(order.lastChangedAt > before.lastChangedAt, 'a new flag is a change of the order');
    const crown = (await readBillableWork(db)).items.find((item) => item.sourceId === 'ORD-1001');
    assert.equal(crown.remake, true);
    const obligation = await observeJob(db, lab.id, { ...crown.ledgerJob, contactId: null });
    assert.equal(obligation.remake, true);
    // The same flag again changes nothing.
    clock.advance(60_000);
    await sync(responses, ['orders_recent']);
    const [same] = await db.select().from(seazonaOrders).where(eq(seazonaOrders.id, 'ORD-1001'));
    assert.equal(same.lastChangedAt.toISOString(), order.lastChangedAt.toISOString());
  });

  test('an order deleted in Seazona sends its obligation to review', async () => {
    clock.advance(10 * 60_000);
    await sync([{ path: 'orders/ORD-1001', status: 404 }, { path: 'orders/ORD-1002', status: 200, body: { id: 'ORD-1002', status: 'In Production' } }], ['orders_active']);
    const { items, withdrawn } = await readBillableWork(db);
    assert.ok(!items.some((item) => item.sourceId === 'ORD-1001'));
    const { ledgerWithdrawn } = withdrawn.find((entry) => entry.sourceId === 'ORD-1001');
    const { obligation: held, action } = await observeWithdrawn(db, lab.id, ledgerWithdrawn);
    assert.equal(action, 'review');
    assert.deepEqual(ledgerView(held), { view: 'review_required', reasons: ['the order was deleted in Seazona'] });
  });

  test('the Jobs board lists open orders from the copy, with the client name and status, never deleted ones', async () => {
    const { items, statuses } = await listWork(db, { now: clock.now() });
    assert.deepEqual(items.map((i) => [i.sourceJobRef, i.status]), [['ORD-1002', 'In Production']]);
    // The last read of this order had no client: the board says so.
    assert.equal(items[0].clientName, null);
    // No patient unless the installation keeps patient names.
    assert.equal(items[0].patient, null);
    // The Seazona client's name comes first; the order's own company is next.
    await db.update(seazonaOrders).set({ clientId: 'CL-1', company: 'Order Company' }).where(eq(seazonaOrders.id, 'ORD-1002'));
    assert.equal((await listWork(db, { now: clock.now() })).items[0].clientName, 'Example Practice');
    await db.update(seazonaOrders).set({ clientId: 'CL-404' }).where(eq(seazonaOrders.id, 'ORD-1002'));
    assert.equal((await listWork(db, { now: clock.now() })).items[0].clientName, 'Order Company');
    assert.deepEqual(statuses.map((s) => s.label), ['In Production']);
    assert.ok(!JSON.stringify(items).includes('Synthetic Patient'));
    // A finished order leaves the board 30 days after it last changed.
    const later = await listWork(db, { now: clock.now() + 40 * 86_400_000 });
    assert.deepEqual(later.items.map((i) => i.sourceJobRef), ['ORD-1002'], 'an open order stays');
    await db.update(seazonaOrders).set({ status: 'Shipped', lastChangedAt: new Date(clock.now()) }).where(eq(seazonaOrders.id, 'ORD-1002'));
    assert.equal((await listWork(db, { now: clock.now() })).items.length, 1, 'a shipped order shows for a while');
    assert.equal((await listWork(db, { now: clock.now() + 40 * 86_400_000 })).items.length, 0);
    // A shipped job with no invoice yet stays on the board until it is billed.
    const unbilled = await observeJob(db, lab.id, { sourceSystem: 'seazona', sourceJobRef: 'ORD-1002', caseRef: 'ORD-1002', contactId: null, lines: [{ description: 'Crown', quantity: 1, unitAmountCents: 22000, taxCode: 'GST' }] });
    assert.deepEqual((await listWork(db, { now: clock.now() + 40 * 86_400_000 })).items.map((i) => i.sourceJobRef), ['ORD-1002']);
    await db.update(billingObligations).set({ accountingRef: 'ACC-1' }).where(eq(billingObligations.id, unbilled.id));
    assert.equal((await listWork(db, { now: clock.now() + 40 * 86_400_000 })).items.length, 0, 'billed, it leaves');
  });
});
