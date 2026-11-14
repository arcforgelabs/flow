import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { createContact, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, deleteDraft, issueInvoice, listInvoiceVersions, reviseInvoice, voidInvoice } from '../server/core/invoices.js';
import { observeJob } from '../server/core/ledger.js';
import { billingObligations, invoices } from '../server/db/schema.js';
import { APPROVED_MESSAGE, deleteXeroInvoice } from '../server/integrations/xero/delete-invoice.js';
import { createXeroRuntime } from '../server/integrations/xero/runtime.js';
import { resolveXeroSettings } from '../server/integrations/xero/settings.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, scriptedXero, seedLab, TOKEN_KEY, xeroAnswer } from './support/xero.js';

// Delete of an issued invoice also deletes its Xero draft (issue #317).
// Xero is replayed. Each test scripts the calls it expects, so an extra
// write fails the test. Synthetic names only.

const XC = '00000000-0000-4000-8000-0000000000c1';

const live = (id, status) => xeroAnswer(`Invoices/${id}`, { Invoices: [{ InvoiceID: id, Status: status, Type: 'ACCREC' }] });
const posted = (id) => xeroAnswer(`Invoices/${id}`, { Invoices: [{ InvoiceID: id, Status: 'DELETED' }] }, { method: 'POST' });
const posts = (replay) => replay.calls.filter((c) => c.method === 'POST');

describe('deleting a Xero draft is refused when writes are off', () => {
  test('live mode writes nothing without XERO_ALLOW_LIVE_WRITES=on, and makes no request', async () => {
    const runtime = createXeroRuntime({
      settings: resolveXeroSettings({ XERO_MODE: 'live', XERO_CLIENT_ID: 'id', XERO_CLIENT_SECRET: 'secret', XERO_TOKEN_KEY: TOKEN_KEY, XERO_TENANT_NAME: 'Example Lab' }),
      fetch: async () => assert.fail('no request'),
    });
    const answer = await deleteXeroInvoice(null, runtime, { organisationId: 'org', invoiceId: 'inv' });
    assert.deepEqual(answer, { state: 'unavailable', status: null });
  });
});

