import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { createOrganisation } from '../server/core/directory.js';
import { explainObligation, ledgerView, observeJob, setHold } from '../server/core/ledger.js';
import { billingObligations } from '../server/db/schema.js';
import { createSeazonaClient } from '../server/integrations/seazona/client.js';
import { readBillableWork } from '../server/integrations/seazona/feed.js';
import { runSeazonaSync } from '../server/integrations/seazona/lanes.js';
import { ledgerLinesFor, toLedgerJob } from '../server/integrations/seazona/ledger.js';
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
  assert.equal(unknown.taxCode, undefined, 'an unknown tax treatment is left for the price list');
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

    // Not marked ready, no contact and no price list yet: the ledger keeps it
    // in work, with every reason.
    const { view, reasons } = ledgerView(obligation, { now: new Date(clock.now()) });
    assert.equal(view, 'in_work');
    assert.ok(reasons.includes('the job has no customer contact'));

    // The same report again changes nothing.
    const again = await observeJob(db, lab.id, { ...crown.ledgerJob, contactId: null });
    assert.equal(again.id, obligation.id);
    assert.equal((await explainObligation(db, lab.id, obligation.id)).events.length, 1);
  });

  test('an order deleted in Seazona sends its obligation to review', async () => {
    clock.advance(10 * 60_000);
    await sync([{ path: 'orders/ORD-1001', status: 404 }, { path: 'orders/ORD-1002', status: 200, body: { id: 'ORD-1002', status: 'In Production' } }], ['orders_active']);
    const { items, withdrawn } = await readBillableWork(db);
    assert.ok(!items.some((item) => item.sourceId === 'ORD-1001'));
    const { ledgerHold } = withdrawn.find((entry) => entry.sourceId === 'ORD-1001');

    const [obligation] = await db.select().from(billingObligations).where(and(
      eq(billingObligations.organisationId, lab.id),
      eq(billingObligations.sourceSystem, ledgerHold.sourceSystem),
      eq(billingObligations.sourceJobRef, ledgerHold.sourceJobRef),
    ));
    const held = await setHold(db, lab.id, obligation.id, { holdState: ledgerHold.holdState, reason: ledgerHold.reason, actor: 'seazona' });
    assert.deepEqual(ledgerView(held), { view: 'review_required', reasons: ['the order was deleted in Seazona'] });
  });
});
