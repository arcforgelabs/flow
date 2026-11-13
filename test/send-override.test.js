import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createRegistry } from '../server/integrations/port.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, reviseInvoice, voidInvoice } from '../server/core/invoices.js';
import { observeJob } from '../server/core/ledger.js';
import { listReview } from '../server/core/review.js';
import {
  acceptOverride, listOverrides, overridable, OVERRIDABLE, OVERRIDES_PER_DAY, overridesOfInvoice, recheckOpenOverrides, recheckOverride, REVIEW_OVERRIDE,
} from '../server/core/send-override.js';
import { invoiceViews, sendAllReady, sendAnyway, sendQueued } from '../server/core/sending.js';
import { billingObligations, invoices, obligationEvents, sendOverrides } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Override (server/core/send-override.js, sendAnyway in sending.js): an owner
// or admin sends one draft although it has a warning. The accounting system
// is a fake. Synthetic data only (CONTRIBUTING.md).

const ISSUE_DATE = '2026-11-13';
const TAX = { code: 'xero_tax_differs', key: 'xero_tax_differs:1:CRN', line: 1, itemCode: 'CRN', flowTax: 'GST_FREE', xeroTax: 'GST', message: 'Line 1: GST differs from Xero item CRN (GST in Xero).', short: 'GST not as Xero' };
const NO_ITEM = { code: 'xero_item_missing', message: 'Line 1: item CRN is not in Xero.', short: 'CRN not in Xero' };

test('only a warning on the allow list can be overridden, and only when each problem is on it', () => {
  assert.deepEqual([...OVERRIDABLE], ['xero_tax_differs']);
  assert.equal(overridable([]), false);
  assert.equal(overridable([TAX]), true);
  assert.equal(overridable([TAX, NO_ITEM]), false);
  for (const code of ['xero_contact_missing', 'xero_contact_ambiguous', 'xero_item_missing', 'no_lines', 'no_amount', 'line_no_item', 'job_review', 'rule', 'non_chargeable', 'xero_same_reference_different_amount', 'xero_earlier_version_in_xero', 'unknown_code']) {
    assert.equal(overridable([{ code, message: 'x' }]), false, code);
  }
});

function fakeAccounting() {
  const fake = { status: { connected: true, writesAllowed: true }, checks: new Map(), pushed: [] };
  fake.adapter = {
    id: 'accounts',
    name: 'Accounts',
    capabilities: {
      health: async () => ({ ok: true }),
      sendStatus: async () => fake.status,
      checkDrafts: async ({ invoiceIds }) => new Map(invoiceIds.map((id) => [id, fake.checks.get(id) ?? []])),
      pushInvoices: async ({ invoiceIds, pushedBy, accepted }) => {
        fake.pushed.push(...invoiceIds.map((id) => ({ id, pushedBy, accepted: accepted?.get(id) ?? null })));
        return { invoices: invoiceIds.map((invoiceId) => ({ invoiceId, outcome: 'created' })) };
      },
    },
  };
  return fake;
}

