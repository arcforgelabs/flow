import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { observeJob, recordAccountingEvidence } from '../server/core/ledger.js';
import {
  RECONCILE_KIND, RECONCILE_REVIEW_KIND, createReconcileWorker, reconcileDays, reconcileDue, reconcileHealth, runReconcile,
} from '../server/core/reconcile.js';
import { backgroundJobs, reviewItems } from '../server/db/schema.js';
import { readBillableJobs } from '../server/integrations/seazona/reconcile.js';
import { seazonaOrders } from '../server/integrations/seazona/schema.js';
import { skipWithoutDatabase } from './support/db.js';
import { freshSeazonaDatabase } from './support/seazona.js';

// The daily reconcile (issue 129): counts and totals per day across the work
// system's copy, the ledger and the accounting system's copy, from Flow's own
// tables only. Synthetic records only (CONTRIBUTING.md).

const NOW = Date.parse('2026-10-20T03:00:00Z');
const HOUR = 60 * 60_000;
const integrationsOf = (adapters) => ({ with: (capability) => adapters.filter((a) => typeof a.capabilities[capability] === 'function') });

describe('daily reconcile', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  let practice;
  // What the fakes answer; each test sets them.
  let workJobs = [];
  let copies = [];
  let calls = 0;

  const work = {
    id: 'seazona',
    capabilities: { billableJobs: async () => { calls += 1; return { jobs: workJobs }; } },
  };
  const accounting = {
    id: 'xero',
    capabilities: {
      findInvoices: async ({ invoiceIds }) => ({ invoices: copies.filter((c) => invoiceIds.includes(c.id)) }),
    },
  };
  const integrations = integrationsOf([work, accounting]);

  const observe = (ref, jobDate, unitAmountCents = 22000) => observeJob(db, lab.id, {
    sourceSystem: 'seazona', sourceJobRef: ref, caseRef: ref, contactId: practice.id, jobDate,
    lines: [{ itemCode: 'CRN', unitAmountCents }], observedAt: new Date(NOW).toISOString(), actor: 'seazona',
  });
  const openItems = () => db.select().from(reviewItems).where(and(
    eq(reviewItems.organisationId, lab.id), eq(reviewItems.kind, RECONCILE_REVIEW_KIND), eq(reviewItems.state, 'open'),
  ));

  before(async () => {
    handle = await freshSeazonaDatabase();
    db = handle.db;
    lab = await createOrganisation(db, { name: 'Example Lab' });
    practice = await createContact(db, lab.id, { kind: 'customer', name: 'Example Practice' });
    await createPriceItem(db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000, taxCode: 'GST_FREE' });
  });
  after(async () => handle?.close());

  test('a day where the copy, the ledger and the accounting copy agree has no difference', async () => {
    const a = await observe('J-1', '2026-10-18');
    await observe('J-2', '2026-10-18');
    await recordAccountingEvidence(db, lab.id, a.id, { state: 'authorised', accountingRef: 'X-1', matchedBy: 'accounting_ref', actor: 'test' });
    workJobs = [{ ref: 'J-1', day: '2026-10-18', subtotalCents: 22000 }, { ref: 'J-2', day: '2026-10-18', subtotalCents: 22000 }];
    copies = [{ id: 'X-1', totalCents: 22000 }];
    const { days } = await reconcileDays(db, lab.id, { integrations, from: '2026-08-22', to: '2026-10-20' });
    assert.equal(days.length, 1);
    const [day] = days;
    assert.deepEqual(day.work, { count: 2, subtotalCents: 44000, unpriced: 0 });
    assert.deepEqual(day.ledger, { count: 2, subtotalCents: 44000, totalCents: 44000 });
    assert.deepEqual(day.accounting, { linked: 1, found: 1, totalCents: 22000 });
    assert.equal(Object.values(day.differences).flat().length, 0);
  });

  test('a new difference opens an item only when the recheck still sees it, and the item closes when a run agrees', async () => {
    // J-3 is in the copy but not yet in the ledger; J-2 left the copy.
    workJobs = [{ ref: 'J-1', day: '2026-10-18', subtotalCents: 22000 }, { ref: 'J-3', day: '2026-10-19', subtotalCents: 5000 }];
    const first = await runReconcile(db, lab.id, { integrations, now: NOW });
    assert.equal(first.daysDifferent, 2);
    assert.deepEqual(first.unconfirmed, ['2026-10-18', '2026-10-19']);
    assert.equal((await openItems()).length, 0, 'a first sighting waits for the recheck');

    // The pipeline caught up with J-3 before the recheck; J-2 is still gone.
    await observe('J-3', '2026-10-19', 5000);
    const second = await runReconcile(db, lab.id, { integrations, now: NOW + HOUR, unconfirmed: first.unconfirmed });
    assert.equal(second.daysDifferent, 1);
    assert.equal(second.opened, 1);
    const [item] = await openItems();
    assert.equal(item.entity, 'day');
    assert.equal(item.evidence.day, '2026-10-18');
    assert.equal(item.evidence.ledger.count, 2);
    assert.equal(item.evidence.work.count, 1);
    assert.equal(item.evidence.differences.missingInWork.count, 1);
    assert.equal(item.evidence.differences.missingInWork.ids.length, 1);
    assert.deepEqual(item.systems, ['seazona', 'xero']);
    assert.equal(item.moneyAtRiskCents, 22000);

    // A repeat finding refreshes the same item.
    await runReconcile(db, lab.id, { integrations, now: NOW + 2 * HOUR });
    assert.equal((await openItems()).length, 1);

    // J-2 is back in the copy: the item closes by itself.
    workJobs.push({ ref: 'J-2', day: '2026-10-18', subtotalCents: 22000 });
    const agreed = await runReconcile(db, lab.id, { integrations, now: NOW + 3 * HOUR });
    assert.equal(agreed.daysDifferent, 0);
    assert.equal(agreed.closed, 1);
    assert.equal(agreed.openItems, 0);
    assert.equal((await openItems()).length, 0);
  });

  test('a linked invoice missing from the accounting copy, or with another total, is a difference', async () => {
    const b = await observe('J-4', '2026-10-17');
    const c = await observe('J-5', '2026-10-17');
    await recordAccountingEvidence(db, lab.id, b.id, { state: 'authorised', accountingRef: 'X-4', matchedBy: 'accounting_ref', actor: 'test' });
    await recordAccountingEvidence(db, lab.id, c.id, { state: 'paid', accountingRef: 'X-5', matchedBy: 'accounting_ref', actor: 'test' });
    workJobs.push({ ref: 'J-4', day: '2026-10-17', subtotalCents: 22000 }, { ref: 'J-5', day: '2026-10-17', subtotalCents: 22000 });
    // X-4 is not in the copy. X-5 carries the job's total plus GST, which a
    // matched invoice may; then 1 cent more, which it may not.
    copies = [{ id: 'X-1', totalCents: 22000 }, { id: 'X-5', totalCents: 24200 }];
    let [day] = (await reconcileDays(db, lab.id, { integrations, from: '2026-10-17', to: '2026-10-17' })).days;
    assert.deepEqual(day.differences.missingInAccounting.map((d) => d.id), [b.id]);
    assert.equal(day.differences.accountingTotalDiffers.length, 0);
    copies = [{ id: 'X-1', totalCents: 22000 }, { id: 'X-4', totalCents: 22000 }, { id: 'X-5', totalCents: 24201 }];
    [day] = (await reconcileDays(db, lab.id, { integrations, from: '2026-10-17', to: '2026-10-17' })).days;
    assert.equal(day.differences.missingInAccounting.length, 0);
    assert.deepEqual(day.differences.accountingTotalDiffers.map((d) => d.id), [c.id]);
  });

  test('a job only a history import reported is left out', async () => {
    await observeJob(db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: 'H-1', caseRef: 'H-1', contactId: practice.id, jobDate: '2026-10-16',
      lines: [{ itemCode: 'CRN' }], observedAt: new Date(NOW).toISOString(), actor: 'import:seazona_history',
    });
    const { days } = await reconcileDays(db, lab.id, { integrations, from: '2026-10-16', to: '2026-10-16' });
    assert.equal(days.length, 0);
  });

  test('a run is due once a day, and an hour after a new difference', () => {
    const at = (ms, state = 'succeeded', unconfirmed = []) => ({ updatedAt: new Date(ms), state, result: { unconfirmed } });
    assert.equal(reconcileDue(null, NOW), true);
    assert.equal(reconcileDue(at(NOW - 23 * HOUR), NOW), false);
    assert.equal(reconcileDue(at(NOW - 24 * HOUR), NOW), true);
    assert.equal(reconcileDue(at(NOW - HOUR / 2, 'succeeded', ['2026-10-18']), NOW), false);
    assert.equal(reconcileDue(at(NOW - HOUR, 'succeeded', ['2026-10-18']), NOW), true);
  });

  test('the worker runs on the job queue, and GET /health shows the last run with counts only', async () => {
    copies = [{ id: 'X-1', totalCents: 22000 }, { id: 'X-4', totalCents: 22000 }, { id: 'X-5', totalCents: 24200 }];
    const lines = [];
    const log = { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
    let clock = NOW + 5 * HOUR;
    const worker = createReconcileWorker({ db, integrations, log, now: () => clock, timers: { setTimeout: () => null, clearTimeout: () => {} } });
    worker.start();
    calls = 0;
    await worker.tick();
    assert.equal(calls, 1);
    assert.match(lines.at(-1), /\[reconcile\] \d+ days checked, 0 differ/);
    clock += HOUR;
    await worker.tick();
    assert.equal(calls, 1, 'not due again the same day');
    await worker.stop();
    const runs = await db.select().from(backgroundJobs).where(eq(backgroundJobs.kind, RECONCILE_KIND));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state, 'succeeded');

    const health = await reconcileHealth(db, { now: clock });
    assert.equal(health.state, 'succeeded');
    assert.equal(health.agrees, true);
    assert.equal(health.daysDifferent, 0);
    assert.equal(health.late, false);

    const server = createApp({ build: {}, database: handle }).listen(0);
    try {
      const body = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
      assert.equal(body.reconcile.state, 'succeeded');
      assert.equal(body.reconcile.agrees, true);
      assert.equal(JSON.stringify(body.reconcile).includes('J-'), false, 'no record ids on /health');
    } finally {
      server.close();
    }
  });

  test('the Seazona copy counts each billable job once, on its job day', async () => {
    const at = new Date(NOW);
    const order = (id, status, orderedText, lines, extra = {}) => ({
      id, status, orderedText, lines, recordHash: id, firstSeenAt: at, lastSyncedAt: at, lastChangedAt: at, ...extra,
    });
    await db.insert(seazonaOrders).values([
      order('ORD-1', 'Shipped', '18/10/2026', [{ code: 'CRN', description: 'Crown', amountCents: 22000 }]),
      order('ORD-2', 'Complete', '19/10/2026', [{ code: 'CRN', description: 'Crown' }]),
      order('ORD-3', 'In Progress', '19/10/2026', [{ code: 'CRN', description: 'Crown', amountCents: 22000 }]),
      order('ORD-4', 'Shipped', '19/10/2026', [{ code: 'CRN', description: 'Crown', amountCents: 22000 }], { deletedInSourceAt: at }),
      order('ORD-5', 'Shipped', '19/10/2026', []),
      order('ORD-6', 'Shipped', '01/01/2026', [{ code: 'CRN', description: 'Crown', amountCents: 22000 }]),
    ]);
    const { jobs } = await readBillableJobs(db, { from: '2026-08-22', to: '2026-10-20', pageSize: 2 });
    assert.deepEqual(jobs.sort((a, b) => a.ref.localeCompare(b.ref)), [
      { ref: 'ORD-1', day: '2026-10-18', subtotalCents: 22000 },
      { ref: 'ORD-2', day: '2026-10-19', subtotalCents: null },
    ]);
  });
});
