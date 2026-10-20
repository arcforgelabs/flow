import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice } from '../server/core/invoices.js';
import { createRegistry } from '../server/integrations/port.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import {
  confirmNoInvoice, draftInvoiceForObligation, explainObligation, linkJobToInvoice, linkSuggestionsFor, observeJob,
  recordAccountingEvidence, setReady,
} from '../server/core/ledger.js';
import { linkRejections, linkSuggestions } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// A ready job with no Flow invoice, and a Flow invoice with no job: "Make
// invoice", and links on the Reconcile page (server/core/ledger.js,
// job-match.js). Synthetic data only.
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
    const row = await confirmNoInvoice(db, lab.id, obligation.id, { actor });
    assert.equal(row.accountingState, 'not_found');
    assert.deepEqual(await suggestionStates(obligation.id), { 'ACC-1': 'rejected', 'ACC-2': 'rejected' });
    const rejected = await db.select().from(linkRejections).where(eq(linkRejections.obligationId, obligation.id));
    assert.equal(rejected.length, 2, 'the matcher never suggests them again');
    const { invoice } = await draftInvoiceForObligation(db, lab.id, obligation.id, { actor, liveCheck: async () => ({ state: 'not_found' }) });
    assert.ok(invoice.id);
    await assert.rejects(confirmNoInvoice(db, lab.id, obligation.id, { actor }), /not waiting for a person/);
  });

  test('a job links to a Flow invoice that exists, which settles an unclear match', async () => {
    const obligation = await unclearJob();
    const invoice = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ description: 'Crown', quantity: 1, unitAmountCents: 22000, taxCode: 'GST' }] });
    const row = await linkJobToInvoice(db, lab.id, obligation.id, { invoiceId: invoice.id, actor });
    assert.equal(row.invoiceId, invoice.id);
    assert.equal(row.accountingState, 'unknown');
    assert.deepEqual(await suggestionStates(obligation.id), { 'ACC-1': 'rejected', 'ACC-2': 'rejected' });
    assert.equal((await explainObligation(db, lab.id, obligation.id)).view, 'drafted');
    await assert.rejects(linkJobToInvoice(db, lab.id, obligation.id, { invoiceId: invoice.id, actor }), /has an invoice already/);
  });

  test('the Reconcile API lists both gaps, compares, searches, links, or says there is none', async () => {
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
    const own = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ description: 'Crown', quantity: 1, unitAmountCents: 22000, taxCode: 'GST' }] });
    assert.equal((await request(app, '/reconcile/x', { token })).status, 200, 'the page itself loads at its own path');
    const queue = await call('/reconcile');
    assert.equal(queue.status, 200);
    assert.equal(queue.body.jobs.find((j) => j.id === linked.id).clientName, 'Example Practice');
    assert.ok(queue.body.invoices.some((i) => i.id === own.id), 'an invoice with no job is a gap too');
    const detail = await call(`/jobs/${linked.id}/reconcile`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.job.open, true);
    assert.equal(detail.body.job.unclear, true);
    const candidate = detail.body.invoices.find((i) => i.id === own.id);
    assert.ok(candidate, 'a Flow invoice of the same client is a candidate');
    assert.equal(candidate.checks.client, 'same');
    assert.equal(candidate.checks.others, 0);
    const searched = await call(`/jobs/${linked.id}/reconcile?q=${encodeURIComponent(`$${(own.totalCents / 100).toFixed(2)}`)}`);
    assert.ok(searched.body.invoices.some((i) => i.id === own.id), 'search finds it by amount');
    const reverse = await call(`/invoices/${own.id}/reconcile`);
    assert.equal(reverse.status, 200);
    assert.ok(reverse.body.jobs.some((j) => j.id === linked.id), 'the invoice lists the job');
    assert.equal((await call(`/jobs/${linked.id}/link`, { method: 'POST', body: { invoiceId: 'not-an-id' } })).status, 404);
    const link = await call(`/jobs/${linked.id}/link`, { method: 'POST', body: { invoiceId: own.id } });
    assert.equal(link.status, 200);
    assert.equal(link.body.job.invoiceId, own.id);
    const after = await call('/reconcile');
    assert.equal(after.body.jobs.some((j) => j.id === linked.id), false, 'a linked job leaves the queue');
    assert.equal(after.body.invoices.some((i) => i.id === own.id), false, 'so does its invoice');

    const fresh = await unclearJob();
    const none = await call(`/jobs/${fresh.id}/no-invoice`, { method: 'POST', body: {} });
    assert.equal(none.status, 200);
    assert.equal(none.body.job.accountingState, 'not_found');
    assert.equal((await call(`/jobs/${fresh.id}/no-invoice`, { method: 'POST', body: {} })).status, 400, 'settled once');
  });
});
