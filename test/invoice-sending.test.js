import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, reviseInvoice } from '../server/core/invoices.js';
import { draftProblems, invoiceViews, sendAgain, sendAllReady, sendQueued } from '../server/core/sending.js';
import { invoices } from '../server/db/schema.js';
import { createRegistry } from '../server/integrations/port.js';
import { createXeroAdapter } from '../server/integrations/xero/index.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Ready, Problem and Send all ready (server/core/sending.js). The accounting
// system is a fake. Synthetic data only (CONTRIBUTING.md).

const quiet = { info() {}, warn() {}, error() {} };
const ISSUE_DATE = '2026-10-19';

test('Flow checks its own draft: lines, an amount, a price item on every line', () => {
  assert.deepEqual(draftProblems({ totalCents: 0 }, []).map((p) => p.code), ['no_lines']);
  assert.deepEqual(draftProblems({ totalCents: 0 }, [{ position: 1, priceItemId: 'x' }]).map((p) => p.code), ['no_amount']);
  assert.deepEqual(draftProblems({ totalCents: 100 }, [{ position: 1, priceItemId: 'x' }, { position: 2, priceItemId: null }]),
    [{ code: 'line_no_item', message: 'Line 2 has no price item.' }]);
  assert.deepEqual(draftProblems({ totalCents: 100 }, [{ position: 1, priceItemId: 'x' }]), []);
});

test('the Xero adapter offers what Send all ready needs', () => {
  const { capabilities } = createXeroAdapter();
  for (const name of ['pushInvoices', 'checkDrafts', 'sendStatus']) assert.equal(typeof capabilities[name], 'function', name);
});

// A fake accounting system. `outcomes` maps an invoice id to the outcome its
// push gets; the default is created.
function fakeAccounting() {
  const fake = {
    status: { connected: true, writesAllowed: true },
    checks: new Map(),
    outcomes: new Map(),
    pushed: [],
  };
  fake.adapter = {
    id: 'accounts',
    name: 'Accounts',
    capabilities: {
      health: async () => ({ ok: true }),
      sendStatus: async () => fake.status,
      checkDrafts: async ({ invoiceIds }) => (fake.status.connected ? new Map(invoiceIds.map((id) => [id, fake.checks.get(id) ?? []])) : null),
      pushInvoices: async ({ invoiceIds, pushedBy }) => {
        fake.pushed.push(...invoiceIds.map((id) => [id, pushedBy]));
        return {
          invoices: invoiceIds.map((invoiceId) => {
            const outcome = fake.outcomes.get(invoiceId) ?? 'created';
            if (outcome === 'failed') return { invoiceId, outcome, error: { code: 'xero_contact_missing', message: 'No Xero contact is named "Example Practice".' } };
            if (outcome === 'not_tried') return { invoiceId, outcome, error: { code: 'xero_rate_limited', message: 'Wait.' } };
            return { invoiceId, outcome };
          }),
        };
      },
    },
  };
  return fake;
}

