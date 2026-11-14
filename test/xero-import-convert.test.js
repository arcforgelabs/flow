import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createContact, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, issueInvoice } from '../server/core/invoices.js';
import { observeJob } from '../server/core/ledger.js';
import { makeFlowInvoice } from '../server/integrations/xero/links.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, scriptedXero, seedLab } from './support/xero.js';

// Flow invoices made earlier from a Xero invoice become that Xero invoice,
// imported with its Xero number (convertMadeInvoices, import-history.js). The
// copies are made as the Import page made them; nothing calls Xero.
// Synthetic data only.

const XC = '00000000-0000-4000-8000-0000000000c1';
const xid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = { itemCode: 'CROWN', description: 'Crown', quantity: 1, unitAmount: 250, lineAmountCents: 25000, taxAmountCents: 2500, taxType: 'OUTPUT' };

describe('Xero import: made invoices become imported ones', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let lab;
  let practice;
  let crown;
  let job;
  let before0;
  const made = {};
  const org = () => lab.organisation.id;
  const convert = (body = {}, token = lab.ownerToken) => request(app, '/api/xero/import/history/convert', { token, method: 'POST', body: { organisationId: org(), ...body } });
  const query = async (text, values = []) => (await handle.pool.query(text, values)).rows;
  const invoiceBy = async (number) => (await query(`select i.id, i.number, i.origin, i.status, i.contact_id, l.xero_invoice_id, l.batch_id, l.linked_by from invoices i
    left join xero_invoice_links l on l.invoice_id = i.id and l.released_at is null where i.organisation_id = $1 and i.number = $2`, [org(), number]))[0];
  const jobRow = async () => (await query('select invoice_id, accounting_ref, accounting_state, hold_state from billing_obligations where id = $1', [job.id]))[0];
  // Every invoice with its origin, status and Xero invoice: what a run may change.
  const state = () => query(`select i.number, i.origin, i.status, l.xero_invoice_id from invoices i
    left join xero_invoice_links l on l.invoice_id = i.id where i.organisation_id = $1 order by i.number`, [org()]);

  // One Xero invoice in the copy, and the Flow invoice the Import page made from it.
  async function copyAndMake(n, number, { status = 'PAID', jobId = null } = {}) {
    await handle.db.execute(sql`insert into xero_invoices (organisation_id, xero_invoice_id, type, invoice_number, xero_contact_id, status, issued_on, due_on,
        subtotal_cents, tax_cents, total_cents, amount_due_cents, amount_paid_cents, lines, record_hash)
      values (${org()}, ${xid(n)}, 'ACCREC', ${number}, ${XC}, ${status}, '2024-03-01', '2024-03-15',
        25000, 2500, 27500, ${status === 'AUTHORISED' ? 27500 : 0}, ${status === 'PAID' ? 27500 : 0}, ${JSON.stringify([line])}::jsonb, ${`h${n}`})`);
    made[n] = (await makeFlowInvoice(handle.db, org(), xid(n), { jobId, actor: 'person:test' })).invoice;
    return made[n];
  }

  before(async () => {
    handle = await freshDatabase();
    const xero = scriptedXero();
    const booted = await bootFlow(handle, { runtime: xero.runtime, log: xero.log });
    app = booted.app;
    lab = await seedLab(handle, booted.clerk);
    practice = await createContact(handle.db, org(), { kind: 'customer', name: 'Example Practice' });
    crown = await createPriceItem(handle.db, org(), { code: 'CROWN', name: 'Crown', unitAmountCents: 25000 });
    await connectDirectly(handle, xero.runtime, org());
    await handle.db.execute(sql`insert into xero_contacts (organisation_id, xero_contact_id, name, status, is_customer, is_supplier, sales_tracking, synced_at)
      values (${org()}, ${XC}, 'Example Practice', 'ACTIVE', true, false, '[]'::jsonb, now())`);
    job = await observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-C1', caseRef: 'JOB-C1', contactId: practice.id, shippedOn: '2024-03-01', jobDate: '2024-03-01', lines: [{ itemCode: 'CROWN' }] });

    // Two copies whose Flow number is the other's Xero number, one with a job.
    assert.equal((await copyAndMake(1, 'INV-0002', { jobId: job.id })).number, 'INV-0001');
    assert.equal((await copyAndMake(2, 'INV-0001', { status: 'AUTHORISED' })).number, 'INV-0002');
    // Xero voided this one: a customer saw it.
    assert.equal((await copyAndMake(3, 'INV-0900', { status: 'AUTHORISED' })).number, 'INV-0003');
    await handle.db.execute(sql`update xero_invoices set status = 'VOIDED', amount_due_cents = 0 where organisation_id = ${org()} and xero_invoice_id = ${xid(3)}`);
    // Its Xero number is the number of an invoice Flow issued itself, so it
    // stays; and then its own Flow number keeps the next copy out too.
    assert.equal((await copyAndMake(4, 'INV-0005')).number, 'INV-0004');
    const own = await createDraftInvoice(handle.db, org(), { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    assert.equal((await issueInvoice(handle.db, org(), own.id, { issuedBy: 'user:test', issueDate: '2026-11-01' })).number, 'INV-0005');
    assert.equal((await copyAndMake(5, 'INV-0004')).number, 'INV-0006');
    // An owner's override holds this one.
    await copyAndMake(6, 'INV-0950');
    await handle.db.execute(sql`insert into send_overrides (organisation_id, invoice_id, version, document_hash, problems, reason_code, person_id)
      values (${org()}, ${made[6].id}, 1, 'hash', '[]'::jsonb, 'one_off', ${lab.owner.id})`);
    // Flow sent this one to Xero as another Xero invoice.
    await copyAndMake(7, 'INV-0960');
    await handle.db.execute(sql`insert into xero_invoice_pushes (organisation_id, invoice_id, version, state, idempotency_key, request_body, body_hash, xero_invoice_id, xero_invoice_number, xero_status, verified)
      values (${org()}, ${made[7].id}, 1, 'created', 'key-7', '{}', 'hash', ${xid(70)}, 'INV-0008', 'AUTHORISED', true)`);
    // Xero's is a draft again: no customer sees it, so the import does not take it.
    await copyAndMake(8, 'INV-0970', { status: 'AUTHORISED' });
    await handle.db.execute(sql`update xero_invoices set status = 'DRAFT' where organisation_id = ${org()} and xero_invoice_id = ${xid(8)}`);
    // Void in Flow while Xero's is live: a person looks at that pair.
    await copyAndMake(9, 'INV-0980', { status: 'AUTHORISED' });
    await handle.db.execute(sql`update invoices set status = 'void' where id = ${made[9].id}`);
    before0 = await state();
  });
  after(async () => handle?.close());

  test('it runs only with the import on, on a fresh copy, for an owner or admin', async () => {
    const off = await convert({ dryRun: true });
    assert.deepEqual([off.status, off.body.code], [409, 'import_off']);
    await request(app, '/api/xero/import/settings', { token: lab.ownerToken, method: 'PUT', body: { organisationId: org(), makeUnmatched: true } });
    const stale = await convert({ dryRun: true });
    assert.deepEqual([stale.status, stale.body.code], [409, 'copy_not_ready']);
    await handle.db.execute(sql`insert into xero_mirror_cursors (organisation_id, resource, passes, last_pass_finished_at)
      values (${org()}, 'invoices', 1, now()), (${org()}, 'credit_notes', 1, now())`);
    assert.equal((await convert({ dryRun: true }, lab.staffToken)).status, 403);
  });

  test('a dry run says what would change, and changes nothing', async () => {
    const res = await convert({ dryRun: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { dryRun, candidates, converted, jobsKept, skipped, invoices } = res.body;
    assert.deepEqual({ dryRun, candidates, converted, void: res.body.void, jobsKept }, { dryRun: true, candidates: 9, converted: 3, void: 1, jobsKept: 1 });
    assert.deepEqual(skipped, { sent: 1, override: 1, notIssued: 0, notImported: 1, voidInFlow: 1, noNumber: 0, jobElsewhere: 0, numberTaken: 2 });
    assert.deepEqual(invoices.filter((i) => !i.skipped).map((i) => [i.flowNumber, i.number]).sort(), [['INV-0001', 'INV-0002'], ['INV-0002', 'INV-0001'], ['INV-0003', 'INV-0900']]);
    assert.equal(invoices.some((i) => i.invoiceId), false, 'a dry run names no invoice it made');
    assert.deepEqual(await state(), before0);
    assert.equal((await jobRow()).invoice_id, made[1].id);
    assert.equal((await query('select count(*)::int as n from xero_invoice_link_history where organisation_id = $1', [org()]))[0].n, 0);
    assert.equal((await query('select next_invoice_number as n from organisations where id = $1', [org()]))[0].n, 11);
  });

  test('each copy becomes the Xero invoice with its Xero number; the pair stays as a record', async () => {
    // Two requests at the same time: one run changes the copies, and the
    // other waits for it and finds nothing left to change.
    const [res, late] = (await Promise.all([convert(), convert()])).sort((a, b) => (b.body.converted ?? 0) - (a.body.converted ?? 0));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.dryRun, res.body.converted, res.body.void], [false, 3, 1]);
    assert.deepEqual([late.status, late.body.candidates, late.body.converted], [200, 6, 0], JSON.stringify(late.body));

    // The two copies swapped numbers: each number now names its Xero invoice.
    const two = await invoiceBy('INV-0002');
    const one = await invoiceBy('INV-0001');
    const gone = await invoiceBy('INV-0900');
    assert.deepEqual([two.origin, two.status, two.xero_invoice_id], ['xero', 'issued', xid(1)]);
    assert.deepEqual([one.origin, one.status, one.xero_invoice_id], ['xero', 'issued', xid(2)]);
    assert.deepEqual([gone.origin, gone.status, gone.xero_invoice_id], ['xero', 'void', xid(3)]);
    assert.deepEqual([two.batch_id, two.linked_by, two.contact_id], [null, `person:${lab.owner.id}`, practice.id], 'no batch holds it: no undo of a year removes it');
    assert.equal((await query('select count(*)::int as n from invoices where id = any($1::uuid[])', [[made[1].id, made[2].id, made[3].id]]))[0].n, 0, 'the made copies are gone');
    const [{ document }] = await query('select document from invoice_versions where invoice_id = $1', [two.id]);
    assert.deepEqual([document.number, document.totalCents, document.source.invoiceId], ['INV-0002', 27500, xid(1)]);

    const history = await query('select xero_invoice_id, invoice_number, matched_by, reason, removed_by from xero_invoice_link_history where organisation_id = $1 order by invoice_number', [org()]);
    assert.deepEqual(history.map((h) => [h.xero_invoice_id, h.invoice_number, h.matched_by, h.reason]),
      [[xid(1), 'INV-0001', 'made', 'converted_to_import'], [xid(2), 'INV-0002', 'made', 'converted_to_import'], [xid(3), 'INV-0003', 'made', 'converted_to_import']]);
    assert.equal(history[0].removed_by, `person:${lab.owner.id}`);

    // Every copy that was skipped is as it was.
    const kept = (rows) => rows.filter((r) => !['INV-0001', 'INV-0002', 'INV-0003', 'INV-0900'].includes(r.number));
    assert.deepEqual(kept(await state()), kept(before0));
    // Flow's next number is above every Xero number of its form.
    assert.equal((await query('select next_invoice_number as n from organisations where id = $1', [org()]))[0].n, 981);
  });

  test('the job stays tied to the Xero invoice, and shows as paid, not as a job to draft', async () => {
    const two = await invoiceBy('INV-0002');
    assert.deepEqual(await jobRow(), { invoice_id: null, accounting_ref: xid(1), accounting_state: 'paid', hold_state: 'none' });
    const [event] = await query(`select actor, evidence from obligation_events where obligation_id = $1 and kind = 'draft_deleted'`, [job.id]);
    assert.deepEqual([event.evidence.reason, event.evidence.number, event.evidence.xeroInvoiceId, event.evidence.removed], ['converted_to_import', 'INV-0001', xid(1), true]);

    const listed = await request(app, `/api/invoicing/jobs?organisationId=${org()}`, { token: lab.ownerToken });
    assert.equal(listed.body.jobs.find((j) => j.id === job.id).view, 'paid');
    const page = await request(app, `/api/invoicing/invoices/${two.id}?organisationId=${org()}`, { token: lab.ownerToken });
    assert.deepEqual([page.body.invoice.imported, page.body.invoice.tiedJobs.map((j) => j.sourceJobRef)], [true, ['JOB-C1']]);
  });

  test('a second run finds nothing to change', async () => {
    const res = await convert();
    assert.deepEqual([res.status, res.body.candidates, res.body.converted], [200, 6, 0]);
    assert.equal((await query('select count(*)::int as n from xero_invoice_link_history where organisation_id = $1', [org()]))[0].n, 3);
  });
});
