import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, reviseInvoice, updateDraftInvoice } from '../server/core/invoices.js';
import { observeJob } from '../server/core/ledger.js';
import { READ_BEFORE_ACT_MS, READS_PER_PASS } from '../server/core/read-before-act.js';
import { createSendWorker, draftProblems, invoiceViews, markNotReady, markReady, refusalReport, sendAgain, sendAllReady, sendQueued } from '../server/core/sending.js';
import { billingObligations, invoices } from '../server/db/schema.js';
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
    [{ code: 'line_no_item', message: 'Line 2 has no price item.', short: 'Line 2: no item', fields: ['line_item'], line: 2 }]);
  assert.deepEqual(draftProblems({ totalCents: 100 }, [{ position: 1, priceItemId: 'x' }]), []);
});

test('a refusal report names each invoice, its code and a short message, without a name or an email', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const message = 'Account code \'999\' is not a valid code for this document. See accounts@example.test for "Example Practice".';
  const one = refusalReport({
    failed: 1,
    refusals: [{ invoiceId: id, number: 'INV-0002', code: 'xero_validation_failed', message, contact: 'Example Practice', email: 'practice@example.test' }],
  });
  assert.equal(one, `[sending] the accounting system refused 1 invoice: INV-0002 (${id}) xero_validation_failed: Account code '999' is not a valid code for this document.`);
  assert.equal(one.includes('Example Practice'), false);
  assert.equal(one.includes('@'), false);

  const ids = [1, 2, 3, 4, 5, 6].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  const many = refusalReport({
    failed: ids.length,
    refusals: ids.map((invoiceId, index) => ({ invoiceId, number: `INV-000${index + 1}`, code: 'xero_validation_failed', message: 'Account code \'200\' is not a valid code.' })),
  });
  assert.equal(many.includes(ids[5]), false);
  assert.match(many, /^\[sending\] the accounting system refused 6 invoices: INV-0001 \(00000000-0000-4000-8000-000000000001\) xero_validation_failed: Account code '200' is not a valid code\.; .* and 1 more$/);
  assert.equal(many.includes('INV-0006'), false);
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
    errors: new Map(),
    // Each issued invoice's stage there (invoiceStages).
    stages: new Map(),
    pushed: [],
  };
  fake.adapter = {
    id: 'accounts',
    name: 'Accounts',
    capabilities: {
      health: async () => ({ ok: true }),
      sendStatus: async () => fake.status,
      invoiceStages: async () => new Map(fake.stages),
      checkDrafts: async ({ invoiceIds }) => (fake.status.connected ? new Map(invoiceIds.map((id) => [id, fake.checks.get(id) ?? []])) : null),
      pushInvoices: async ({ invoiceIds, pushedBy }) => {
        fake.pushed.push(...invoiceIds.map((id) => [id, pushedBy]));
        return {
          invoices: invoiceIds.map((invoiceId) => {
            const outcome = fake.outcomes.get(invoiceId) ?? 'created';
            if (outcome === 'failed') {
              const error = fake.errors.get(invoiceId) ?? { code: 'xero_contact_missing', message: 'No Xero contact is named "Example Practice".' };
              return { invoiceId, outcome, error };
            }
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

  // A ready invoice whose work-system report is old enough to be read again.
  const SEEN = new Date('2026-10-19T00:00:00.000Z');
  const LATER = new Date(SEEN.getTime() + READ_BEFORE_ACT_MS + 60_000);
  let jobs = 0;
  const invoicedJob = async () => {
    const invoice = await good();
    const ref = `JOB-${labs}-${++jobs}`;
    const obligation = await observeJob(handle.db, lab.id, {
      sourceSystem: 'works', sourceJobRef: ref, caseRef: ref, sourceStatus: 'Shipped', jobDate: '2026-10-15',
      lines: [{ itemCode: 'CRN', quantity: 1 }], observedAt: SEEN,
    });
    await handle.db.update(billingObligations).set({ invoiceId: invoice.id }).where(eq(billingObligations.id, obligation.id));
    return { invoice, ref };
  };
  const confirmed = (ref) => ({
    state: 'read',
    item: {
      ledgerJob: {
        sourceSystem: 'works', sourceJobRef: ref, caseRef: ref, sourceStatus: 'Shipped', jobDate: '2026-10-15',
        lines: [{ itemCode: 'CRN', quantity: 1 }], observedAt: LATER,
      },
    },
  });
  const workReader = (answer) => {
    const reads = [];
    const work = {
      id: 'works',
      capabilities: {
        readWorkItem: async ({ sourceJobRef }) => {
          reads.push(sourceJobRef);
          return answer(sourceJobRef);
        },
      },
    };
    return { work, reads };
  };
  const sendThese = (invoiceIds, work) => sendAllReady(handle.db, lab.id, {
    work, personId: owner.id, issueDate: ISSUE_DATE, invoiceIds, now: LATER,
  });

  test('every draft is ready or a problem; a clean draft needs no mark', async () => {
    const one = await good();
    const freeText = await draft([{ description: 'Something', quantity: 1, unitAmountCents: 1000, taxCode: 'GST' }]);
    const empty = await draft([]);
    const missing = await good();
    let views = await invoiceViews(handle.db, lab.id);
    assert.deepEqual(views.toCheck, []);
    assert.deepEqual(views.ready.sort(), [one.id, missing.id].sort());
    assert.deepEqual(views.problems.get(freeText.id).map((p) => p.code), ['line_no_item']);
    assert.deepEqual(views.problems.get(empty.id).map((p) => p.code), ['no_lines']);

    // The accounting system adds its own checks.
    const fake = fakeAccounting();
    fake.checks.set(missing.id, [{ code: 'xero_contact_missing', message: 'No Xero contact.' }]);
    views = await invoiceViews(handle.db, lab.id, { accounting: fake.adapter });
    assert.deepEqual(views.ready, [one.id]);
    assert.deepEqual(views.problems.get(missing.id).map((p) => p.code), ['xero_contact_missing']);

    // A fixed problem is ready at once.
    await updateDraftInvoice(handle.db, lab.id, freeText.id, { lines: [{ priceItemId: crown.id, quantity: 1 }] });
    views = await invoiceViews(handle.db, lab.id);
    assert.ok(views.ready.includes(freeText.id));
    // markReady still refuses a problem and a non-draft.
    const marked = await markReady(handle.db, lab.id, [one.id, empty.id], { personId: owner.id });
    assert.deepEqual(marked.refused.map((r) => r.invoiceId), [empty.id]);
    await assert.rejects(markReady(handle.db, lab.id, [one.id, crown.id], { personId: owner.id }), { code: 'not_draft' });
  });

  test('with no accounting system, Send all ready issues the ready drafts only', async () => {
    const ready = await good();
    const other = await good();
    const problem = await draft([]);
    const result = await sendAllReady(handle.db, lab.id, { personId: owner.id, issueDate: ISSUE_DATE });
    assert.deepEqual(result, { issued: 2, queued: 0, remaining: 0, waiting: 0, held: 0, nonChargeable: 0 });
    assert.equal((await row(ready.id)).status, 'issued');
    assert.equal((await row(ready.id)).sendState, null);
    assert.equal((await row(other.id)).status, 'issued');
    assert.equal((await row(problem.id)).status, 'draft');
  });

  test('Send all ready reads the accounting system\'s changes first; a failed read issues nothing', async () => {
    const fake = fakeAccounting();
    let answer = { state: 'unavailable', reason: 'Xero calls are stopped' };
    let reads = 0;
    fake.adapter.capabilities.readChanges = async () => { reads += 1; return answer; };
    const one = await good();
    const two = await good();
    await markReady(handle.db, lab.id, [one.id, two.id], { personId: owner.id });

    assert.deepEqual(await sendAllReady(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE }),
      { issued: 0, queued: 0, remaining: 0, waiting: 2, held: 0, nonChargeable: 0 });
    assert.equal(reads, 1);
    assert.equal((await row(one.id)).status, 'draft');

    answer = { state: 'fresh' };
    assert.deepEqual(await sendAllReady(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE }),
      { issued: 2, queued: 2, remaining: 0, waiting: 0, held: 0, nonChargeable: 0 });
    assert.equal(reads, 2);

    // With nothing ready, no read.
    await sendAllReady(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE });
    assert.equal(reads, 2);
  });

  test('Send on one invoice issues that ready draft only, and refuses one that is not ready', async () => {
    const one = await good();
    const other = await good();
    const unchecked = await draft([]);
    await assert.rejects(sendAllReady(handle.db, lab.id, { personId: owner.id, issueDate: ISSUE_DATE, invoiceIds: [unchecked.id] }), { code: 'not_ready' });
    assert.equal((await row(unchecked.id)).status, 'draft');
    const result = await sendAllReady(handle.db, lab.id, { personId: owner.id, issueDate: ISSUE_DATE, invoiceIds: [one.id] });
    assert.deepEqual(result, { issued: 1, queued: 0, remaining: 0, waiting: 0, held: 0, nonChargeable: 0 });
    assert.equal((await row(one.id)).status, 'issued');
    assert.equal((await row(other.id)).status, 'draft');
  });

  test('Send on one invoice sends nothing when its job cannot be confirmed', async () => {
    const one = await invoicedJob();
    const failed = workReader(() => ({ state: 'unavailable', reason: 'calls are stopped' }));
    await assert.rejects(sendThese([one.invoice.id], failed.work), {
      code: 'not_ready',
      message: '1 job could not be read from the work system. Nothing was sent.',
    });
    assert.equal((await row(one.invoice.id)).status, 'draft');
    assert.deepEqual(failed.reads, [one.ref]);

    // A confirmed job on one invoice still goes.
    const kept = await invoicedJob();
    const ok = workReader(confirmed);
    const result = await sendThese([kept.invoice.id], ok.work);
    assert.deepEqual(result, { issued: 1, queued: 0, remaining: 0, waiting: 0, held: 0, nonChargeable: 0 });
    assert.equal((await row(kept.invoice.id)).status, 'issued');
  });

  test('a bulk send issues the invoices whose jobs were confirmed when one read fails', async () => {
    const keep = await invoicedJob();
    const drop = await invoicedJob();
    const { work, reads } = workReader((ref) => (ref === drop.ref
      ? { state: 'unavailable', reason: 'calls are stopped' }
      : confirmed(ref)));
    const result = await sendThese([keep.invoice.id, drop.invoice.id], work);
    assert.deepEqual(result, { issued: 1, queued: 0, remaining: 0, waiting: 1, held: 0, nonChargeable: 0 });
    assert.equal((await row(keep.invoice.id)).status, 'issued');
    assert.equal((await row(drop.invoice.id)).status, 'draft');
    assert.deepEqual(reads.sort(), [keep.ref, drop.ref].sort());
  });

  test('a bulk send that confirms none names how many jobs could not be read', async () => {
    const one = await invoicedJob();
    const two = await invoicedJob();
    const three = await invoicedJob();
    const { work } = workReader(() => ({ state: 'unavailable', reason: 'calls are stopped' }));
    await assert.rejects(sendThese([one.invoice.id, two.invoice.id, three.invoice.id], work), {
      code: 'not_ready',
      message: '3 jobs could not be read from the work system. Nothing was sent.',
    });
    for (const item of [one, two, three]) assert.equal((await row(item.invoice.id)).status, 'draft');
  });

  test('a bulk send reads at most 20 old jobs and reports the rest as waiting', async () => {
    const made = [];
    for (let i = 0; i < READS_PER_PASS + 5; i += 1) made.push(await invoicedJob());
    const { work, reads } = workReader(confirmed);
    const result = await sendThese(made.map((item) => item.invoice.id), work);
    assert.equal(reads.length, READS_PER_PASS);
    assert.deepEqual(
      [result.issued, result.waiting, result.queued, result.remaining, result.held],
      [READS_PER_PASS, 5, 0, 0, 0],
    );
    const statuses = await Promise.all(made.map((item) => row(item.invoice.id)));
    assert.equal(statuses.filter((invoice) => invoice.status === 'issued').length, READS_PER_PASS);
    assert.equal(statuses.filter((invoice) => invoice.status === 'draft').length, 5);
  });

  test('a bulk send still issues the others when one job goes to review', async () => {
    const keep = await invoicedJob();
    const drop = await invoicedJob();
    const { work } = workReader((ref) => (ref === drop.ref
      ? {
        state: 'withdrawn',
        reason: 'deleted',
        ledgerWithdrawn: {
          sourceSystem: 'works', sourceJobRef: ref, deleted: true,
          reason: 'the order was deleted in the work system', observedAt: LATER,
        },
      }
      : confirmed(ref)));
    const result = await sendThese([keep.invoice.id, drop.invoice.id], work);
    assert.deepEqual([result.issued, result.waiting], [1, 1]);
    assert.equal((await row(keep.invoice.id)).status, 'issued');
    assert.equal((await row(drop.invoice.id)).status, 'draft');
    const views = await invoiceViews(handle.db, lab.id);
    assert.equal(views.problems.get(drop.invoice.id)?.[0].code, 'job_review');
  });

  test('a bulk press still sends nothing when the accounting read cannot run', async () => {
    const fake = fakeAccounting();
    fake.adapter.capabilities.readChanges = async () => ({ state: 'unavailable', reason: 'calls are stopped' });
    const one = await good();
    const two = await good();
    await assert.rejects(sendAllReady(handle.db, lab.id, {
      accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE, invoiceIds: [one.id, two.id],
    }), { code: 'not_ready', message: 'calls are stopped. Nothing was sent.' });
    assert.equal((await row(one.id)).status, 'draft');
    assert.equal((await row(two.id)).status, 'draft');
  });

  test('a stopped press names when the accounting copy has more changes than one read takes', async () => {
    const fake = fakeAccounting();
    fake.adapter.capabilities.readChanges = async () => ({
      state: 'unavailable', reason: 'Xero has more changes than one read takes',
    });
    const one = await good();
    await assert.rejects(sendAllReady(handle.db, lab.id, {
      accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE, invoiceIds: [one.id],
    }), {
      code: 'not_ready',
      message: 'The accounting copy has more changes than one read takes. Nothing was sent.',
    });
    assert.equal((await row(one.id)).status, 'draft');
  });

  test('an accounting system that is not connected or takes no writes stops the send before anything is issued', async () => {
    const ready = await good();
    await markReady(handle.db, lab.id, [ready.id], { personId: owner.id });
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
    await markReady(handle.db, lab.id, [one.id, two.id, three.id], { personId: owner.id });
    fake.outcomes.set(two.id, 'failed');
    fake.outcomes.set(three.id, 'not_tried');

    const result = await sendAllReady(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE });
    assert.deepEqual(result, { issued: 3, queued: 3, remaining: 0, waiting: 0, held: 0, nonChargeable: 0 });
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
    const refusedNumber = (await row(two.id)).number;
    assert.deepEqual(sent, {
      sent: 1, failed: 1, waiting: 1, refused: ['xero_contact_missing'],
      refusals: [{ invoiceId: two.id, number: refusedNumber, code: 'xero_contact_missing', message: 'No Xero contact is named.' }],
    });
    assert.ok(fake.pushed.every(([, by]) => by === owner.id));
    assert.equal((await row(one.id)).sendState, 'sent');
    assert.equal((await row(three.id)).sendState, 'queued');
    const failed = await row(two.id);
    assert.equal(failed.sendState, 'failed');
    assert.equal(failed.sendError.code, 'xero_contact_missing');
    assert.equal(failed.sendError.message, 'No Xero contact is named "Example Practice".');
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

  test('the list counts each tab, and one press sends every ready invoice', async () => {
    const ready = await createDraftInvoice(handle.db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id, quantity: 1 }] });
    const problem = await createDraftInvoice(handle.db, lab.id, { contactId: practice.id, lines: [] });

    let res = await call(`/invoices/${ready.id}`);
    assert.deepEqual([res.body.invoice.view, res.body.invoice.tab], ['ready', 'ready']);
    res = await call(`/invoices/${problem.id}`);
    assert.deepEqual([res.body.invoice.tab, res.body.invoice.problems[0].code], ['pending', 'no_lines']);
    assert.equal((await call('/invoices/mark-ready', { method: 'POST', body: { invoiceIds: [] } })).status, 400);

    res = await call('/invoices?status=ready');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.counts, { pending: 1, ready: 1, draft: 0, approved: 0, sent: 0, non_chargeable: 0, void: 0 });
    assert.equal(res.body.sendsTo, 'Accounts');
    assert.deepEqual(res.body.invoices.map((i) => [i.id, i.tab]), [[ready.id, 'ready']]);
    res = await call('/invoices?status=pending');
    assert.deepEqual(res.body.invoices.map((i) => [i.id, i.problems[0].code]), [[problem.id, 'no_lines']]);
    assert.deepEqual((await call('/invoices?status=problem')).body.invoices.map((i) => i.id), [problem.id], 'an old tab name still works');
    assert.equal((await call('/invoices?status=other')).status, 400);

    res = await call('/invoices/send-ready', { method: 'POST', body: { issueDate: ISSUE_DATE } });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.issued, res.body.queued, res.body.remaining], [1, 1, 0]);
    // On its way: Draft, the lowest stage the accounting system holds.
    res = await call('/invoices?status=draft');
    assert.deepEqual(res.body.invoices.map((i) => [i.id, i.tab, i.sending]), [[ready.id, 'draft', true]]);
    // The accounting system's stage moves it on.
    await handle.db.update(invoices).set({ sendState: 'sent' }).where(eq(invoices.id, ready.id));
    fake.stages.set(ready.id, 'approved');
    assert.deepEqual((await call('/invoices?status=approved')).body.invoices.map((i) => i.id), [ready.id]);
    fake.stages.set(ready.id, 'sent');
    res = await call('/invoices?status=sent');
    assert.deepEqual([res.body.invoices.map((i) => i.id), res.body.counts.sent], [[ready.id], 1]);
    assert.equal((await call(`/invoices/${ready.id}`)).body.invoice.tab, 'sent');

    fake.status = { connected: false, writesAllowed: true };
    res = await call('/invoices/send-ready', { method: 'POST', body: {} });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'accounting_not_connected');
    fake.status = { connected: true, writesAllowed: true };
    assert.equal((await call('/invoices/send-again', { method: 'POST', body: { invoiceIds: ['nope'] } })).status, 400);
  });
});