describe('ready, problem and send', { skip: skipWithoutDatabase }, () => {
  let handle;
  let lab;
  let practice;
  let crown;
  let owner;

  let labs = 0;

  before(async () => {
    handle = await freshDatabase();
    owner = await seedFirstOwner(handle.db, 'owner@example.test');
  });
  after(async () => handle?.close());
  // Each test has its own lab, so its invoices are the only ones in view.
  beforeEach(async () => {
    lab = await createOrganisation(handle.db, { name: `Example Lab ${++labs}` });
    practice = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Example Practice' });
    crown = await createPriceItem(handle.db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
  });

  const draft = (lines) => createDraftInvoice(handle.db, lab.id, { contactId: practice.id, reference: 'CASE-1', lines });
  const good = () => draft([{ priceItemId: crown.id, quantity: 1 }]);
  const row = async (id) => (await handle.db.select().from(invoices).where(eq(invoices.id, id)))[0];

  test('every draft is ready or has a problem; the accounting system adds its own', async () => {
    const ready = await good();
    const freeText = await draft([{ description: 'Something', quantity: 1, unitAmountCents: 1000, taxCode: 'GST' }]);
    const empty = await draft([]);
    const missing = await good();
    let views = await invoiceViews(handle.db, lab.id);
    assert.deepEqual(views.ready.sort(), [ready.id, missing.id].sort());
    assert.deepEqual(views.problems.get(freeText.id).map((p) => p.code), ['line_no_item']);
    assert.deepEqual(views.problems.get(empty.id).map((p) => p.code), ['no_lines']);

    const fake = fakeAccounting();
    fake.checks.set(missing.id, [{ code: 'xero_contact_missing', message: 'No Xero contact.' }]);
    views = await invoiceViews(handle.db, lab.id, { accounting: fake.adapter });
    assert.deepEqual(views.ready, [ready.id]);
    assert.deepEqual(views.problems.get(missing.id).map((p) => p.code), ['xero_contact_missing']);
  });

  test('with no accounting system, Send all ready issues the ready drafts only', async () => {
    const ready = await good();
    const problem = await draft([]);
    const result = await sendAllReady(handle.db, lab.id, { personId: owner.id, issueDate: ISSUE_DATE });
    assert.deepEqual(result, { issued: 1, queued: 0, remaining: 0 });
    assert.equal((await row(ready.id)).status, 'issued');
    assert.equal((await row(ready.id)).sendState, null);
    assert.equal((await row(problem.id)).status, 'draft');
  });

  test('an accounting system that is not connected or takes no writes stops the send before anything is issued', async () => {
    const ready = await good();
    const fake = fakeAccounting();
    fake.status = { connected: false, writesAllowed: true };
    await assert.rejects(sendAllReady(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE }), { code: 'accounting_not_connected' });
    fake.status = { connected: true, writesAllowed: false };
    await assert.rejects(sendAllReady(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE }), { code: 'accounting_writes_off' });
    assert.equal((await row(ready.id)).status, 'draft');
    assert.equal((await row(ready.id)).sendState, null);
  });

  test('Send all ready issues and queues; the worker sends; a refusal is a problem until sent again', async () => {
    const fake = fakeAccounting();
    const one = await good();
    const two = await good();
    const three = await good();
    fake.outcomes.set(two.id, 'failed');
    fake.outcomes.set(three.id, 'not_tried');

    const result = await sendAllReady(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE });
    assert.deepEqual(result, { issued: 3, queued: 3, remaining: 0 });
    for (const id of [one.id, two.id, three.id]) {
      const r = await row(id);
      assert.equal(r.status, 'issued');
      assert.ok(r.number);
      assert.equal(r.sendState, 'queued');
    }
    let views = await invoiceViews(handle.db, lab.id, { accounting: fake.adapter });
    assert.equal(views.sending.size, 3);
    assert.deepEqual(views.ready, []);

    const sent = await sendQueued(handle.db, lab.id, { accounting: fake.adapter });
    assert.deepEqual(sent, { sent: 1, failed: 1, waiting: 1 });
    assert.ok(fake.pushed.every(([, by]) => by === owner.id));
    assert.equal((await row(one.id)).sendState, 'sent');
    assert.equal((await row(three.id)).sendState, 'queued');
    const failed = await row(two.id);
    assert.equal(failed.sendState, 'failed');
    assert.equal(failed.sendError.code, 'xero_contact_missing');
    views = await invoiceViews(handle.db, lab.id, { accounting: fake.adapter });
    assert.deepEqual(views.problems.get(two.id).map((p) => p.code), ['xero_contact_missing']);

    fake.outcomes.delete(two.id);
    fake.outcomes.delete(three.id);
    assert.deepEqual(await sendAgain(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id }), { queued: 1 });
    assert.deepEqual(await sendQueued(handle.db, lab.id, { accounting: fake.adapter }), { sent: 2, failed: 0, waiting: 0 });
    views = await invoiceViews(handle.db, lab.id, { accounting: fake.adapter });
    assert.equal(views.problems.size, 0);
    assert.equal(views.sending.size, 0);

    // A revision starts again: the last send no longer applies.
    await reviseInvoice(handle.db, lab.id, two.id);
    assert.equal((await row(two.id)).sendState, null);
  });
});

describe('Send all ready over the API', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let ownerToken;
  let lab;
  let practice;
  let crown;
  const fake = fakeAccounting();

  before(async () => {
    handle = await freshDatabase();
    const clerk = fakeClerk();
    lab = await createOrganisation(handle.db, { name: 'Example Lab' });
    practice = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Example Practice' });
    crown = await createPriceItem(handle.db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
    await seedFirstOwner(handle.db, 'owner@example.test');
    ownerToken = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    const integrations = createRegistry({ log: quiet, env: {} });
    integrations.register(fake.adapter);
    integrations.enable('accounts');
    await integrations.start(handle.db);
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    app = createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations, log: quiet });
  });
  after(async () => handle?.close());

  const call = (path, options = {}) => request(app, `/api/invoicing${path}`, { token: ownerToken, ...options });

  test('the list counts Ready and Problem, and one press sends every ready invoice', async () => {
    const ready = await createDraftInvoice(handle.db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id, quantity: 1 }] });
    const problem = await createDraftInvoice(handle.db, lab.id, { contactId: practice.id, lines: [] });

    let res = await call('/invoices?status=ready');
    assert.equal(res.status, 200);
    assert.equal(res.body.counts.ready, 1);
    assert.equal(res.body.counts.problem, 1);
    assert.equal(res.body.sendsTo, 'Accounts');
    assert.deepEqual(res.body.invoices.map((i) => [i.id, i.view]), [[ready.id, 'ready']]);
    res = await call('/invoices?status=problem');
    assert.deepEqual(res.body.invoices.map((i) => [i.id, i.problems[0].code]), [[problem.id, 'no_lines']]);
    assert.equal((await call('/invoices?status=other')).status, 400);

    res = await call('/invoices/send-ready', { method: 'POST', body: { issueDate: ISSUE_DATE } });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.issued, res.body.queued, res.body.remaining], [1, 1, 0]);
    res = await call('/invoices?status=issued');
    assert.deepEqual(res.body.invoices.map((i) => [i.id, i.view]), [[ready.id, 'sending']]);

    fake.status = { connected: false, writesAllowed: true };
    res = await call('/invoices/send-ready', { method: 'POST', body: {} });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'accounting_not_connected');
    fake.status = { connected: true, writesAllowed: true };
    assert.equal((await call('/invoices/send-again', { method: 'POST', body: { invoiceIds: ['nope'] } })).status, 400);
  });
});
