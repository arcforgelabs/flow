import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice } from '../server/core/invoices.js';
import { invoiceMatchDetail, jobMatchDetail, listReconcile } from '../server/core/job-match.js';
import { billingObligations, invoices } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Synthetic stored records exercise the read owner with real PostgreSQL queries.
// The authenticated link and settle flow stays in job-links.test.js.
describe('job and invoice matching', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  let client;
  let item;
  let sequence = 0;
  const date = '2026-06-15';
  const createdAt = new Date('2026-06-15T12:00:00Z');

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
  });
  after(async () => handle?.close());
  beforeEach(async () => {
    lab = await createOrganisation(db, { name: 'Synthetic Lab' });
    client = await createContact(db, lab.id, { kind: 'customer', name: 'Synthetic Client' });
    item = await createPriceItem(db, lab.id, { code: 'ITEM', name: 'Synthetic item', unitAmountCents: 10000, taxCode: 'GST_FREE' });
  });

  async function job(fields = {}) {
    const [row] = await db.insert(billingObligations).values({
      organisationId: lab.id, contactId: client.id, sourceSystem: 'synthetic', sourceJobRef: `JOB-${++sequence}`,
      jobDate: date, createdAt, sourceSeenAt: createdAt, readyAt: createdAt,
      lines: [{ priceItemId: item.id, unitAmountCents: 10000, quantity: 1 }],
      lineFingerprint: 'synthetic', subtotalCents: 10000, taxCents: 0, totalCents: 10000, mappingComplete: true,
      ...fields,
    }).returning();
    return row;
  }

  async function invoice({ organisationId = lab.id, contactId = client.id, reference = null, lines = [{ priceItemId: item.id }], ...fields } = {}) {
    const draft = await createDraftInvoice(db, organisationId, { contactId, reference, lines });
    const [row] = await db.update(invoices).set({ issueDate: date, createdAt, ...fields }).where(eq(invoices.id, draft.id)).returning();
    return row;
  }

  test('the queues contain only unsettled gaps, oldest first, with available match counts', async () => {
    const newer = await job();
    const undated = await job({ jobDate: null });
    const older = await job({ jobDate: '2026-06-14' });
    await job({ readyAt: null });
    await job({ holdState: 'held', holdReason: 'Synthetic hold' });
    await job({ accountingState: 'authorised', accountingRef: 'SYNTHETIC-ACCOUNT' });
    const taken = await invoice();
    await job({ invoiceId: taken.id });
    await invoice({ status: 'void', number: 'VOID-1' });
    const second = await invoice();
    const first = await invoice({ issueDate: '2026-06-14' });

    const queue = await listReconcile(db, lab.id);
    assert.deepEqual(queue.jobs.map((j) => [j.id, j.possible]), [[older.id, 2], [newer.id, 2], [undated.id, 2]]);
    assert.deepEqual(queue.invoices.map((i) => [i.id, i.possible]), [[first.id, 5], [second.id, 5]]);
  });

  test('another organisation cannot supply a gap, a search result, or a detail record', async () => {
    const other = await createOrganisation(db, { name: 'Other Synthetic Lab' });
    const otherClient = await createContact(db, other.id, { kind: 'customer', name: 'Other Synthetic Client' });
    const localJob = await job({ caseRef: 'scope-needle' });
    const localInvoice = await invoice({ reference: 'scope-needle' });
    const foreignJob = await job({ organisationId: other.id, contactId: otherClient.id, caseRef: 'scope-needle', lines: [] });
    const foreignInvoice = await invoice({ organisationId: other.id, contactId: otherClient.id, reference: 'scope-needle', lines: [] });

    const queue = await listReconcile(db, lab.id);
    assert.deepEqual(queue.jobs.map((j) => j.id), [localJob.id]);
    assert.deepEqual(queue.invoices.map((i) => i.id), [localInvoice.id]);
    assert.deepEqual((await jobMatchDetail(db, lab.id, localJob.id, { q: 'scope-needle' })).invoices.map((i) => i.id), [localInvoice.id]);
    assert.deepEqual((await invoiceMatchDetail(db, lab.id, localInvoice.id, { q: 'scope-needle' })).jobs.map((j) => j.id), [localJob.id]);
    await assert.rejects(jobMatchDetail(db, lab.id, foreignJob.id), { code: 'not_found', message: 'job not found' });
    await assert.rejects(invoiceMatchDetail(db, lab.id, foreignInvoice.id), { code: 'not_found', message: 'invoice not found' });
  });

  test('suggestions include day 60 in both directions and use the creation date when needed', async () => {
    const source = await job();
    const target = await invoice();
    const otherClient = await createContact(db, lab.id, { kind: 'customer', name: 'Other Synthetic Client' });
    await invoice({ contactId: otherClient.id });
    await job({ contactId: otherClient.id });
    const expectedInvoices = [];
    const expectedJobs = [source.id];
    for (const [day, included] of [['2026-04-15', false], ['2026-04-16', true], ['2026-08-14', true], ['2026-08-15', false]]) {
      const i = await invoice({ issueDate: day });
      const j = await job({ jobDate: day });
      if (included) {
        expectedInvoices.push(i.id);
        expectedJobs.push(j.id);
      }
    }
    // A draft has no issue date; its creation day still places it in range.
    await db.update(invoices).set({ issueDate: null }).where(eq(invoices.id, target.id));
    expectedInvoices.push(target.id);
    const detail = await jobMatchDetail(db, lab.id, source.id);
    assert.deepEqual(new Set(detail.invoices.map((i) => i.id)), new Set(expectedInvoices));
    assert.equal(detail.invoices.find((i) => i.id === target.id).checks.date.days, 0);
    await db.update(billingObligations).set({ jobDate: null }).where(eq(billingObligations.id, source.id));
    const reverse = await invoiceMatchDetail(db, lab.id, target.id);
    assert.deepEqual(new Set(reverse.jobs.map((j) => j.id)), new Set(expectedJobs));
    assert.equal(reverse.invoice.date, date);
  });

  test('search treats percent, underscore and backslash as text and finds records beyond suggestions', async () => {
    const otherClient = await createContact(db, lab.id, { kind: 'customer', name: 'Other Synthetic Client' });
    const source = await job({ contactId: null, jobDate: null });
    const target = await invoice();
    assert.deepEqual((await jobMatchDetail(db, lab.id, source.id)).invoices, [], 'no client means no automatic suggestions');
    for (const text of ['REF%END', 'REF_END', 'REF\\END']) {
      const foundInvoice = await invoice({ contactId: otherClient.id, issueDate: '2025-01-01', reference: text });
      await invoice({ contactId: otherClient.id, reference: 'REFxEND' });
      const foundJob = await job({ contactId: otherClient.id, jobDate: '2025-01-01', caseRef: text });
      await job({ contactId: otherClient.id, caseRef: 'REFxEND' });
      const forward = await jobMatchDetail(db, lab.id, source.id, { q: ` ${text} ` });
      assert.deepEqual(forward.invoices.map((i) => i.id), [foundInvoice.id], text);
      const reverse = await invoiceMatchDetail(db, lab.id, target.id, { q: text });
      assert.deepEqual(reverse.jobs.map((j) => j.id), [foundJob.id], text);
    }
    const amount = await invoice({ contactId: otherClient.id, lines: [{ priceItemId: item.id, unitAmountCents: 123456 }] });
    for (const q of ['$1,234.56', '1234.56']) {
      assert.deepEqual((await jobMatchDetail(db, lab.id, source.id, { q })).invoices.map((i) => i.id), [amount.id]);
    }
    await invoice({ status: 'void', number: 'VOID-SEARCH', reference: 'void-only' });
    assert.deepEqual((await jobMatchDetail(db, lab.id, source.id, { q: 'void-only' })).invoices, []);
    const linked = await job({ invoiceId: target.id, caseRef: 'settled-only' });
    await job({ accountingState: 'authorised', accountingRef: 'SYNTHETIC-ACCOUNT', caseRef: 'settled-only' });
    assert.deepEqual((await invoiceMatchDetail(db, lab.id, target.id, { q: 'settled-only' })).jobs, []);
    const settled = await invoiceMatchDetail(db, lab.id, target.id);
    assert.equal(settled.invoice.jobs[0].id, linked.id);
    assert.equal(settled.invoice.open, false);
  });

  test('ranking compares unordered lines with quantities and duplicate items, normalises references, and warns about taken invoices', async () => {
    const lines = [{ priceItemId: item.id, quantity: 2, unitAmountCents: 10000 }, { priceItemId: item.id, lineAmountCents: 0 }];
    const source = await job({ lines, subtotalCents: 20000, totalCents: 20000 });
    const invoiceLines = [{ priceItemId: item.id, unitAmountCents: 0 }, { priceItemId: item.id, quantity: 2 }];
    const best = await invoice({ reference: '  CASE   ABC ', lines: invoiceLines, createdAt: new Date('2026-06-01T12:00:00Z') });
    const taken = await invoice({ reference: 'case abc', lines: invoiceLines });
    const linked = await job({ invoiceId: taken.id });
    // The same total and item set does not mean the same lines.
    const combined = await invoice({ reference: 'case abc', lines: [{ priceItemId: item.id, quantity: 2 }] });
    for (let n = 0; n < 6; n += 1) await invoice({ reference: 'case abc' });

    const detail = await jobMatchDetail(db, lab.id, source.id, { reference: 'case abc' });
    assert.deepEqual(detail.invoices.map((i) => i.id), [best.id, taken.id, combined.id]);
    assert.deepEqual(detail.invoices.map((i) => i.best), [true, false, false]);
    assert.deepEqual(detail.invoices[0].checks, { client: 'same', reference: 'same', date: { days: 0 }, lines: 'same', total: 'same', others: 0 });
    assert.equal(detail.invoices[1].checks.others, 1);
    assert.equal(detail.invoices[1].jobs[0].id, linked.id);
    assert.equal(detail.invoices[2].checks.lines, 'differs');
    const searched = await jobMatchDetail(db, lab.id, source.id, { reference: 'case abc', q: 'abc' });
    assert.equal(searched.invoices.length, 8);
    assert.equal(searched.invoices[0].id, best.id);
  });

  test('missing facts stay unknown and a candidate without matching facts is not marked best', async () => {
    const source = await job({ contactId: null, jobDate: null, lines: [], subtotalCents: 0, totalCents: 0 });
    const target = await invoice({ reference: 'unknown-facts' });
    const detail = await jobMatchDetail(db, lab.id, source.id, { q: 'unknown-facts' });
    assert.equal(detail.invoices[0].id, target.id);
    assert.deepEqual(detail.invoices[0].checks, { client: null, reference: null, date: null, lines: null, total: 'differs', others: 0 });
    assert.equal(detail.invoices[0].best, false);
  });
});