describe('delete an issued invoice and its Xero draft', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let integrations;
  let lab;
  let xero;
  let practice;
  let crown;
  let n = 0;

  before(async () => {
    handle = await freshDatabase();
    xero = scriptedXero();
    const booted = await bootFlow(handle, { runtime: xero.runtime, log: xero.log });
    app = booted.app;
    integrations = booted.integrations;
    lab = await seedLab(handle, booted.clerk);
    practice = await createContact(handle.db, lab.organisation.id, { kind: 'customer', name: 'Example Dental' });
    crown = await createPriceItem(handle.db, lab.organisation.id, { code: 'CROWN', name: 'Crown', unitAmountCents: 25000 });
    await connectDirectly(handle, xero.runtime, lab.organisation.id);
  });
  after(async () => handle?.close());
  beforeEach(() => {
    xero.clock.at += 10 * 60_000;
    xero.runtime.remember(lab.organisation.id, { access_token: 'synthetic-access-0', expires_in: 1800 });
  });

  const org = () => lab.organisation.id;
  const actor = () => `person:${lab.owner.id}`;
  const accounting = () => integrations.with('deleteInvoice')[0];
  const remove = (invoice) => deleteDraft(handle.db, org(), invoice.id, { actor: actor(), accounting: accounting() });

  async function sent(xeroId, { status = 'DRAFT', linkOnly = false } = {}) {
    const draft = await createDraftInvoice(handle.db, org(), {
      contactId: practice.id, reference: `CASE-${++n}`, lines: [{ priceItemId: crown.id }],
    });
    const invoice = await issueInvoice(handle.db, org(), draft.id, { issuedBy: 'user:test', issueDate: '2026-10-18' });
    const body = JSON.stringify({ Type: 'ACCREC', Status: 'DRAFT', Contact: { ContactID: XC }, Date: '2026-10-18' });
    if (linkOnly) {
      await handle.db.execute(sql`insert into xero_invoice_links (organisation_id, xero_invoice_id, invoice_id, matched_by, linked_by)
        values (${org()}, ${xeroId}, ${invoice.id}, 'made', ${actor()})`);
    } else {
      await handle.db.execute(sql`insert into xero_invoice_pushes (organisation_id, invoice_id, version, state, idempotency_key, request_body, body_hash, xero_invoice_id, xero_invoice_number, xero_status, verified)
        values (${org()}, ${invoice.id}, 1, 'created', ${`key-${n}`}, ${body}, 'hash', ${xeroId}, ${`INV-${xeroId}`}, 'DRAFT', true)`);
    }
    await handle.db.execute(sql`insert into xero_invoices (organisation_id, xero_invoice_id, type, invoice_number, xero_contact_id, status, issued_on,
        subtotal_cents, tax_cents, total_cents, amount_due_cents, amount_paid_cents, amount_credited_cents, lines, record_hash)
      values (${org()}, ${xeroId}, 'ACCREC', ${`INV-${xeroId}`}, ${XC}, ${status}, '2026-10-18',
        25000, 2500, 27500, 27500, 0, 0, '[]'::jsonb, ${`h-${n}`})`);
    return invoice;
  }

  async function attachJob(invoice) {
    const job = await observeJob(handle.db, org(), {
      sourceSystem: 'worksystem', sourceJobRef: `JOB-${n}`, caseRef: `CASE-${n}`, contactId: practice.id,
      lines: [{ itemCode: 'CROWN', description: 'Crown', quantity: 1 }],
    });
    await handle.db.update(billingObligations).set({ invoiceId: invoice.id, draftBasis: { source: 'test' } }).where(eq(billingObligations.id, job.id));
    return job;
  }

  const flowRow = async (id) => (await handle.db.select().from(invoices).where(eq(invoices.id, id)))[0];
  const xeroRows = async (id) => (await handle.db.execute(sql`select (select count(*)::int from xero_invoice_pushes where invoice_id = ${id}) as pushes,
    (select count(*)::int from xero_invoice_links where invoice_id = ${id}) as links`)).rows[0];
  // The adapter's record of a pair whose Flow invoice was removed.
  const history = async (id) => (await handle.db.execute(sql`select xero_invoice_id, invoice_number, matched_by, linked_by, released_by, deleted_by, removed_by, reason
    from xero_invoice_link_history where invoice_id = ${id} order by removed_at, matched_by`)).rows;
  const pushRow = async (id) => (await handle.db.execute(sql`select xero_status, deleted_by, deleted_at from xero_invoice_pushes where invoice_id = ${id}`)).rows[0];
  const copyStatus = async (xeroId) => (await handle.db.execute(sql`select status from xero_invoices where xero_invoice_id = ${xeroId}`)).rows[0].status;
  const lanes = async (xeroId) => (await handle.db.execute(sql`select lane from xero_calls where request_path like ${`%${xeroId}`} order by id`)).rows.map((r) => r.lane);

  async function deletedInXero(xeroId, from = 'DRAFT') {
    const invoice = await sent(xeroId);
    const job = await attachJob(invoice);
    const replay = xero.script([live(xeroId, from), posted(xeroId)]);
    const row = await remove(invoice);
    // No customer saw a Xero draft, so Flow removes its invoice: it is not
    // void (void is only for what a customer saw).
    assert.equal(row.removed, true);
    const [post] = posts(replay);
    assert.equal(post.path.endsWith(`/Invoices/${xeroId}`), true);
    assert.deepEqual(post.body, { InvoiceID: xeroId, Status: 'DELETED' });
    assert.equal(post.headers['Idempotency-Key'], undefined);
    assert.equal(await flowRow(invoice.id), undefined);
    assert.equal((await handle.db.execute(sql`select count(*)::int as n from invoice_versions where invoice_id = ${invoice.id}`)).rows[0].n, 0);
    assert.deepEqual(await xeroRows(invoice.id), { pushes: 0, links: 0 });
    const [obligation] = await handle.db.select().from(billingObligations).where(eq(billingObligations.id, job.id));
    assert.equal(obligation.invoiceId, null);
    assert.equal(obligation.draftBasis, null);
    assert.equal(obligation.accountingState, 'deleted');
    assert.equal(await copyStatus(xeroId), 'DELETED');
    assert.deepEqual(await lanes(xeroId), ['reads', 'writes']);
    // The job's history keeps who removed which invoice, and its Xero id.
    const [event] = (await handle.db.execute(sql`select kind, actor, evidence from obligation_events where obligation_id = ${job.id} order by created_at desc limit 1`)).rows;
    assert.equal(event.kind, 'draft_deleted');
    assert.equal(event.actor, actor());
    assert.equal(event.evidence.number, invoice.number);
    assert.equal(event.evidence.reason, 'deleted_in_accounting');
    assert.equal(event.evidence.accountingRef, xeroId);
    assert.equal(event.evidence.removed, true);
    // The pair stays as a record after its push row went with the invoice.
    assert.deepEqual(await history(invoice.id), [{ xero_invoice_id: xeroId, invoice_number: invoice.number, matched_by: 'sent', linked_by: null,
      released_by: null, deleted_by: actor(), removed_by: actor(), reason: 'deleted_in_accounting' }]);
    return invoice;
  }

  test('an issued invoice whose Xero copy is DRAFT is deleted in Xero, then removed in Flow (no customer saw it)', async () => {
    await deletedInXero('x-draft', 'DRAFT');
  });

  test('SUBMITTED is deleted the same way', async () => {
    await deletedInXero('x-submitted', 'SUBMITTED');
  });

  test('a Xero invoice already DELETED needs no write, and Flow still removes its invoice', async () => {
    const invoice = await sent('x-gone');
    const replay = xero.script([live('x-gone', 'DELETED')]);
    const row = await remove(invoice);
    assert.equal(row.removed, true);
    assert.equal(posts(replay).length, 0);
    assert.equal(replay.calls.length, 1);
    assert.equal(replay.calls[0].method, 'GET');
    assert.equal(await flowRow(invoice.id), undefined);
    assert.equal(await copyStatus('x-gone'), 'DELETED');
  });

  test('a Xero invoice already VOIDED needs no write; a customer may have seen it, so Flow voids and the ledger records voided', async () => {
    const invoice = await sent('x-voided');
    const job = await attachJob(invoice);
    const replay = xero.script([live('x-voided', 'VOIDED')]);
    assert.equal((await remove(invoice)).status, 'void');
    assert.equal(posts(replay).length, 0);
    const [obligation] = await handle.db.select().from(billingObligations).where(eq(billingObligations.id, job.id));
    assert.equal(obligation.accountingState, 'voided');
    assert.equal(obligation.invoiceId, null);
    assert.equal((await pushRow(invoice.id)).xero_status, 'VOIDED');
  });

  test('AUTHORISED is refused, with no write and no change in Flow', async () => {
    const invoice = await sent('x-auth');
    const job = await attachJob(invoice);
    const replay = xero.script([live('x-auth', 'AUTHORISED')]);
    await assert.rejects(remove(invoice), (error) => error.code === 'accounting_approved' && error.message === APPROVED_MESSAGE);
    assert.equal(posts(replay).length, 0);
    assert.equal(replay.calls.length, 1);
    assert.equal((await flowRow(invoice.id)).status, 'issued');
    const [obligation] = await handle.db.select().from(billingObligations).where(eq(billingObligations.id, job.id));
    assert.equal(obligation.invoiceId, invoice.id);
    assert.equal((await pushRow(invoice.id)).deleted_at, null);
    assert.equal(await copyStatus('x-auth'), 'DRAFT');
  });

  test('PAID is refused the same way', async () => {
    const invoice = await sent('x-paid');
    const replay = xero.script([live('x-paid', 'PAID')]);
    await assert.rejects(remove(invoice), (error) => error.message === APPROVED_MESSAGE);
    assert.equal(posts(replay).length, 0);
    assert.equal((await flowRow(invoice.id)).status, 'issued');
  });

  test('a link with no push is deleted the same way, and its link goes with the Flow invoice', async () => {
    const invoice = await sent('x-link', { linkOnly: true });
    const replay = xero.script([live('x-link', 'DRAFT'), posted('x-link')]);
    assert.equal((await remove(invoice)).removed, true);
    assert.equal(posts(replay).length, 1);
    assert.deepEqual(posts(replay)[0].body, { InvoiceID: 'x-link', Status: 'DELETED' });
    assert.deepEqual(await xeroRows(invoice.id), { pushes: 0, links: 0 });
    assert.equal(await flowRow(invoice.id), undefined);
    assert.equal(await copyStatus('x-link'), 'DELETED');
    const [kept] = await history(invoice.id);
    assert.deepEqual([kept.xero_invoice_id, kept.matched_by, kept.linked_by, kept.deleted_by, kept.removed_by], ['x-link', 'made', actor(), actor(), actor()]);
  });

  test('a revised invoice whose sent draft Xero deleted is removed with its issued version', async () => {
    const invoice = await sent('x-revised');
    const revised = await reviseInvoice(handle.db, org(), invoice.id);
    assert.equal(revised.status, 'draft');
    assert.equal(revised.issuedVersion, 1);
    xero.script([live('x-revised', 'DRAFT'), posted('x-revised')]);
    const row = await remove(invoice);
    assert.equal(row.removed, true);
    assert.equal(await flowRow(invoice.id), undefined);
    assert.equal((await handle.db.execute(sql`select count(*)::int as n from invoice_versions where invoice_id = ${invoice.id}`)).rows[0].n, 0);
  });

  // Version 1 went to one Xero invoice; after a revision, version 2 went to a
  // new Xero draft (`second`). `first` says what became of the first one.
  async function sentTwice(first, second, { status, emailed = false }) {
    const invoice = await sent(first);
    await handle.db.execute(sql`update xero_invoice_pushes set xero_status = ${status}, email_state = ${emailed ? 'sent' : null} where invoice_id = ${invoice.id}`);
    await handle.db.execute(sql`update xero_invoices set status = ${status} where xero_invoice_id = ${first}`);
    await reviseInvoice(handle.db, org(), invoice.id);
    const again = await issueInvoice(handle.db, org(), invoice.id, { issuedBy: 'user:test', issueDate: '2026-10-20' });
    assert.equal(again.issuedVersion, 2);
    await handle.db.execute(sql`insert into xero_invoice_pushes (organisation_id, invoice_id, version, state, idempotency_key, request_body, body_hash, xero_invoice_id, xero_invoice_number, xero_status, verified)
      values (${org()}, ${invoice.id}, 2, 'created', ${`key-${n}-2`}, '{}', 'hash', ${second}, ${`INV-${second}`}, 'DRAFT', true)`);
    return invoice;
  }

  test('a version a customer saw stays: when Xero deletes the later draft, Flow voids the invoice and keeps every version', async () => {
    // Xero approved and emailed version 1, then voided it for the revision.
    const invoice = await sentTwice('x-seen-1', 'x-seen-2', { status: 'VOIDED', emailed: true });
    const job = await attachJob(invoice);
    xero.script([live('x-seen-2', 'DRAFT'), posted('x-seen-2')]);
    const row = await remove(invoice);
    assert.equal(row.removed, undefined);
    assert.equal((await flowRow(invoice.id)).status, 'void');
    assert.deepEqual((await listInvoiceVersions(handle.db, org(), invoice.id)).map((v) => v.version), [1, 2], 'the version the customer got stays');
    assert.deepEqual(await xeroRows(invoice.id), { pushes: 2, links: 0 }, 'the record of both sends stays');
    assert.deepEqual(await history(invoice.id), []);
    assert.equal((await handle.db.select().from(billingObligations).where(eq(billingObligations.id, job.id)))[0].invoiceId, null, 'the job is free');

    // The same when the later Xero draft is already gone.
    const gone = await sentTwice('x-seen-3', 'x-seen-4', { status: 'VOIDED' });
    xero.script([live('x-seen-4', 'DELETED')]);
    assert.equal((await remove(gone)).status, 'void');
    assert.equal((await listInvoiceVersions(handle.db, org(), gone.id)).length, 2);
  });

  test('two versions that were only ever Xero drafts are removed together', async () => {
    const invoice = await sentTwice('x-unseen-1', 'x-unseen-2', { status: 'DELETED' });
    xero.script([live('x-unseen-2', 'DRAFT'), posted('x-unseen-2')]);
    assert.equal((await remove(invoice)).removed, true);
    assert.equal(await flowRow(invoice.id), undefined);
    assert.deepEqual((await history(invoice.id)).map((h) => h.xero_invoice_id).sort(), ['x-unseen-1', 'x-unseen-2']);
  });

  test('an invoice an owner override holds is voided, not removed: the override record stays', async () => {
    const invoice = await sent('x-override');
    await handle.db.execute(sql`insert into send_overrides (organisation_id, invoice_id, version, document_hash, problems, reason_code, person_id)
      values (${org()}, ${invoice.id}, 1, 'hash', '[]'::jsonb, 'one_off', ${lab.owner.id})`);
    xero.script([live('x-override', 'DRAFT'), posted('x-override')]);
    assert.equal((await remove(invoice)).status, 'void');
    assert.equal((await flowRow(invoice.id)).status, 'void');
  });

  test('writes off refuses before any accounting call, and Flow stays issued', async () => {
    const invoice = await sent('x-off');
    let called = false;
    const gate = {
      name: 'Xero',
      capabilities: {
        sendStatus: async () => ({ connected: true, writesAllowed: false }),
        deleteInvoice: () => { called = true; return { state: 'deleted', status: 'DELETED' }; },
      },
    };
    await assert.rejects(
      deleteDraft(handle.db, org(), invoice.id, { actor: actor(), accounting: gate }),
      (error) => error.code === 'accounting_writes_off'
        && error.message === 'Xero does not take invoices from this installation yet (writes are off). Nothing was issued.',
    );
    assert.equal(called, false);
    assert.equal((await flowRow(invoice.id)).status, 'issued');
  });

  test('not connected refuses with the Send gate message, and makes no request', async () => {
    const invoice = await sent('x-off-conn');
    const replay = xero.script([]);
    let called = false;
    const gate = {
      name: 'Xero',
      capabilities: {
        sendStatus: async () => ({ connected: false, writesAllowed: true }),
        deleteInvoice: () => { called = true; return { state: 'deleted', status: 'DELETED' }; },
      },
    };
    await assert.rejects(
      deleteDraft(handle.db, org(), invoice.id, { actor: actor(), accounting: gate }),
      (error) => error.code === 'accounting_not_connected'
        && error.message === 'Xero is not connected. Connect it in Integrations, then send.',
    );
    assert.equal(called, false);
    assert.equal(replay.calls.length, 0);
    assert.equal((await flowRow(invoice.id)).status, 'issued');
    const missing = await deleteXeroInvoice(handle.db, xero.runtime, {
      organisationId: '00000000-0000-4000-8000-00000000c099', invoiceId: invoice.id, actor: actor(),
    });
    assert.deepEqual(missing, { state: 'unavailable', status: null });
    assert.equal(replay.calls.length, 0);
  });

  test('an issued invoice that never reached Xero is deleted in Flow, with no Xero call', async () => {
    const draft = await createDraftInvoice(handle.db, org(), { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    const invoice = await issueInvoice(handle.db, org(), draft.id, { issuedBy: 'user:test', issueDate: '2026-10-18' });
    const replay = xero.script([]);
    assert.equal((await remove(invoice)).removed, true);
    assert.equal(replay.calls.length, 0);
    assert.equal(await flowRow(invoice.id), undefined);
  });

  test('an invoice whose only link was released never reached Xero: it is deleted, and the released pair stays as a record', async () => {
    const invoice = await sent('x-released', { linkOnly: true });
    await handle.db.execute(sql`update xero_invoice_links set released_by = ${actor()}, released_at = now() where invoice_id = ${invoice.id}`);
    const replay = xero.script([]);
    assert.equal((await remove(invoice)).removed, true);
    assert.equal(replay.calls.length, 0);
    assert.equal(await flowRow(invoice.id), undefined);
    assert.deepEqual(await xeroRows(invoice.id), { pushes: 0, links: 0 });
    assert.deepEqual(await history(invoice.id), [{ xero_invoice_id: 'x-released', invoice_number: invoice.number, matched_by: 'made', linked_by: actor(),
      released_by: actor(), deleted_by: null, removed_by: actor(), reason: 'never_sent' }]);
  });

  test('an override invoice that never reached Xero can still be resolved: Flow voids it and the override record stays', async () => {
    const overridden = async () => {
      const draft = await createDraftInvoice(handle.db, org(), { contactId: practice.id, reference: `CASE-${++n}`, lines: [{ priceItemId: crown.id }] });
      const invoice = await issueInvoice(handle.db, org(), draft.id, { issuedBy: 'user:test', issueDate: '2026-10-18' });
      await handle.db.execute(sql`insert into send_overrides (organisation_id, invoice_id, version, document_hash, problems, reason_code, person_id)
        values (${org()}, ${invoice.id}, 1, 'hash', '[]'::jsonb, 'one_off', ${lab.owner.id})`);
      return invoice;
    };
    const overrides = async (id) => (await handle.db.execute(sql`select count(*)::int as n from send_overrides where invoice_id = ${id}`)).rows[0].n;
    const replay = xero.script([]);
    // Delete: the record keeps the invoice, so Flow voids it and frees its job.
    const first = await overridden();
    const job = await attachJob(first);
    assert.equal((await remove(first)).status, 'void');
    assert.equal((await flowRow(first.id)).status, 'void');
    assert.equal((await handle.db.select().from(billingObligations).where(eq(billingObligations.id, job.id)))[0].invoiceId, null);
    // Void: allowed for this one case, though Flow sends to Xero.
    const second = await overridden();
    const secondJob = await attachJob(second);
    assert.equal((await voidInvoice(handle.db, org(), second.id, { accounting: accounting(), actor: actor() })).status, 'void');
    assert.equal((await handle.db.select().from(billingObligations).where(eq(billingObligations.id, secondJob.id)))[0].invoiceId, null, 'the job is free after Void too');
    // The route names the person, so it frees the job the same way.
    const third = await overridden();
    const thirdJob = await attachJob(third);
    const res = await request(app, `/api/invoicing/invoices/${third.id}/void`, { method: 'POST', token: lab.ownerToken, body: { organisationId: org() } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.invoice.status, 'void');
    assert.equal((await handle.db.select().from(billingObligations).where(eq(billingObligations.id, thirdJob.id)))[0].invoiceId, null);
    assert.deepEqual([await overrides(first.id), await overrides(second.id), await overrides(third.id)], [1, 1, 1]);
    assert.equal(replay.calls.length, 0, 'Xero is not called');
  });

  test('a 504 leaves Flow unchanged; the retry reads first and does not post again', async () => {
    const invoice = await sent('x-timeout');
    const failed = xero.script([live('x-timeout', 'DRAFT'), xeroAnswer(`Invoices/x-timeout`, { Message: 'timeout' }, { method: 'POST', status: 504 })]);
    await assert.rejects(remove(invoice), (error) => error.code === 'xero_api_error' && error.status === 504);
    assert.equal(posts(failed).length, 1);
    assert.equal((await flowRow(invoice.id)).status, 'issued');
    assert.equal((await pushRow(invoice.id)).deleted_at, null);
    assert.equal((await pushRow(invoice.id)).xero_status, 'DRAFT');

    const retry = xero.script([live('x-timeout', 'DELETED')]);
    assert.equal((await remove(invoice)).removed, true);
    assert.equal(retry.calls.length, 1);
    assert.equal(retry.calls[0].method, 'GET');
    assert.equal(posts(retry).length, 0);
    assert.equal(await flowRow(invoice.id), undefined);
  });

  test('one draft and one approved: the draft is removed and the approved invoice is refused', async () => {
    const draft = await sent('x-mix-d');
    const approved = await sent('x-mix-a');
    const replay = xero.script([
      live('x-mix-d', 'DRAFT'), posted('x-mix-d'),
      live('x-mix-a', 'AUTHORISED'),
    ]);
    const results = [];
    for (const invoice of [draft, approved]) {
      try {
        await remove(invoice);
        results.push('deleted');
      } catch (error) {
        results.push(`refused: ${error.message}`);
      }
    }
    assert.deepEqual(results, ['deleted', `refused: ${APPROVED_MESSAGE}`]);
    assert.equal(posts(replay).length, 1);
    assert.deepEqual(posts(replay)[0].body, { InvoiceID: 'x-mix-d', Status: 'DELETED' });
    assert.equal(await flowRow(draft.id), undefined);
    assert.equal((await flowRow(approved.id)).status, 'issued');
  });

  test('the owner can delete through the API; staff cannot', async () => {
    const invoice = await sent('x-http');
    xero.script([live('x-http', 'DRAFT'), posted('x-http')]);
    const staff = await request(app, `/api/invoicing/invoices/${invoice.id}`, { method: 'DELETE', token: lab.staffToken });
    assert.equal(staff.status, 403);
    assert.equal((await flowRow(invoice.id)).status, 'issued');
    const res = await request(app, `/api/invoicing/invoices/${invoice.id}`, { method: 'DELETE', token: lab.ownerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(await flowRow(invoice.id), undefined);
  });
});
