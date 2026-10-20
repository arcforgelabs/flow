import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { draftInvoiceForObligation, observeJob, recordAccountingEvidence, setReady } from '../server/core/ledger.js';
import { linkRecord } from '../server/core/links.js';
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
  // What the work system answers when Flow reads one job (readWorkItem).
  const workReads = new Map();

  function invoicingApp({ integrations = null } = {}) {
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    return createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations, log: quiet, buttonCooldowns: false });
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
    // A work system that lists its jobs for the Jobs board (listWork).
    integrations.register({
      id: 'worksystem',
      name: 'Work system',
      capabilities: {
        health: async () => ({ ok: true }),
        readWorkItem: async ({ sourceJobRef }) => (workReads.has(sourceJobRef)
          ? { state: 'read', item: { ledgerJob: { ...workReads.get(sourceJobRef), observedAt: new Date().toISOString() }, clientId: 'CLIENT-1' } }
          : { state: 'failed', reason: 'not found' }),
        listWork: async () => ({
          items: [
            { sourceSystem: 'worksystem', sourceJobRef: 'JOB-1', caseRef: 'CASE-JOB-1', status: 'Shipped', clientName: 'Example Practice Pty', practitioner: 'Dr Example', dueOn: '2026-10-20', lines: [], totalCents: 22000 },
            { sourceSystem: 'worksystem', sourceJobRef: 'JOB-9', caseRef: 'CASE-JOB-9', status: 'In Production', clientName: 'Work System Clinic', practitioner: 'Dr Sample', dueOn: '2026-10-25', lines: [{ code: 'BRG', description: 'Bridge', amountCents: 50000 }, { code: 'ZZZ', description: 'Other', amountCents: 100 }], totalCents: 50100 },
          ],
          statuses: [{ label: 'Shipped', firstSeenAt: '2026-10-01T00:00:00.000Z' }, { label: 'In Production', firstSeenAt: '2026-10-02T00:00:00.000Z' }],
        }),
      },
    });
    integrations.enable('worksystem');
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
    // Each invoice is on one tab. With no accounting system, an issued
    // invoice is Approved.
    assert.equal(counts.pending + counts.ready, all.body.invoices.filter((i) => i.status === 'draft').length);
    assert.equal(counts.approved, all.body.invoices.filter((i) => i.status === 'issued').length);
    assert.equal(counts.void, 1);
    assert.ok(all.body.invoices.every((i) => i.tab === { draft: i.problems.length ? 'pending' : 'ready', issued: 'approved', void: 'void' }[i.status]));
    assert.equal((await call('/invoices?limit=1')).body.invoices.length, 1);
  });

  test('jobs list by view; a job drafts its invoice after the live check, and the invoice shows the job', async () => {
    const job = await observeJob(handle.db, lab.id, {
      sourceSystem: 'worksystem', sourceJobRef: 'JOB-1', caseRef: 'CASE-JOB-1', contactId: practice.id, practitioner: 'Dr Example', shippedOn: '2026-10-17', lines: [{ itemCode: 'CRN' }],
    });
    await recordAccountingEvidence(handle.db, lab.id, job.id, { state: 'not_found', actor: 'user:test' });
    const second = await observeJob(handle.db, lab.id, { sourceSystem: 'worksystem', sourceJobRef: 'JOB-2', contactId: practice.id, lines: [{ itemCode: 'CRN' }] });

    // Both are in work until someone marks them ready to invoice.
    assert.equal((await call('/jobs')).body.counts.in_work, 2);
    assert.equal((await call(`/jobs/${job.id}/ready`, { method: 'POST', token: staffToken, body: { ready: 'yes' } })).status, 400);
    for (const id of [job.id, second.id]) {
      const marked = await call(`/jobs/${id}/ready`, { method: 'POST', token: staffToken, body: { ready: true } });
      assert.equal(marked.status, 200, JSON.stringify(marked.body));
    }

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

    // With no accounting system connected, Flow's own records are the check:
    // a ready job that no accounting system checked drafts.
    const local = await observeJob(handle.db, lab.id, {
      sourceSystem: 'worksystem', sourceJobRef: 'JOB-LOCAL', contactId: practice.id, lines: [{ itemCode: 'CRN' }],
    });
    await setReady(handle.db, lab.id, local.id, { actor: 'person:test' });
    const withXero = await call(`/jobs/${local.id}/draft`, { method: 'POST', body: {} });
    assert.equal(withXero.status, 409);
    assert.ok(withXero.body.details.reasons.includes('the accounting system was not checked'));
    const noCheck = await request(appWithoutCheck, `/api/invoicing/jobs/${local.id}/draft`, { token: ownerToken, method: 'POST', body: {} });
    assert.equal(noCheck.status, 201, JSON.stringify(noCheck.body));
    assert.deepEqual(checked, []);

    const drafted = await call(`/jobs/${job.id}/draft`, { method: 'POST', body: {} });
    assert.equal(drafted.status, 201);
    assert.deepEqual(checked, [[lab.id, 'JOB-1']]);
    // The Reference rule's text, never the work system's case id.
    assert.equal(drafted.body.invoice.reference, 'Dr Example');
    assert.deepEqual(drafted.body.invoice.job, {
      id: job.id, sourceSystem: 'worksystem', sourceJobRef: 'JOB-1', sourceInvoiceRef: null, caseRef: 'CASE-JOB-1', practitioner: 'Dr Example', shippedOn: '2026-10-17',
      systemName: 'Work system', link: null,
    });
    // The Linked card lists each connected system.
    assert.deepEqual(drafted.body.invoice.linksTo.map((s) => [s.id, s.kind]), [['worksystem', 'work']]);
    const inList = (await call('/invoices?q=Dr%20Example')).body.invoices;
    assert.equal(inList[0].job.sourceJobRef, 'JOB-1');
    const after = await call('/jobs?view=drafted');
    assert.equal(after.body.jobs.find((j) => j.id === job.id).invoiceId, drafted.body.invoice.id);

    const again = await call(`/jobs/${job.id}/draft`, { method: 'POST', body: {} });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'not_ready');
    assert.ok(again.body.details.reasons.includes('the job already has an invoice'));
  });

  test('the Jobs board lists the work system jobs by status, each with its invoice, and a job has its activity', async () => {
    const board = await call('/board', { token: staffToken });
    assert.equal(board.status, 200, JSON.stringify(board.body));
    assert.deepEqual(board.body.statuses.map((s) => s.label), ['Shipped', 'In Production']);
    const [shipped, inLab] = board.body.jobs;
    // A linked client shows as the Flow customer; the work system's name stays for the panel.
    assert.deepEqual([shipped.sourceJobRef, shipped.status, shipped.clientName, shipped.workClientName], ['JOB-1', 'Shipped', 'Example Practice', 'Example Practice Pty']);
    assert.equal(shipped.obligation.view, 'drafted');
    assert.equal(shipped.obligation.invoiceStatus, 'draft');
    assert.equal(shipped.obligation.invoiceView, 'ready');
    assert.deepEqual(shipped.obligation.invoiceProblems, []);
    assert.equal(shipped.totalCents, 24200, 'the ledger total wins over the work system copy');
    assert.deepEqual(shipped.lines, [{ code: 'CRN', description: 'Crown', amountCents: 22000, mapped: true }]);
    // A job still in the lab has no obligation; its lines map by price code.
    assert.deepEqual([inLab.clientName, inLab.obligation], ['Work System Clinic', null]);
    assert.deepEqual(inLab.lines.map((l) => [l.code, l.mapped]), [['BRG', true], ['ZZZ', false]]);

    // With no work system that lists jobs, the board shows the ledger's jobs.
    const ledgerOnly = await request(appWithoutCheck, '/api/invoicing/board', { token: ownerToken });
    assert.equal(ledgerOnly.status, 200);
    const second = ledgerOnly.body.jobs.find((j) => j.sourceJobRef === 'JOB-2');
    assert.equal(second.obligation.view, 'ready', 'with no accounting system, Flow\'s own records are the check');
    assert.equal(second.clientName, 'Example Practice');

    const activity = await call(`/jobs/${shipped.obligation.id}/activity`, { token: staffToken });
    assert.equal(activity.status, 200);
    // Newest first, and only who did it: a person, an automation or a system.
    assert.deepEqual(activity.body.events.slice(0, 2).map((e) => [e.kind, e.by]), [['draft_refused', 'person'], ['drafted', 'person']]);
    assert.equal(activity.body.events.at(-1).kind, 'observed');
    assert.ok(activity.body.events.every((e) => Object.keys(e).sort().join() === 'by,createdAt,kind'));
    assert.equal((await call(`/jobs/${MISSING}/activity`)).status, 404);
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

    // Automations: everyone reads them, by the screen that shows them; an
    // owner or admin changes them.
    const seazona = await call(`/automations?organisationId=${lab.id}&place=seazona`, { token: staffToken });
    assert.deepEqual(seazona.body.automations.map((a) => [a.key, a.config]), [
      ['map_lines', { steps: ['same_code', 'account', 'saved', 'catalog_name', 'price_alias', 'catalog_name_price', 'catalog_score', 'alias'], zeroLines: 'keep', linePrice: 'work' }],
      ['mark_ready_from_work_status', { statuses: ['shipped', 'delivered'] }]]);
    const statuses = await call(`/work-statuses?organisationId=${lab.id}`, { token: staffToken });
    assert.equal(statuses.status, 200);
    assert.ok(Array.isArray(statuses.body.statuses));
    assert.equal((await call('/automations/draft_when_ready', { method: 'PUT', token: staffToken, body: { organisationId: lab.id, enabled: false } })).status, 403);
    const off = await call('/automations/draft_when_ready', { method: 'PUT', body: { organisationId: lab.id, enabled: false } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.automation.enabled, false);
    assert.equal((await call('/automations/nothing', { method: 'PUT', body: { organisationId: lab.id, enabled: true } })).status, 404);

    // A job with no invoice lists the rules it waits on.
    const jobs = await call(`/jobs?organisationId=${lab.id}&view=pending`);
    assert.ok(jobs.body.jobs.every((j) => j.waitingFor.includes('rule "Customer not billable": not drafted by rule')), JSON.stringify(jobs.body.jobs.map((j) => j.waitingFor)));
  });

  test('invoice rules: everyone reads them and their menus, an owner or admin changes them', async () => {
    const read = await call(`/rules?organisationId=${lab.id}`, { token: staffToken });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.ok(read.body.rules.some((r) => r.name === 'Old job' && r.starter));
    const fields = await call(`/rule-fields?organisationId=${lab.id}`, { token: staffToken });
    assert.equal(fields.status, 200);
    assert.ok(fields.body.fields.some((f) => f.key === 'line_share' && f.tests.includes('is_not')));
    assert.ok(fields.body.options.customers.some((c) => c.value === practice.id));
    assert.ok(fields.body.options.customers.every((c) => c.value !== supplier.id));
    assert.ok(Array.isArray(fields.body.options.items));

    const rule = { organisationId: lab.id, name: 'Big jobs', conditions: [{ field: 'job_total', test: 'more_than', value: 5000 }], action: { kind: 'wait' } };
    assert.equal((await call('/rules', { method: 'POST', token: staffToken, body: rule })).status, 403);
    const made = await call('/rules', { method: 'POST', body: rule });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.rule.name, 'Big jobs');
    assert.equal((await call(`/rules?organisationId=${lab.id}`, { method: 'POST', body: { ...rule, action: { kind: 'email' } } })).status, 400);
    assert.equal((await call('/rules', { method: 'POST', body: { ...rule, colour: 'red' } })).status, 400);

    const off = await call(`/rules/${made.body.rule.id}?organisationId=${lab.id}`, { method: 'PUT', body: { enabled: false } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.rule.enabled, false);
    assert.equal((await call(`/rules/${MISSING}?organisationId=${lab.id}`, { method: 'PUT', body: { enabled: false } })).status, 404);
    assert.equal((await call(`/rules/${made.body.rule.id}?organisationId=${lab.id}`, { method: 'DELETE', token: staffToken })).status, 403);
    assert.equal((await call(`/rules/${made.body.rule.id}?organisationId=${lab.id}`, { method: 'DELETE' })).status, 200);
    assert.ok((await call(`/rules?organisationId=${lab.id}`)).body.rules.every((r) => r.id !== made.body.rule.id));
  });
  test('price codes: unmapped line labels list with counts; an owner or admin saves a mapping', async () => {
    await observeJob(handle.db, lab.id, {
      sourceSystem: 'worksystem', sourceJobRef: 'JOB-MAP', contactId: practice.id,
      lines: [{ itemCode: '9001', label: 'night splint', description: 'Night Splint', unitAmountCents: 15000, taxCode: 'GST_FREE' }],
    });
    const labels = await call(`/line-labels?organisationId=${lab.id}`, { token: staffToken });
    assert.equal(labels.status, 200, JSON.stringify(labels.body));
    const label = labels.body.labels.find((l) => l.label === 'night splint');
    assert.deepEqual([label.lines, label.unmapped, label.sample, label.unitAmountCents], [1, 1, 'Night Splint', 15000]);

    const mapping = { organisationId: lab.id, kind: 'saved', label: 'night splint', unitAmountCents: 15000, itemCode: 'CRN' };
    assert.equal((await call('/line-mappings', { method: 'POST', token: staffToken, body: mapping })).status, 403);
    const saved = await call('/line-mappings', { method: 'POST', body: mapping });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal((await call('/line-mappings', { method: 'POST', body: mapping })).status, 409);
    const listed = await call(`/line-mappings?organisationId=${lab.id}`, { token: staffToken });
    assert.deepEqual(listed.body.mappings.map((m) => [m.kind, m.label, m.itemCode]), [['saved', 'night splint', 'CRN']]);
    assert.equal((await call(`/line-mappings/${saved.body.mapping.id}?organisationId=${lab.id}`, { method: 'DELETE' })).status, 200);
  });
  test('a draft whose job changed shows was and now, cannot be issued, and issues after the change is adopted', async () => {
    const report = { sourceSystem: 'worksystem', sourceJobRef: 'JOB-CHANGED', contactId: practice.id, sourceStatus: 'Shipped', lines: [{ itemCode: 'CRN' }] };
    const job = await observeJob(handle.db, lab.id, report);
    await recordAccountingEvidence(handle.db, lab.id, job.id, { state: 'not_found', actor: 'user:test' });
    const { invoice } = await draftInvoiceForObligation(handle.db, lab.id, job.id, { actor: 'user:test', liveCheck: async () => ({ state: 'not_found' }) });
    await observeJob(handle.db, lab.id, { ...report, lines: [{ itemCode: 'CRN', quantity: 2 }] });

    const open = await request(appWithoutCheck, `/api/invoicing/invoices/${invoice.id}?organisationId=${lab.id}`, { token: ownerToken });
    assert.equal(open.status, 200);
    const { jobChange } = open.body.invoice;
    assert.equal(jobChange.canAdopt, true);
    assert.deepEqual(jobChange.lines.map((l) => [l.change, l.fields]), [['changed', ['quantity']]]);
    assert.equal(jobChange.link, null, 'a work system with no job link gives none');

    const refused = await request(appWithoutCheck, `/api/invoicing/invoices/${invoice.id}/issue`, { token: ownerToken, method: 'POST', body: { organisationId: lab.id } });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /the job changed after its invoice was made\. Nothing was approved\./);

    const adopted = await request(appWithoutCheck, `/api/invoicing/jobs/${job.id}/use-new-lines`, { token: ownerToken, method: 'POST', body: { organisationId: lab.id } });
    assert.equal(adopted.status, 200);
    assert.equal(adopted.body.invoice.jobChange, null);
    const issued = await request(appWithoutCheck, `/api/invoicing/invoices/${invoice.id}/issue`, { token: ownerToken, method: 'POST', body: { organisationId: lab.id } });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(issued.body.invoice.status, 'issued');
  });

  test('Recheck reads the job from the work system again; a fixed job ends the problem', async () => {
    const report = { sourceSystem: 'worksystem', sourceJobRef: 'JOB-RECHECK', contactId: practice.id, sourceStatus: 'Shipped', lines: [{ itemCode: 'CRN' }] };
    const job = await observeJob(handle.db, lab.id, report);
    await recordAccountingEvidence(handle.db, lab.id, job.id, { state: 'not_found', actor: 'user:test' });
    const { invoice } = await draftInvoiceForObligation(handle.db, lab.id, job.id, { actor: 'user:test', liveCheck: async () => ({ state: 'not_found' }) });
    // The work system was wrong for a while, then fixed there.
    await observeJob(handle.db, lab.id, { ...report, lines: [{ itemCode: 'CRN', quantity: 3 }] });
    assert.ok((await call(`/invoices/${invoice.id}?organisationId=${lab.id}`)).body.invoice.jobChange);

    const unread = await request(appWithoutCheck, `/api/invoicing/jobs/${job.id}/recheck`, { token: ownerToken, method: 'POST', body: { organisationId: lab.id } });
    assert.equal(unread.status, 409, 'no work system: nothing to read');
    await linkRecord(handle.db, lab.id, { entity: 'contact', flowId: practice.id, system: 'worksystem', externalId: 'CLIENT-1', matchedBy: 'person' });
    workReads.set('JOB-RECHECK', report);
    const rechecked = await call(`/jobs/${job.id}/recheck`, { method: 'POST', token: staffToken, body: { organisationId: lab.id } });
    assert.equal(rechecked.status, 200, JSON.stringify(rechecked.body));
    assert.equal(rechecked.body.outcome, 'read');
    assert.equal(rechecked.body.invoice.jobChange, null, 'the job matches the draft again');
    assert.notEqual(rechecked.body.invoice.view, 'problem');
    const again = await call(`/jobs/${job.id}/recheck`, { method: 'POST', body: { organisationId: lab.id } });
    assert.equal(again.body.outcome, 'fresh', 'a second click soon after makes no call');
  });

  test('Accept change takes the work system lines even when the draft changed too', async () => {
    const report = { sourceSystem: 'worksystem', sourceJobRef: 'JOB-ACCEPT', contactId: practice.id, sourceStatus: 'Shipped', lines: [{ itemCode: 'CRN' }] };
    const job = await observeJob(handle.db, lab.id, report);
    await recordAccountingEvidence(handle.db, lab.id, job.id, { state: 'not_found', actor: 'user:test' });
    const { invoice } = await draftInvoiceForObligation(handle.db, lab.id, job.id, { actor: 'user:test', liveCheck: async () => ({ state: 'not_found' }) });
    const draft = (await call(`/invoices/${invoice.id}?organisationId=${lab.id}`)).body.invoice;
    const extra = { description: 'Shipping', quantity: 1, unitAmountCents: 1500, taxCode: 'GST', priceItemId: crown.id };
    const saved = await call(`/invoices/${invoice.id}`, { method: 'PATCH', body: { organisationId: lab.id, lines: [...draft.lines, extra] } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    await observeJob(handle.db, lab.id, { ...report, lines: [{ itemCode: 'CRN' }, { itemCode: 'BRG' }] });

    const open = (await call(`/invoices/${invoice.id}?organisationId=${lab.id}`)).body.invoice;
    assert.deepEqual([open.jobChange.canAdopt, open.jobChange.canAccept], [false, true]);
    assert.equal(open.problems.find((p) => p.code === 'job_review').short, 'Line 2 added');
    const plain = await call(`/jobs/${job.id}/use-new-lines`, { method: 'POST', body: { organisationId: lab.id } });
    assert.equal(plain.status, 409);
    const accepted = await call(`/jobs/${job.id}/use-new-lines`, { method: 'POST', body: { organisationId: lab.id, accept: true } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.invoice.jobChange, null);
    assert.equal(accepted.body.invoice.lines.length, 2);
  });
});
