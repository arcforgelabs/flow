import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { getInvoice } from '../server/core/invoices.js';
import { autoDraftJobs } from '../server/core/invoicing-rules.js';
import { observeJob, setReady } from '../server/core/ledger.js';
import { linkCustomers } from '../server/core/pipeline.js';
import { READ_BEFORE_ACT_MS } from '../server/core/read-before-act.js';
import { invoiceViews, markReady, sendAllReady } from '../server/core/sending.js';
import { billingObligations } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Issue #141: just before Flow drafts or sends from a job whose work system
// report is old, it reads that job again. The work system is a fake that
// answers from a synthetic job list. Synthetic data only.

const SEEN = new Date('2026-10-19T00:00:00.000Z');
const LATER = new Date(SEEN.getTime() + READ_BEFORE_ACT_MS + 60_000);

describe('read before act', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  let counter = 0;
  // What the fake work system answers, by job ref.
  const answers = new Map();
  const reads = [];
  const work = {
    id: 'seazona',
    capabilities: {
      readWorkItem: async ({ sourceJobRef }) => {
        reads.push(sourceJobRef);
        return answers.get(sourceJobRef) ?? { state: 'unavailable', reason: 'calls are stopped' };
      },
    },
  };
  const item = (ref, lines, observedAt) => ({
    state: 'read',
    item: {
      clientId: 'CL-1',
      ledgerJob: { sourceSystem: 'seazona', sourceJobRef: ref, caseRef: ref, sourceStatus: 'Shipped', jobDate: '2026-10-15', lines, observedAt },
    },
  });
  const crown = { itemCode: 'CROWN', description: 'Crown' };

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
    lab = await createOrganisation(db, { name: 'Example Lab' });
    await createContact(db, lab.id, { kind: 'customer', name: 'Example Practice' });
    await createPriceItem(db, lab.id, { code: 'CROWN', name: 'Crown', unitAmountCents: 20000 });
    await linkCustomers(db, lab.id, { system: 'seazona', customers: [{ id: 'CL-1', name: 'Example Practice' }] });
  });
  after(async () => handle?.close());

  // A ready job, last reported at SEEN.
  async function readyJob() {
    const ref = `job-${++counter}`;
    const [{ flowId }] = await db.execute(`select flow_id as "flowId" from external_links where system = 'seazona' and external_id = 'CL-1'`).then((r) => r.rows);
    const row = await observeJob(db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: ref, caseRef: ref, contactId: flowId, sourceStatus: 'Shipped', jobDate: '2026-10-15', lines: [crown], observedAt: SEEN,
    });
    await setReady(db, lab.id, row.id, { actor: 'person:test' });
    return row;
  }
  const reload = async (row) => (await db.select().from(billingObligations).where(eq(billingObligations.id, row.id)))[0];

  test('a fresh report costs no read', async () => {
    const row = await readyJob();
    reads.length = 0;
    const result = await autoDraftJobs(db, lab.id, { work, now: new Date(SEEN.getTime() + 60_000) });
    assert.deepEqual(reads, []);
    assert.equal(result.readFirst, 0);
    assert.ok((await reload(row)).invoiceId);
  });

  test('an old report is read first, and the draft uses what the work system says now', async () => {
    const row = await readyJob();
    answers.set(row.sourceJobRef, item(row.sourceJobRef, [crown, crown], LATER));
    reads.length = 0;
    const result = await autoDraftJobs(db, lab.id, { work, now: LATER });
    assert.deepEqual(reads, [row.sourceJobRef]);
    assert.equal(result.readFirst, 1);
    const fresh = await reload(row);
    assert.equal(fresh.sourceSeenAt.getTime(), LATER.getTime());
    const invoice = await getInvoice(db, lab.id, fresh.invoiceId);
    assert.equal(invoice.totalCents, 44000);
  });

  test('a read that cannot run leaves the job waiting; it never drafts from the old copy', async () => {
    const row = await readyJob();
    const result = await autoDraftJobs(db, lab.id, { work, now: LATER });
    assert.equal(result.waiting, 1);
    assert.equal((await reload(row)).invoiceId, null);
  });

  test('a job the work system deleted goes to review, not to a draft', async () => {
    const row = await readyJob();
    answers.set(row.sourceJobRef, {
      state: 'withdrawn', reason: 'deleted_in_seazona',
      ledgerHold: { sourceSystem: 'seazona', sourceJobRef: row.sourceJobRef, holdState: 'review', reason: 'the order was deleted in Seazona' },
    });
    await autoDraftJobs(db, lab.id, { work, now: LATER });
    const held = await reload(row);
    assert.equal(held.invoiceId, null);
    assert.equal(held.holdState, 'review');
  });

  test('Send all ready reads old jobs first; a job no longer billable stays a Problem and is not sent', async () => {
    const keep = await readyJob();
    const drop = await readyJob();
    await autoDraftJobs(db, lab.id, { work, now: new Date(SEEN.getTime() + 60_000) });
    const [keepInvoice, dropInvoice] = [(await reload(keep)).invoiceId, (await reload(drop)).invoiceId];
    await markReady(db, lab.id, [keepInvoice, dropInvoice], { personId: null });
    answers.set(keep.sourceJobRef, item(keep.sourceJobRef, [crown], LATER));
    answers.set(drop.sourceJobRef, { state: 'withdrawn', reason: 'not_billable', ledgerHold: null });
    const result = await sendAllReady(db, lab.id, { work, personId: 'test', issueDate: '2026-10-19', invoiceIds: null, now: LATER });
    assert.equal((await getInvoice(db, lab.id, keepInvoice)).status, 'issued');
    assert.equal((await getInvoice(db, lab.id, dropInvoice)).status, 'draft');
    assert.equal(result.waiting, 1);
    const { problems } = await invoiceViews(db, lab.id);
    assert.equal(problems.get(dropInvoice)?.[0].code, 'job_review');
  });
});
