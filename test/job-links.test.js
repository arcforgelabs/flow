import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { createRegistry } from '../server/integrations/port.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import {
  confirmNoInvoice, draftInvoiceForObligation, explainObligation, linkJobInvoice, linkSuggestionsFor, observeJob,
  recordAccountingEvidence, setReady,
} from '../server/core/ledger.js';
import { linkRejections, linkSuggestions } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// A job with no invoice whose match is unclear: "Make invoice" on the job
// panel, and the Reconcile page (server/core/ledger.js, job-match.js).
// Synthetic data only.
describe('settling a job with no invoice', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  let practice;
  let jobNumber = 0;
  const actor = 'person:test';
  const system = 'accounts';

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
    lab = await createOrganisation(db, { name: 'Example Lab' });
    practice = await createContact(db, lab.id, { kind: 'customer', name: 'Example Practice' });
    await createPriceItem(db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
  });

  after(async () => handle?.close());

  // A ready job the matcher could not tie to one invoice, with two suggestions.
  async function unclearJob() {
    jobNumber += 1;
    const obligation = await observeJob(db, lab.id, {
      sourceSystem: 'worksystem', sourceJobRef: `JOB-${jobNumber}`, caseRef: `CASE-${jobNumber}`,
      contactId: practice.id, shippedOn: '2026-10-17', jobDate: '2026-10-17', lines: [{ itemCode: 'CRN' }],
    });
    await setReady(db, lab.id, obligation.id, { actor });
    await recordAccountingEvidence(db, lab.id, obligation.id, { state: 'authorised', accountingRef: 'ACC-1', matchedBy: 'scored', actor });
    for (const [rank, externalId] of [[1, 'ACC-1'], [2, 'ACC-2']]) {
      await db.insert(linkSuggestions).values({ organisationId: lab.id, obligationId: obligation.id, system, externalId, externalNumber: `INV-${rank}`, score: 90 - rank, rank });
    }
    return obligation;
  }

  const suggestionStates = async (obligationId) => Object.fromEntries((await db.select().from(linkSuggestions)
    .where(and(eq(linkSuggestions.organisationId, lab.id), eq(linkSuggestions.obligationId, obligationId))))
    .map((s) => [s.externalId, s.state]));

  test('the matcher\'s open suggestions are listed best first', async () => {
    const obligation = await unclearJob();
    assert.equal((await explainObligation(db, lab.id, obligation.id)).view, 'review_required');
    assert.deepEqual((await linkSuggestionsFor(db, lab.id, obligation.id)).map((s) => s.externalId), ['ACC-1', 'ACC-2']);
  });

  test('"Make invoice" rejects every suggestion and lets the job draft', async () => {
    const obligation = await unclearJob();
    const row = await confirmNoInvoice(db, lab.id, obligation.id, { system, actor });
    assert.equal(row.accountingState, 'not_found');
    assert.deepEqual(await suggestionStates(obligation.id), { 'ACC-1': 'rejected', 'ACC-2': 'rejected' });
    const rejected = await db.select().from(linkRejections).where(eq(linkRejections.obligationId, obligation.id));
    assert.equal(rejected.length, 2, 'the matcher never suggests them again');
    const { invoice } = await draftInvoiceForObligation(db, lab.id, obligation.id, { actor, liveCheck: async () => ({ state: 'not_found' }) });
    assert.ok(invoice.id);
    await assert.rejects(confirmNoInvoice(db, lab.id, obligation.id, { system, actor }), /not waiting for a person/);
  });

  test('"Link invoice" ties the picked invoice to the job by a person', async () => {
    const obligation = await unclearJob();
    const row = await linkJobInvoice(db, lab.id, obligation.id, { system, invoice: { id: 'ACC-2', state: 'authorised' }, actor });
    assert.equal(row.accountingState, 'authorised');
    assert.equal(row.accountingRef, 'ACC-2');
    assert.equal(row.accountingMatchedBy, 'person');
    assert.deepEqual(await suggestionStates(obligation.id), { 'ACC-1': 'rejected', 'ACC-2': 'accepted' });
    assert.equal((await explainObligation(db, lab.id, obligation.id)).view, 'invoiced');
    await assert.rejects(linkJobInvoice(db, lab.id, obligation.id, { system, invoice: { id: 'ACC-1', state: 'authorised' }, actor }), /not waiting for a person/);
  });

  test('the job API lists the suggestions, links one, or says there is none', async () => {
    const quiet = { info() {}, warn() {}, error() {} };
    const clerk = fakeClerk();
    await seedFirstOwner(db, 'owner@example.test');
    const token = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    // An accounting system whose copy holds the two suggested invoices.
    const copy = [
      { id: 'ACC-1', number: 'INV-1', issuedOn: '2026-10-16', totalCents: 22000, state: 'authorised', status: 'AUTHORISED', lines: [{ itemCode: 'CRN', amountCents: 22000 }] },
      { id: 'ACC-2', number: 'INV-2', issuedOn: '2026-10-20', totalCents: 25000, state: 'authorised', status: 'PAID', lines: [{ itemCode: 'CRN', amountCents: 25000 }] },
    ];
    const integrations = createRegistry({ log: quiet, env: {} });
    integrations.register({
      id: system,
      name: 'Accounts',
      capabilities: {
        health: async () => ({ ok: true }),
        checkInvoice: async () => ({ state: 'not_found' }),
        pushInvoices: async () => ({ results: [] }),
        findInvoices: async ({ invoiceIds = [] }) => ({ complete: true, fresh: true, invoices: copy.filter((i) => invoiceIds.includes(i.id)) }),
      },
    });
    integrations.enable(system);
    await integrations.start(db);
    const personAuth = createPersonAuth({ db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    const app = createApp({ database: handle, auth: { settings: { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } }, clerk, personAuth }, integrations, log: quiet });
    const call = (path, options = {}) => request(app, `/api/invoicing${path}`, { token, ...options });

    const linked = await unclearJob();
    const queue = await call('/reconcile');
    assert.equal(queue.status, 200);
    const row = queue.body.jobs.find((j) => j.id === linked.id);
    assert.equal(row.clientName, 'Example Practice');
    assert.equal(row.possible, 2);
    const detail = await call(`/jobs/${linked.id}/reconcile`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.job.open, true);
    assert.equal(detail.body.accountingName, 'Accounts');
    const [best, other] = detail.body.invoices;
    assert.deepEqual([best.number, best.best, other.number, other.best], ['INV-1', true, 'INV-2', false]);
    assert.equal(best.checks.client, 'same');
    assert.equal(best.checks.date.days, -1, 'a day before the job shipped');
    assert.equal(other.checks.date.days, 3);
    assert.equal(other.checks.total, 'differs');
    assert.equal((await call(`/jobs/${linked.id}/link`, { method: 'POST', body: { invoiceId: 'ACC-9' } })).status, 400, 'only a suggestion links');
    const link = await call(`/jobs/${linked.id}/link`, { method: 'POST', body: { invoiceId: 'ACC-1' } });
    assert.equal(link.status, 200);
    assert.equal(link.body.job.accountingState, 'authorised');
    assert.equal((await call('/reconcile')).body.jobs.some((j) => j.id === linked.id), false, 'a linked job leaves the queue');

    const fresh = await unclearJob();
    const none = await call(`/jobs/${fresh.id}/no-invoice`, { method: 'POST', body: {} });
    assert.equal(none.status, 200);
    assert.equal(none.body.job.accountingState, 'not_found');
    assert.equal((await call(`/jobs/${fresh.id}/no-invoice`, { method: 'POST', body: {} })).status, 400, 'settled once');
  });
});
