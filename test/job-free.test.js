import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, issueInvoice, voidInvoice } from '../server/core/invoices.js';
import { HISTORY_HOLD_REASON } from '../server/core/history.js';
import {
  explainObligation, freeVoidedJob, linkJobToInvoice, observeJob, recordAccountingEvidence, setHold, setReady,
} from '../server/core/ledger.js';
import { linkRejections, obligationEvents } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Jobs stuck on an invoice that bills nothing now (a void Flow invoice, or an
// accounting invoice voided or deleted there), and holds a person releases.
// Synthetic data only.
describe('freeing a job stuck on a void invoice', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  let practice;
  let jobNumber = 0;
  const actor = 'person:test';
  const line = { description: 'Crown', quantity: 1, unitAmountCents: 22000, taxCode: 'GST' };

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
    lab = await createOrganisation(db, { name: 'Example Lab' });
    practice = await createContact(db, lab.id, { kind: 'customer', name: 'Example Practice' });
    await createPriceItem(db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
  });

  after(async () => handle?.close());

  async function readyJob() {
    jobNumber += 1;
    const obligation = await observeJob(db, lab.id, {
      sourceSystem: 'worksystem', sourceJobRef: `JOB-${jobNumber}`, caseRef: `CASE-${jobNumber}`,
      contactId: practice.id, shippedOn: '2026-10-17', jobDate: '2026-10-17', lines: [{ itemCode: 'CRN' }],
    });
    await setReady(db, lab.id, obligation.id, { actor });
    return obligation;
  }

  async function issuedFor(obligation) {
    const invoice = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [line] });
    await linkJobToInvoice(db, lab.id, obligation.id, { invoiceId: invoice.id, actor });
    return issueInvoice(db, lab.id, invoice.id, { issuedBy: actor, issueDate: '2026-10-18' });
  }

  test('a live Flow invoice is never let go: void it first', async () => {
    const obligation = await readyJob();
    const invoice = await issuedFor(obligation);
    await assert.rejects(freeVoidedJob(db, lab.id, obligation.id, { actor, reason: 'reissued' }), /void it first/);
    await voidInvoice(db, lab.id, invoice.id);
    const row = await freeVoidedJob(db, lab.id, obligation.id, { actor, reason: 'the lab reissued the work' });
    assert.equal(row.invoiceId, null);
    assert.equal(row.holdState, 'held', 'nothing drafts until a person releases it');
    assert.equal((await explainObligation(db, lab.id, obligation.id)).view, 'held');
    const [event] = await db.select().from(obligationEvents).where(eq(obligationEvents.kind, 'freed'));
    assert.equal(event.evidence.invoiceId, invoice.id);
  });

  test('a job linked to an invoice voided in the accounting system lets go of it for good', async () => {
    const obligation = await readyJob();
    await recordAccountingEvidence(db, lab.id, obligation.id, { state: 'voided', accountingRef: 'ACC-9', matchedBy: 'source_invoice_ref', actor });
    const row = await freeVoidedJob(db, lab.id, obligation.id, { actor, reason: 'voided in accounts', system: 'accounts' });
    assert.equal(row.accountingRef, null);
    assert.equal(row.accountingState, 'not_found');
    const rejected = await db.select().from(linkRejections).where(eq(linkRejections.obligationId, obligation.id));
    assert.deepEqual(rejected.map((r) => r.externalId), ['ACC-9'], 'the matcher never links it again');
  });

  test('a job with no void invoice is refused, and every change needs a reason', async () => {
    const obligation = await readyJob();
    await assert.rejects(freeVoidedJob(db, lab.id, obligation.id, { actor, reason: 'x' }), /not linked to a void/);
    await assert.rejects(freeVoidedJob(db, lab.id, obligation.id, { actor, reason: ' ' }), /say why/);
  });

  test('a release keeps its reason in the activity', async () => {
    const obligation = await readyJob();
    await setHold(db, lab.id, obligation.id, { holdState: 'review', reason: 'check the shade', actor });
    await setHold(db, lab.id, obligation.id, { holdState: 'none', reason: 'the lab said the shade is right', actor });
    const events = await db.select().from(obligationEvents).where(eq(obligationEvents.obligationId, obligation.id));
    assert.equal(events.find((e) => e.kind === 'released').evidence.reason, 'the lab said the shade is right');
  });

  test('the hold route releases a hold and keeps history-import holds for their own decisions', async () => {
    const { createApp } = await import('../server/app.js');
    const { seedFirstOwner } = await import('../server/auth/people.js');
    const { createPersonAuth } = await import('../server/auth/session.js');
    const { createRegistry } = await import('../server/integrations/port.js');
    const { fakeClerk, request, TEST_PUBLISHABLE_KEY } = await import('./support/clerk.js');
    const quiet = { info() {}, warn() {}, error() {} };
    const clerk = fakeClerk();
    await seedFirstOwner(db, 'owner@example.test');
    const token = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    const integrations = createRegistry({ log: quiet, env: {} });
    const personAuth = createPersonAuth({ db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    const app = createApp({ database: handle, auth: { settings: { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } }, clerk, personAuth }, integrations, log: quiet });
    const call = (path, body) => request(app, `/api/invoicing${path}`, { token, method: 'POST', body });

    const held = await readyJob();
    await setHold(db, lab.id, held.id, { holdState: 'review', reason: 'check it', actor });
    assert.equal((await call(`/jobs/${held.id}/hold`, { state: 'none' })).status, 400, 'a reason is required');
    const released = await call(`/jobs/${held.id}/hold`, { state: 'none', reason: 'checked' });
    assert.equal(released.status, 200);
    assert.equal(released.body.job.holdState, 'none');

    const history = await readyJob();
    await setHold(db, lab.id, history.id, { holdState: 'held', reason: HISTORY_HOLD_REASON, actor });
    const refused = await call(`/jobs/${history.id}/hold`, { state: 'none', reason: 'billed before' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.message ?? refused.body.error ?? '', /history/);

    const voided = await readyJob();
    const invoice = await issuedFor(voided);
    assert.equal((await call(`/jobs/${voided.id}/free`, { reason: 'reissued' })).status, 400, 'a live invoice stays');
    await voidInvoice(db, lab.id, invoice.id);
    const freed = await call(`/jobs/${voided.id}/free`, { reason: 'reissued' });
    assert.equal(freed.status, 200);
    assert.equal(freed.body.job.invoiceId, null);
    assert.equal(freed.body.job.holdState, 'held');
  });
});