describe('override: send one invoice with a warning', { skip: skipWithoutDatabase }, () => {
  let handle;
  let lab;
  let practice;
  let crown;
  let owner;
  let fake;
  let labs = 0;

  before(async () => {
    handle = await freshDatabase();
    owner = await seedFirstOwner(handle.db, 'owner@example.test');
  });
  after(async () => handle?.close());
  beforeEach(async () => {
    lab = await createOrganisation(handle.db, { name: `Example Lab ${++labs}` });
    practice = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Example Practice' });
    crown = await createPriceItem(handle.db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
    fake = fakeAccounting();
    // Each test starts with no override in the last day.
    await handle.pool.query('ALTER TABLE flow.send_overrides DISABLE TRIGGER send_overrides_append_only; DELETE FROM flow.review_items; DELETE FROM flow.send_overrides; ALTER TABLE flow.send_overrides ENABLE TRIGGER send_overrides_append_only;');
  });

  const good = () => createDraftInvoice(handle.db, lab.id, { contactId: practice.id, reference: 'CASE-1', lines: [{ priceItemId: crown.id, quantity: 1 }] });
  const row = async (id) => (await handle.db.select().from(invoices).where(eq(invoices.id, id)))[0];
  const warned = async (problems = [TAX]) => {
    const invoice = await good();
    fake.checks.set(invoice.id, problems);
    return invoice;
  };
  const press = (invoice, extra = {}) => sendAnyway(handle.db, lab.id, invoice.id, {
    accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE, acknowledged: [TAX.key], reasonCode: 'xero_item_wrong', ...extra,
  });

  test('an override issues, queues and records; the worker passes the recorded warning; Send ready never sends it', async () => {
    const invoice = await warned();
    const job = await observeJob(handle.db, lab.id, {
      sourceSystem: 'works', sourceJobRef: `JOB-${labs}`, caseRef: `JOB-${labs}`, sourceStatus: 'Shipped', jobDate: '2026-11-10',
      lines: [{ itemCode: 'CRN', quantity: 1 }], observedAt: new Date(),
    });
    await handle.db.update(billingObligations).set({ invoiceId: invoice.id }).where(eq(billingObligations.id, job.id));

    // Send ready, with and without the id, leaves it on Pending.
    assert.deepEqual((await invoiceViews(handle.db, lab.id, { accounting: fake.adapter })).ready, []);
    assert.equal((await sendAllReady(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE })).issued, 0);
    await assert.rejects(sendAllReady(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE, invoiceIds: [invoice.id] }), { code: 'not_ready' });
    assert.equal((await row(invoice.id)).status, 'draft');

    const { override } = await press(invoice, { reasonCode: 'other', note: '  Checked with the bookkeeper.  ' });
    const issued = await row(invoice.id);
    assert.equal(issued.status, 'issued');
    assert.equal(issued.sendState, 'queued');
    assert.equal(issued.sendRequestedBy, owner.id);
    assert.equal(override.version, issued.issuedVersion);
    assert.match(override.documentHash, /^[0-9a-f]{64}$/);
    assert.equal(override.note, 'Checked with the bookkeeper.');
    assert.deepEqual(override.problems, [{ code: TAX.code, key: TAX.key, message: TAX.message, short: TAX.short, line: 1, itemCode: 'CRN', flowTax: 'GST_FREE', xeroTax: 'GST' }]);

    // The open item: the money on the warned line, and no note in its evidence.
    const [item] = await listReview(handle.db, lab.id, { kind: REVIEW_OVERRIDE });
    assert.equal(item.flowId, override.id);
    assert.equal(item.moneyAtRiskCents, 22000);
    assert.equal(JSON.stringify(item.evidence).includes('bookkeeper'), false);
    assert.equal(item.evidence.problems[0].message, undefined);
    const events = await handle.db.select().from(obligationEvents).where(eq(obligationEvents.obligationId, job.id));
    const event = events.find((e) => e.kind === 'send.override');
    assert.equal(event.actor, `person:${owner.id}`);
    assert.deepEqual(event.evidence, { overrideId: override.id, invoiceId: invoice.id, version: issued.issuedVersion, codes: ['xero_tax_differs'], reasonCode: 'other' });

    assert.deepEqual(await sendQueued(handle.db, lab.id, { accounting: fake.adapter }), { sent: 1, failed: 0, waiting: 0 });
    assert.deepEqual(fake.pushed, [{ id: invoice.id, pushedBy: owner.id, accepted: [TAX.key] }]);
    assert.equal((await row(invoice.id)).sendState, 'sent');
    const [shown] = await overridesOfInvoice(handle.db, lab.id, invoice.id);
    assert.equal(shown.reason, 'Other');
    assert.equal(shown.review.state, 'open');
  });

  test('a usual send passes no warning to the adapter', async () => {
    const invoice = await good();
    await sendAllReady(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE });
    await sendQueued(handle.db, lab.id, { accounting: fake.adapter });
    assert.deepEqual(fake.pushed, [{ id: invoice.id, pushedBy: owner.id, accepted: null }]);
  });

  test('a problem that is not on the allow list stops the override, alone or with a warning', async () => {
    const mixed = await warned([TAX, NO_ITEM]);
    await assert.rejects(press(mixed), (error) => error.code === 'not_overridable' && /not in Xero/.test(error.message));
    const clean = await good();
    await assert.rejects(press(clean, { acknowledged: [] }), { code: 'not_overridable' });
    const empty = await createDraftInvoice(handle.db, lab.id, { contactId: practice.id, reference: 'CASE-2', lines: [] });
    await assert.rejects(press(empty), { code: 'not_overridable' });
    for (const invoice of [mixed, clean, empty]) assert.equal((await row(invoice.id)).status, 'draft');
    assert.equal((await handle.db.select().from(sendOverrides)).length, 0);
  });

  test('the ticks must be the warnings at the press', async () => {
    const invoice = await warned();
    await assert.rejects(press(invoice, { acknowledged: [] }), { code: 'override_stale' });
    await assert.rejects(press(invoice, { acknowledged: ['xero_tax_differs:2:CRN'] }), { code: 'override_stale' });
    await assert.rejects(press(invoice, { acknowledged: [TAX.key, 'xero_tax_differs:2:CRN'] }), { code: 'override_stale' });
    await assert.rejects(press(invoice, { acknowledged: 'all' }), { code: 'invalid' });
    assert.equal((await row(invoice.id)).status, 'draft');
  });

  test('the reason is from the list, and Other needs a note', async () => {
    const invoice = await warned();
    await assert.rejects(press(invoice, { reasonCode: 'because' }), { code: 'invalid' });
    await assert.rejects(press(invoice, { reasonCode: 'other' }), { code: 'invalid' });
    await assert.rejects(press(invoice, { reasonCode: 'other', note: '   ' }), { code: 'invalid' });
    await assert.rejects(press(invoice, { note: 'x'.repeat(201) }), { code: 'invalid' });
    assert.equal((await row(invoice.id)).status, 'draft');
  });

  test('no accounting system, or one that takes no writes, stops the override', async () => {
    const invoice = await warned();
    await assert.rejects(sendAnyway(handle.db, lab.id, invoice.id, { personId: owner.id, issueDate: ISSUE_DATE, acknowledged: [TAX.key], reasonCode: 'one_off' }), { code: 'accounting_not_connected' });
    fake.status = { connected: true, writesAllowed: false };
    await assert.rejects(press(invoice), { code: 'accounting_writes_off' });
    assert.equal((await row(invoice.id)).status, 'draft');
  });

  test('one person makes at most the daily limit of overrides', async () => {
    for (let n = 0; n < OVERRIDES_PER_DAY; n += 1) await press(await warned());
    const last = await warned();
    await assert.rejects(press(last), (error) => error.code === 'override_limit' && error.status === 429);
    assert.equal((await row(last.id)).status, 'draft');
    // A day later the person can make one again.
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await press(last, { now: tomorrow });
    assert.equal((await row(last.id)).status, 'issued');
  });

  test('an override is a record: no update and no delete', async () => {
    const { override } = await press(await warned());
    await assert.rejects(handle.db.update(sendOverrides).set({ note: 'changed' }).where(eq(sendOverrides.id, override.id)));
    await assert.rejects(handle.db.delete(sendOverrides).where(eq(sendOverrides.id, override.id)));
    assert.equal((await handle.db.select().from(sendOverrides).where(eq(sendOverrides.id, override.id))).length, 1);
  });

  test('Recheck closes the item only when the warning is gone', async () => {
    const invoice = await warned();
    const { override } = await press(invoice);
    assert.deepEqual(await recheckOverride(handle.db, lab.id, override.id, { accounting: fake.adapter }), { closed: false, reason: 'still_differs' });
    assert.deepEqual(await recheckOverride(handle.db, lab.id, override.id, {}), { closed: false, reason: 'accounting_not_connected' });
    fake.checks.set(invoice.id, []);
    assert.deepEqual(await recheckOverride(handle.db, lab.id, override.id, { accounting: fake.adapter }), { closed: true, resolution: 'agrees' });
    assert.deepEqual(await listOverrides(handle.db, lab.id), []);
    const [all] = await listOverrides(handle.db, lab.id, { state: 'all' });
    assert.equal(all.review.resolution, 'agrees');
    assert.equal(all.review.resolvedBy, 'system:send-override');
    assert.deepEqual(await recheckOverride(handle.db, lab.id, override.id, { accounting: fake.adapter }), { closed: false, reason: 'not_open' });
  });

  test('Accept needs a note and closes the item as the person', async () => {
    const { override } = await press(await warned());
    await assert.rejects(acceptOverride(handle.db, lab.id, override.id, { personId: owner.id, note: ' ' }), { code: 'invalid' });
    const accepted = await acceptOverride(handle.db, lab.id, override.id, { personId: owner.id, note: 'The client is tax free.' });
    assert.equal(accepted.review.state, 'resolved');
    assert.equal(accepted.review.resolution, 'accepted');
    assert.equal(accepted.review.note, 'The client is tax free.');
    assert.equal(accepted.review.resolvedBy, `person:${owner.id}`);
    await assert.rejects(acceptOverride(handle.db, lab.id, override.id, { personId: owner.id, note: 'Again.' }), { code: 'conflict' });
  });

  test('a void invoice, and a later version sent clean, close the item', async () => {
    const gone = await warned();
    await press(gone);
    const revised = await warned();
    await press(revised);
    await sendQueued(handle.db, lab.id, { accounting: fake.adapter });

    await voidInvoice(handle.db, lab.id, gone.id);
    assert.deepEqual(await recheckOpenOverrides(handle.db, lab.id, { accounting: fake.adapter, invoiceId: gone.id }), { open: 0, closed: 1 });

    // Under revision the item stays open; the new version, sent clean, closes it.
    await reviseInvoice(handle.db, lab.id, revised.id);
    assert.deepEqual(await recheckOpenOverrides(handle.db, lab.id, { accounting: fake.adapter }), { open: 1, closed: 0 });
    fake.checks.set(revised.id, []);
    fake.pushed.length = 0;
    await sendAllReady(handle.db, lab.id, { accounting: fake.adapter, personId: owner.id, issueDate: ISSUE_DATE, invoiceIds: [revised.id] });
    await sendQueued(handle.db, lab.id, { accounting: fake.adapter });
    // The old override does not apply to the new version.
    assert.deepEqual(fake.pushed, [{ id: revised.id, pushedBy: owner.id, accepted: null }]);
    assert.deepEqual(await recheckOpenOverrides(handle.db, lab.id, { accounting: fake.adapter }), { open: 0, closed: 1 });
    const resolutions = (await listOverrides(handle.db, lab.id, { state: 'all' })).map((o) => o.review.resolution).sort();
    assert.deepEqual(resolutions, ['invoice_void', 'replaced']);
  });
});

