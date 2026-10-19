import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { HISTORY_HOLD_REASON, listHistoryJobs, releaseHistoryJob } from '../server/core/history.js';
import { runPipelineOnce } from '../server/core/pipeline.js';
import { billingObligations } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// History jobs (core/history.js) reach the ledger held, so they never draft,
// and the matcher still links them. The work and accounting systems are fakes
// with synthetic records.

const ledgerJob = (ref, { invoiceRef = null, jobDate = '2024-03-01', cents = 20000, status = 'Shipped', observedAt = '2026-10-01T00:00:00.000Z' } = {}) => ({
  sourceSystem: 'seazona',
  sourceJobRef: ref,
  sourceInvoiceRef: invoiceRef,
  caseRef: ref,
  sourceStatus: status,
  lines: [{ itemCode: 'CROWN', description: 'Crown', quantity: 1, unitAmountCents: cents, taxCode: 'GST' }],
  jobDate,
  observedAt,
  actor: 'seazona',
});

function fakeWork() {
  const state = { live: [], history: [] };
  return {
    state,
    adapter: {
      id: 'seazona',
      capabilities: {
        listCustomers: async () => [{ id: 'c1', name: 'Example Dental' }],
        // Each call answers everything: the cursor is ignored, so a run reads it all again.
        pullWorkItems: async () => ({ items: state.live.map((j) => ({ clientId: 'c1', ledgerJob: j })), withdrawn: [], cursor: null, more: false }),
        pullHistoryJobs: async () => ({ items: state.history.map((j) => ({ clientId: 'c1', historical: true, ledgerJob: j })), cursor: null, more: false }),
      },
    },
  };
}

const accounting = (invoices) => ({
  id: 'xero',
  capabilities: {
    listCustomers: async () => [{ id: 'x1', name: 'Example Dental' }],
    findInvoices: async ({ invoiceIds = [], numbers = [], contactId = null }) => ({
      complete: true,
      fresh: true,
      changedAt: new Date('2026-10-01T00:00:00Z'),
      invoices: invoices.filter((i) => invoiceIds.includes(i.id) || numbers.includes(i.number) || (contactId && i.contactId === contactId && false)),
    }),
  },
});

const integrationsOf = (adapters) => ({ with: (capability) => adapters.filter((a) => typeof a.capabilities[capability] === 'function') });

describe('history jobs in the ledger', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let organisationId;
  const NOW = new Date('2026-10-02T00:00:00Z');
  const xero = accounting([{ id: 'X-1', number: 'S-100', contactId: 'x1', state: 'authorised', totalCents: 22000, subtotalCents: 20000, itemCodes: ['CROWN'] }]);

  const rows = async (ref) => db.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.sourceJobRef, ref)));

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
    organisationId = (await createOrganisation(db, { name: 'Example Lab' })).id;
    await createContact(db, organisationId, { kind: 'customer', name: 'Example Dental' });
    await createPriceItem(db, organisationId, { code: 'CROWN', name: 'Crown', unitAmountCents: 20000 });
  });
  after(async () => handle?.close());
  beforeEach(async () => {
    await db.execute(sql`truncate billing_obligations, obligation_events, link_suggestions, pipeline_cursors cascade`);
  });

  test('a history job is held, never drafted, and the matcher sets its accounting state', async () => {
    const work = fakeWork();
    work.state.history = [ledgerJob('H-1', { invoiceRef: 'S-100' }), ledgerJob('H-2')];
    const summary = await runPipelineOnce(db, integrationsOf([work.adapter, xero]), { now: NOW });
    assert.equal(summary.history.held, 2);
    // A second run changes nothing and drafts nothing.
    await runPipelineOnce(db, integrationsOf([work.adapter, xero]), { now: NOW });
    const [h1] = await rows('H-1');
    const [h2] = await rows('H-2');
    for (const row of [h1, h2]) {
      assert.equal(row.holdState, 'held');
      assert.equal(row.holdReason, HISTORY_HOLD_REASON);
      assert.equal(row.invoiceId, null);
    }
    assert.equal(h1.accountingState, 'authorised');
    assert.equal(h1.accountingRef, 'X-1');
    const listed = await listHistoryJobs(db, organisationId);
    assert.equal(listed.counts.total, 2);
    assert.equal(listed.counts.authorised, 1);

    // Only a person's release moves it into drafting.
    const released = await releaseHistoryJob(db, organisationId, h2.id, { actor: 'person:test' });
    assert.equal(released.holdState, 'none');
    await assert.rejects(releaseHistoryJob(db, organisationId, h2.id, { actor: 'person:test' }), /not a held history job/);
  });

  test('live first, then history with the same order id: one job, not held', async () => {
    const work = fakeWork();
    work.state.live = [ledgerJob('L-1')];
    await runPipelineOnce(db, integrationsOf([work.adapter]), { now: NOW });
    const [before] = await rows('L-1');
    work.state.live = [];
    work.state.history = [ledgerJob('L-1', { cents: 99900, observedAt: '2026-10-05T00:00:00.000Z' })];
    const summary = await runPipelineOnce(db, integrationsOf([work.adapter]), { now: NOW });
    assert.equal(summary.history.alreadyLive, 1);
    const after = await rows('L-1');
    assert.equal(after.length, 1);
    assert.equal(after[0].holdState, 'none');
    assert.equal(after[0].totalCents, before.totalCents, 'history never changes a live job');
    assert.equal(String(after[0].readyAt), String(before.readyAt));
  });

  test('history first, then live: the job stays held', async () => {
    const work = fakeWork();
    work.state.history = [ledgerJob('B-1')];
    await runPipelineOnce(db, integrationsOf([work.adapter]), { now: NOW });
    work.state.history = [];
    work.state.live = [ledgerJob('B-1', { observedAt: '2026-10-03T00:00:00.000Z' })];
    await runPipelineOnce(db, integrationsOf([work.adapter]), { now: NOW });
    const [row] = await rows('B-1');
    assert.equal(row.holdState, 'held');
    assert.equal(row.holdReason, HISTORY_HOLD_REASON);
    assert.equal(row.invoiceId, null);
  });
});
