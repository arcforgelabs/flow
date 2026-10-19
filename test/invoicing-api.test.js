import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { observeJob, recordAccountingEvidence } from '../server/core/ledger.js';
import { createRegistry } from '../server/integrations/port.js';
import { createXeroAdapter } from '../server/integrations/xero/index.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// The invoicing API (/api/invoicing) against PostgreSQL, with Clerk faked.
// Synthetic data only (CONTRIBUTING.md).
const OWNER = 'owner@example.test';
const STAFF = 'staff@example.test';
const quiet = { info() {}, warn() {}, error() {} };
const MISSING = '00000000-0000-4000-8000-000000000000';

test('the Xero adapter offers the live check a job draft needs', () => {
  assert.equal(typeof createXeroAdapter().capabilities.checkInvoice, 'function');
});

describe('invoicing API', { skip: skipWithoutDatabase }, () => {
  let handle;
  let clerk;
  let app;
  let appWithoutCheck;
  let lab;
  let practice;
  let supplier;
  let crown;
  let ownerToken;
  let staffToken;
  const checked = [];

  function invoicingApp({ integrations = null } = {}) {
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    return createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations, log: quiet });
  }

  before(async () => {
    handle = await freshDatabase();
    clerk = fakeClerk();
    lab = await createOrganisation(handle.db, { name: 'Example Lab' });
    practice = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Example Practice', email: 'accounts@example.test' });
    await createContact(handle.db, lab.id, { kind: 'customer', name: 'Another Clinic' });
    supplier = await createContact(handle.db, lab.id, { kind: 'supplier', name: 'Example Supplies' });
    crown = await createPriceItem(handle.db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
    await createPriceItem(handle.db, lab.id, { code: 'BRG', name: 'Bridge', unitAmountCents: 50000 });
    const owner = await seedFirstOwner(handle.db, OWNER);
    await invitePerson(handle.db, { email: STAFF, role: 'staff', invitedBy: owner.id });
    ownerToken = clerk.signIn(clerk.addUser({ email: OWNER, google: true, password: false }));
    staffToken = clerk.signIn(clerk.addUser({ email: STAFF }));

    // An accounting integration whose live check finds no invoice.
    const integrations = createRegistry({ log: quiet, env: {} });
    integrations.register({
      id: 'accounts',
      name: 'Accounts',
      capabilities: {
        health: async () => ({ ok: true }),
        checkInvoice: async ({ organisationId, obligation }) => {
          checked.push([organisationId, obligation.sourceJobRef]);
          return { state: 'not_found' };
        },
      },
    });
    integrations.enable('accounts');
    await integrations.start(handle.db);
    app = invoicingApp({ integrations });
    appWithoutCheck = invoicingApp();
  });

  after(async () => handle?.close());

  const call = (path, options = {}) => request(app, `/api/invoicing${path}`, { token: ownerToken, ...options });

  test('every route needs a signed-in person', async () => {
    const res = await request(app, '/api/invoicing/invoices');
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'signed_out');
  });

  test('context lists the organisations and whether this person may issue', async () => {
    const owner = await call('/context');
    assert.equal(owner.status, 200);
    assert.deepEqual(owner.body.organisations, [{ id: lab.id, name: 'Example Lab', invoicePrefix: 'INV-', nextInvoiceNumber: 1 }]);
    assert.equal(owner.body.canIssue, true);
    const staff = await call('/context', { token: staffToken });
    assert.equal(staff.body.canIssue, false);
  });

  test('contacts lists customers only, by name; the price list by code', async () => {
    const res = await call('/contacts');
    assert.deepEqual(res.body.contacts.map((c) => c.name), ['Another Clinic', 'Example Practice']);
    assert.deepEqual((await call('/contacts?q=PRACT')).body.contacts.map((c) => c.id), [practice.id]);
    const items = await call('/price-items');
    assert.deepEqual(items.body.priceItems.map((i) => i.code), ['BRG', 'CRN']);
    assert.deepEqual((await call('/price-items?q=crown')).body.priceItems.map((i) => i.unitAmountCents), [22000]);
  });

  test('draft, change, issue, revise, reissue and void', async () => {
    const created = await call('/invoices', {
      method: 'POST',
      body: { contactId: practice.id, reference: 'CASE-1', lines: [{ priceItemId: crown.id }, { description: 'Courier', unitAmountCents: 1500, taxCode: 'GST_FREE' }] },
    });
    assert.equal(created.status, 201);
    const draft = created.body.invoice;
    assert.equal(draft.status, 'draft');
    assert.deepEqual([draft.subtotalCents, draft.taxCents, draft.totalCents], [23500, 2200, 25700]);
    assert.deepEqual(draft.lines.map((l) => l.description), ['Crown', 'Courier']);
    assert.deepEqual(draft.contact, { id: practice.id, name: 'Example Practice', email: 'accounts@example.test' });
    assert.equal(draft.job, null);
    assert.deepEqual(draft.versions, []);

    const patched = await call(`/invoices/${draft.id}`, { method: 'PATCH', body: { dueDate: '2026-11-30', lines: [{ priceItemId: crown.id, quantity: 2 }] } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.invoice.dueDate, '2026-11-30');
    assert.equal(patched.body.invoice.totalCents, 48400);

    const staffIssue = await call(`/invoices/${draft.id}/issue`, { method: 'POST', token: staffToken, body: {} });
    assert.equal(staffIssue.status, 403);
    assert.equal(staffIssue.body.code, 'role_required');

    const issued = await call(`/invoices/${draft.id}/issue`, { method: 'POST', body: { issueDate: '2026-10-19' } });
    assert.equal(issued.status, 200);
    assert.equal(issued.body.invoice.status, 'issued');
    assert.equal(issued.body.invoice.number, 'INV-0001');
    assert.equal(issued.body.invoice.issueDate, '2026-10-19');
    const [v1] = issued.body.invoice.versions;
    assert.equal(v1.version, 1);
    assert.match(v1.issuedBy, /^person:[0-9a-f-]{36}$/);

    const locked = await call(`/invoices/${draft.id}`, { method: 'PATCH', body: { reference: 'changed' } });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.code, 'not_draft');

    const revised = await call(`/invoices/${draft.id}/revise`, { method: 'POST' });
    assert.equal(revised.body.invoice.status, 'draft');
    assert.equal(revised.body.invoice.number, 'INV-0001');
    const reissued = await call(`/invoices/${draft.id}/issue`, { method: 'POST', body: {} });
    assert.equal(reissued.status, 200);
    assert.deepEqual(reissued.body.invoice.versions.map((v) => v.version), [1, 2]);
    assert.match(reissued.body.invoice.issueDate, /^\d{4}-\d{2}-\d{2}$/, 'the issue date defaults to today');

    const voided = await call(`/invoices/${draft.id}/void`, { method: 'POST' });
    assert.equal(voided.status, 200);
    assert.equal(voided.body.invoice.status, 'void');
  });

  test('a draft can move to another customer, never to a supplier', async () => {
    const { body } = await call('/invoices', { method: 'POST', body: { contactId: practice.id, lines: [{ priceItemId: crown.id }] } });
    const other = (await call('/contacts?q=clinic')).body.contacts[0];
    const moved = await call(`/invoices/${body.invoice.id}`, { method: 'PATCH', body: { contactId: other.id } });
    assert.equal(moved.body.invoice.contact.name, 'Another Clinic');
    const refused = await call(`/invoices/${body.invoice.id}`, { method: 'PATCH', body: { contactId: supplier.id } });
    assert.equal(refused.status, 400);
  });

  test('a bad body or id answers 400 or 404, never 500', async () => {
    const cases = [
      [{ lines: [] }, 'no contact'],
      [{ contactId: 'nope', lines: [] }, 'contact id not an id'],
      [{ contactId: MISSING, lines: [] }, 'unknown contact'],
      [{ contactId: practice.id, lines: 'x' }, 'lines not a list'],
      [{ contactId: practice.id, lines: [{ description: 'Thing', unitAmountCents: 1.5 }] }, 'fractional cents'],
      [{ contactId: practice.id, lines: [{ description: 'Thing', unitAmountCents: 100, quantity: 0 }] }, 'zero quantity'],
      [{ contactId: practice.id, lines: [{ description: 'Thing', unitAmountCents: 100, taxCode: 'VAT' }] }, 'unknown tax code'],
      [{ contactId: practice.id, lines: [{ priceItemId: MISSING }] }, 'unknown price item'],
      [{ contactId: practice.id, dueDate: '2026-02-30', lines: [] }, 'impossible date'],
      [{ contactId: practice.id, organisationId: 'nope', lines: [] }, 'organisation not an id'],
    ];
    for (const [body, why] of cases) {
      const res = await call('/invoices', { method: 'POST', body });
      assert.equal(res.status, 400, why);
      assert.equal(res.body.ok, false, why);
    }
    const unknownOrg = await call('/invoices', { method: 'POST', body: { contactId: practice.id, organisationId: MISSING } });
    assert.equal(unknownOrg.status, 404);

    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/invoicing/invoices`, {
        method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: '{not json',
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, 'invalid');
    } finally {
      server.close();
    }

    assert.equal((await call(`/invoices/${MISSING}`)).status, 404);
    assert.equal((await call('/invoices/not-an-id')).status, 404);
    assert.equal((await call(`/invoices/${MISSING}/issue`, { method: 'POST', body: {} })).status, 404);
    assert.equal((await call('/invoices?status=paid')).status, 400);
    assert.equal((await call('/invoices?limit=0')).status, 400);
    assert.equal((await call(`/jobs/${MISSING}/draft`, { method: 'POST', body: {} })).status, 404);
  });

  test('the list filters by status and text, newest first, with counts', async () => {
    const make = (reference) => call('/invoices', { method: 'POST', body: { contactId: practice.id, reference, lines: [{ priceItemId: crown.id }] } });
    const first = (await make('SEARCH-A')).body.invoice;
    const second = (await make('SEARCH-B')).body.invoice;
    const { number } = (await call(`/invoices/${first.id}/issue`, { method: 'POST', body: {} })).body.invoice;

    const found = await call('/invoices?q=search-');
    assert.deepEqual(found.body.invoices.map((i) => i.id), [second.id, first.id]);
    assert.equal(found.body.invoices[0].contactName, 'Example Practice');
    assert.deepEqual((await call('/invoices?q=search-&status=issued')).body.invoices.map((i) => i.id), [first.id]);
    const byNumber = await call(`/invoices?q=${encodeURIComponent(number)}`);
    assert.deepEqual(byNumber.body.invoices.map((i) => i.id), [first.id]);
    assert.ok((await call('/invoices?q=another%20clinic')).body.invoices.length >= 1, 'matches the contact name');
    assert.deepEqual((await call('/invoices?q=%25')).body.invoices, [], 'a wildcard is matched literally');

    const all = await call('/invoices');
    const { counts } = all.body;
    assert.equal(counts.draft, all.body.invoices.filter((i) => i.status === 'draft').length);
    assert.equal(counts.issued, all.body.invoices.filter((i) => i.status === 'issued').length);
    assert.equal(counts.void, 1);
    assert.equal((await call('/invoices?limit=1')).body.invoices.length, 1);
  });

  test('jobs list by view; a job drafts its invoice after the live check, and the invoice shows the job', async () => {
    const job = await observeJob(handle.db, lab.id, {
      sourceSystem: 'worksystem', sourceJobRef: 'JOB-1', caseRef: 'CASE-JOB-1', contactId: practice.id, practitioner: 'Dr Example', shippedOn: '2026-10-17', lines: [{ itemCode: 'CRN' }],
    });
    await recordAccountingEvidence(handle.db, lab.id, job.id, { state: 'not_found', actor: 'user:test' });
    await observeJob(handle.db, lab.id, { sourceSystem: 'worksystem', sourceJobRef: 'JOB-2', contactId: practice.id, lines: [{ itemCode: 'CRN' }] });

    const listed = await call('/jobs');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.counts.ready, 1);
    assert.equal(listed.body.counts.pending, 1);
    const ready = await call('/jobs?view=ready');
    assert.deepEqual(ready.body.jobs.map((j) => [j.sourceJobRef, j.contactName, j.view, j.totalCents]), [['JOB-1', 'Example Practice', 'ready', 24200]]);
    assert.deepEqual((await call('/jobs?view=pending')).body.jobs[0].reasons, ['the accounting system was not checked']);
    assert.equal((await call('/jobs?view=nope')).status, 400);

    const staffDraft = await call(`/jobs/${job.id}/draft`, { method: 'POST', token: staffToken, body: {} });
    assert.equal(staffDraft.status, 403);

    const noCheck = await request(appWithoutCheck, `/api/invoicing/jobs/${job.id}/draft`, { token: ownerToken, method: 'POST', body: {} });
    assert.equal(noCheck.status, 409);
    assert.equal(noCheck.body.code, 'live_check_unavailable');

    const drafted = await call(`/jobs/${job.id}/draft`, { method: 'POST', body: {} });
    assert.equal(drafted.status, 201);
    assert.deepEqual(checked, [[lab.id, 'JOB-1']]);
    assert.equal(drafted.body.invoice.reference, 'CASE-JOB-1');
    assert.deepEqual(drafted.body.invoice.job, {
      id: job.id, sourceSystem: 'worksystem', sourceJobRef: 'JOB-1', caseRef: 'CASE-JOB-1', practitioner: 'Dr Example', shippedOn: '2026-10-17',
    });
    const inList = (await call('/invoices?q=CASE-JOB-1')).body.invoices;
    assert.equal(inList[0].job.sourceJobRef, 'JOB-1');
    const after = await call('/jobs?view=drafted');
    assert.equal(after.body.jobs[0].invoiceId, drafted.body.invoice.id);

    const again = await call(`/jobs/${job.id}/draft`, { method: 'POST', body: {} });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'not_ready');
    assert.ok(again.body.details.reasons.includes('the job already has an invoice'));
  });

  test('with more than one organisation, a request must name one', async () => {
    const other = await createOrganisation(handle.db, { name: 'Other Lab' });
    const unnamed = await call('/invoices');
    assert.equal(unnamed.status, 400);
    assert.equal(unnamed.body.code, 'organisation_required');
    const named = await call(`/invoices?organisationId=${other.id}`);
    assert.equal(named.status, 200);
    assert.deepEqual(named.body.invoices, []);
    // Another organisation's invoice is not found from this one.
    const mine = (await call(`/invoices?organisationId=${lab.id}&limit=1`)).body.invoices[0];
    assert.equal((await call(`/invoices/${mine.id}?organisationId=${other.id}`)).status, 404);
  });

  test('invoicing settings: everyone reads them, an owner or admin changes them, a customer can override them', async () => {
    const read = await call(`/settings?organisationId=${lab.id}`, { token: staffToken });
    assert.equal(read.status, 200);
    assert.equal(read.body.settings.sendMode, 'accounting_draft');
    assert.equal(read.body.settings.autoDraft, true);
    assert.equal((await call('/settings', { method: 'PUT', token: staffToken, body: { organisationId: lab.id, paymentTermsDays: 7 } })).status, 403);
    const changed = await call('/settings', { method: 'PUT', body: { organisationId: lab.id, sendMode: 'approve_and_email', paymentTermsDays: 7 } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.settings.sendMode, 'approve_and_email');
    assert.equal((await call('/settings', { method: 'PUT', body: { organisationId: lab.id, sendMode: 'fax' } })).status, 400);

    const own = await call(`/contacts/${practice.id}/billing`, { method: 'PUT', body: { organisationId: lab.id, sendMode: 'accounting_draft', billable: false } });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.effective.sendMode, 'accounting_draft');
    assert.equal(own.body.effective.paymentTermsDays, 7);
    assert.equal((await call(`/contacts/${supplier.id}/billing`, { method: 'PUT', body: { organisationId: lab.id, billable: false } })).status, 400);
    assert.equal((await call(`/contacts/${MISSING}/billing?organisationId=${lab.id}`)).status, 404);

    // A job with no invoice lists the rules it waits on.
    const jobs = await call(`/jobs?organisationId=${lab.id}&view=pending`);
    assert.ok(jobs.body.jobs.every((j) => j.waitingFor.includes('the customer is not billable')), JSON.stringify(jobs.body.jobs.map((j) => j.waitingFor)));
  });
});
