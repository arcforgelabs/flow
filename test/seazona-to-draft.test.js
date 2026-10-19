import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { runPipelineOnce } from '../server/core/pipeline.js';
import { billingObligations, invoiceLines, invoices, priceItems } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// The path a lab needs every day: a shipped job in the work system, with the
// work system's own code and label, becomes a draft invoice in Flow with the
// lab's price item and customer. Synthetic records only.

const NOW = new Date('2026-10-20T00:00:00Z');

const shipped = (ref, lines) => ({
  clientId: 'c1',
  ledgerJob: {
    sourceSystem: 'seazona', sourceJobRef: ref, caseRef: ref, practitioner: 'Dr Example', jobDate: '2026-10-18',
    sourceStatus: 'Shipped', observedAt: '2026-10-19T23:00:00.000Z', actor: 'seazona', lines,
  },
});

const work = (items) => ({
  id: 'seazona',
  capabilities: {
    listCustomers: async () => [{ id: 'c1', name: 'Example Dental Pty Ltd' }],
    // Each fake hands over its own jobs once, from any earlier cursor.
    pullWorkItems: async (cursor) => (cursor === `after-${items[0].ledgerJob.sourceJobRef}`
      ? { items: [], withdrawn: [], cursor, more: false }
      : { items, withdrawn: [], cursor: `after-${items[0].ledgerJob.sourceJobRef}`, more: false }),
  },
});

const accounting = {
  id: 'xero',
  capabilities: {
    listCustomers: async () => [{ id: 'x1', name: 'Example Dental' }],
    findInvoices: async () => ({ complete: true, fresh: true, changedAt: new Date('2026-10-19T00:00:00Z'), invoices: [] }),
  },
};

const integrationsOf = (adapters) => ({ with: (capability) => adapters.filter((a) => typeof a.capabilities[capability] === 'function') });

describe('a shipped work system job becomes a draft invoice', { skip: skipWithoutDatabase }, () => {
  let handle;
  let organisationId;
  before(async () => {
    handle = await freshDatabase();
    organisationId = (await createOrganisation(handle.db, { name: 'Example Lab' })).id;
    await createContact(handle.db, organisationId, { kind: 'customer', name: 'Example Dental' });
    await createPriceItem(handle.db, organisationId, { code: 'RLN', name: 'Reline - Full Denture', unitAmountCents: 25000, taxCode: 'GST_FREE' });
    await createPriceItem(handle.db, organisationId, { code: 'ST', name: 'Special Tray', unitAmountCents: 5500, taxCode: 'GST_FREE' });
  });
  after(async () => { await handle?.close(); });

  test('the work system codes map to price items, the customer links, and the job drafts', async () => {
    const summary = await runPipelineOnce(handle.db, integrationsOf([work([shipped('J-1', [
      { itemCode: '2149', description: 'Full Denture Reline', quantity: 1, unitAmountCents: 25000, taxCode: 'GST_FREE' },
      { itemCode: '2105', description: 'Special Tray', quantity: 1, unitAmountCents: 5500, taxCode: 'GST_FREE' },
    ])]), accounting]), { now: NOW });
    assert.equal(summary.work.observed, 1);
    assert.equal(summary.work.unmappedLines, 0);
    const [job] = await handle.db.select().from(billingObligations)
      .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.sourceJobRef, 'J-1')));
    assert.ok(job.contactId, 'the job has its customer');
    assert.equal(job.mappingComplete, true);
    assert.equal(job.accountingState, 'not_found');
    assert.ok(job.readyAt, 'Shipped marks it ready');
    assert.ok(job.invoiceId, JSON.stringify(summary));

    const [draft] = await handle.db.select().from(invoices).where(eq(invoices.id, job.invoiceId));
    assert.equal(draft.status, 'draft');
    assert.equal(draft.totalCents, 30500);
    const lines = await handle.db.select({ code: priceItems.code, amount: invoiceLines.unitAmountCents })
      .from(invoiceLines).leftJoin(priceItems, eq(priceItems.id, invoiceLines.priceItemId))
      .where(eq(invoiceLines.invoiceId, draft.id));
    assert.deepEqual(lines.map((l) => [l.code, l.amount]).sort(), [['RLN', 25000], ['ST', 5500]]);
  });

  test('a line no step can map holds the job, and says so', async () => {
    const summary = await runPipelineOnce(handle.db, integrationsOf([work([shipped('J-2', [
      { itemCode: '2999', description: 'Something New', quantity: 1, unitAmountCents: 999, taxCode: 'GST' },
    ])]), accounting]), { now: NOW });
    assert.equal(summary.work.unmappedLines, 1);
    const [job] = await handle.db.select().from(billingObligations)
      .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.sourceJobRef, 'J-2')));
    assert.equal(job.mappingComplete, false);
    assert.equal(job.invoiceId, null);
  });
});