describe('override over the API', { skip: skipWithoutDatabase }, () => {
  const quiet = { info() {}, warn() {}, error() {} };
  const KEY = 'agent-key-for-tests-0123456789abcdef';
  let handle;
  let app;
  let lab;
  let practice;
  let crown;
  let ownerToken;
  let staffToken;
  const fake = fakeAccounting();

  before(async () => {
    handle = await freshDatabase();
    const clerk = fakeClerk();
    lab = await createOrganisation(handle.db, { name: 'Example Lab' });
    practice = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Example Practice' });
    crown = await createPriceItem(handle.db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
    const owner = await seedFirstOwner(handle.db, 'owner@example.test');
    await invitePerson(handle.db, { email: 'staff@example.test', role: 'staff', invitedBy: owner.id });
    await invitePerson(handle.db, { email: 'assistant@example.test', role: 'admin', invitedBy: owner.id });
    ownerToken = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    staffToken = clerk.signIn(clerk.addUser({ email: 'staff@example.test', google: true, password: false }));
    const integrations = createRegistry({ log: quiet, env: {} });
    integrations.register(fake.adapter);
    integrations.enable('accounts');
    await integrations.start(handle.db);
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({
      db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet,
      agentKey: { digest: createHash('sha256').update(KEY).digest('hex'), email: 'assistant@example.test' },
    });
    app = createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations, log: quiet });
  });
  after(async () => handle?.close());

  const call = (path, options = {}) => request(app, `/api/invoicing${path}`, { token: ownerToken, ...options });
  const warned = async () => {
    const invoice = await createDraftInvoice(handle.db, lab.id, { contactId: practice.id, reference: 'CASE-9', lines: [{ priceItemId: crown.id, quantity: 1 }] });
    fake.checks.set(invoice.id, [TAX]);
    return invoice;
  };
  const body = { acknowledged: [TAX.key], reasonCode: 'client_tax', issueDate: ISSUE_DATE };

  test('the invoice says when it can be overridden, and names each warning by key', async () => {
    const invoice = await warned();
    let res = await call(`/invoices/${invoice.id}`);
    assert.equal(res.body.invoice.canOverride, true);
    assert.deepEqual(res.body.invoice.problems.map((p) => p.key), [TAX.key]);
    assert.equal(res.body.invoice.overrideReasons.other, 'Other');
    fake.checks.set(invoice.id, [TAX, NO_ITEM]);
    res = await call(`/invoices/${invoice.id}`);
    assert.equal(res.body.invoice.canOverride, false);
    const clean = await createDraftInvoice(handle.db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id, quantity: 1 }] });
    assert.equal((await call(`/invoices/${clean.id}`)).body.invoice.canOverride, false);
  });

  test('staff and an assistant key cannot override or accept; an owner can', async () => {
    const invoice = await warned();
    const path = `/invoices/${invoice.id}/send-anyway`;
    let res = await call(path, { method: 'POST', body, token: staffToken });
    assert.deepEqual([res.status, res.body.code], [403, 'role_required']);
    res = await call(path, { method: 'POST', body, token: KEY });
    assert.deepEqual([res.status, res.body.code], [403, 'person_required']);
    assert.equal((await call(`/invoices/${invoice.id}`)).body.invoice.status, 'draft');

    res = await call(path, { method: 'POST', body });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.invoice.status, 'issued');
    assert.equal(res.body.invoice.canOverride, false);
    assert.equal(res.body.invoice.overrides[0].reason, 'Client tax treatment');
    const overrideId = res.body.override.id;

    // The same invoice waits 30 seconds between presses.
    res = await call(path, { method: 'POST', body });
    assert.deepEqual([res.status, res.body.code], [429, 'action_cooldown']);

    // An assistant reads the open overrides, and cannot accept one.
    res = await call('/overrides', { token: KEY });
    assert.deepEqual(res.body.overrides.map((o) => o.id), [overrideId]);
    assert.equal((await call('/review?kind=send.override', { token: KEY })).body.items?.length ?? 1, 1);
    res = await call(`/overrides/${overrideId}/accept`, { method: 'POST', body: { note: 'Fine.' }, token: KEY });
    assert.deepEqual([res.status, res.body.code], [403, 'person_required']);
    res = await call(`/overrides/${overrideId}/accept`, { method: 'POST', body: { note: 'Fine.' }, token: staffToken });
    assert.equal(res.status, 403);

    res = await call(`/overrides/${overrideId}/recheck`, { method: 'POST', body: {} });
    assert.deepEqual([res.body.closed, res.body.reason], [false, 'still_differs']);
    res = await call(`/overrides/${overrideId}/accept`, { method: 'POST', body: {} });
    assert.equal(res.status, 400);
    res = await call(`/overrides/${overrideId}/accept`, { method: 'POST', body: { note: 'The client is tax free.' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.override.review.resolution, 'accepted');
    assert.deepEqual((await call('/overrides')).body.overrides, []);
    assert.equal((await call('/overrides?state=all')).body.overrides.length, 1);
  });

  test('a void closes the open override', async () => {
    const invoice = await warned();
    let res = await call(`/invoices/${invoice.id}/send-anyway`, { method: 'POST', body });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await call(`/invoices/${invoice.id}/void`, { method: 'POST', body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.invoice.overrides[0].review.resolution, 'invoice_void');
  });

  test('changed warnings and a problem off the list are refused with their own codes', async () => {
    const invoice = await warned();
    let res = await call(`/invoices/${invoice.id}/send-anyway`, { method: 'POST', body: { ...body, acknowledged: [] } });
    assert.deepEqual([res.status, res.body.code], [409, 'override_stale']);
    const other = await warned();
    fake.checks.set(other.id, [NO_ITEM]);
    res = await call(`/invoices/${other.id}/send-anyway`, { method: 'POST', body });
    assert.deepEqual([res.status, res.body.code], [409, 'not_overridable']);
  });
});