describe('the send worker reports a refusal', { skip: skipWithoutDatabase }, () => {
  let handle;
  let lab;
  let owner;

  before(async () => {
    handle = await freshDatabase();
    owner = await seedFirstOwner(handle.db, 'owner@example.test');
    lab = await createOrganisation(handle.db, { name: 'Example Lab' });
  });
  after(async () => handle?.close());

  test('the error names the refused invoice and the accounting system\'s reason, and the invoice stays in Problem', async () => {
    const practice = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Example Practice', email: 'practice@example.test' });
    const crown = await createPriceItem(handle.db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
    const draft = (reference) => createDraftInvoice(handle.db, lab.id, {
      contactId: practice.id, reference, lines: [{ priceItemId: crown.id, quantity: 1 }],
    });
    const one = await draft('CASE-1');
    const two = await draft('CASE-2');
    const fake = fakeAccounting();
    const reason = 'Account code \'999\' is not a valid code for this document. See accounts@example.test for "Example Practice".';
    fake.outcomes.set(two.id, 'failed');
    fake.errors.set(two.id, { code: 'xero_validation_failed', message: reason, details: { contact: practice.name, email: practice.email } });
    await sendAllReady(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE });
    const number = (await handle.db.select().from(invoices).where(eq(invoices.id, two.id)))[0].number;

    const errors = [];
    const worker = createSendWorker({
      db: handle.db,
      integrations: { with: (name) => (name === 'pushInvoices' ? [fake.adapter] : []) },
      log: { info() {}, warn() {}, error(line) { errors.push(String(line)); } },
      timers: { setTimeout: () => ({ unref() {} }), clearTimeout() {} },
    });
    worker.start();
    await worker.tick();

    const report = `[sending] the accounting system refused 1 invoice: ${number} (${two.id}) xero_validation_failed: Account code '999' is not a valid code for this document.`;
    assert.deepEqual(errors, [report]);
    assert.equal(report.includes('Example Practice'), false);
    assert.equal(report.includes('CASE-1') || report.includes('CASE-2'), false);
    assert.equal(report.includes('@'), false);

    const failed = (await handle.db.select().from(invoices).where(eq(invoices.id, two.id)))[0];
    assert.equal(failed.sendState, 'failed');
    assert.equal(failed.sendError.message, reason);
    const views = await invoiceViews(handle.db, lab.id, { accounting: fake.adapter });
    assert.equal(views.problems.get(two.id)[0].message, reason);
    assert.equal((await handle.db.select().from(invoices).where(eq(invoices.id, one.id)))[0].sendState, 'sent');

    fake.outcomes.delete(two.id);
    await sendAgain(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id });
    await worker.tick();
    assert.deepEqual(errors, [report]);
    await worker.stop();
  });
});
