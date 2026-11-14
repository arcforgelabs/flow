import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createContact, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, issueInvoice } from '../server/core/invoices.js';
import { observeJob, recordAccountingEvidence, setHistoryNoCharge } from '../server/core/ledger.js';
import { oddLineReasons } from '../server/integrations/xero/import-plan.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, scriptedXero, seedLab } from './support/xero.js';

// The dry run of the full history import and reconcile cover
// (server/integrations/xero/import-plan.js). The copy is written directly;
// nothing calls Xero and the dry run writes nothing. Synthetic data only.

const XC = '00000000-0000-4000-8000-0000000000c1';
const XC2 = '00000000-0000-4000-8000-0000000000c2';
const xid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (extra = {}) => ({ itemCode: 'CROWN', quantity: 1, lineAmountCents: 25000, taxAmountCents: 2500, taxType: 'OUTPUT', ...extra });

test('a line Flow cannot hold as its own is named, not refused', () => {
  assert.deepEqual(oddLineReasons([line()]), []);
  assert.deepEqual(oddLineReasons([]), ['no_lines']);
  assert.deepEqual(oddLineReasons([line({ quantity: 0 })]), ['quantity']);
  assert.deepEqual(oddLineReasons([line({ quantity: 1.5, discountRate: 10 }), line({ lineAmountCents: -500, taxType: 'BASEXCLUDED' })]).sort(),
    ['discount', 'negative', 'part_quantity', 'tax_type']);
});

describe('Xero import: the dry run and reconcile cover', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let lab;
  let practice;
  let crown;
  const org = () => lab.organisation.id;
  const read = (path, token = lab.ownerToken) => request(app, `/api/xero/import/${path}?organisationId=${org()}`, { token });

  async function copy(n, { number = `INV-${String(n).padStart(4, '0')}`, contact = XC, issuedOn = '2024-05-10', total = 27500, status = 'PAID', credited = 0, lines = [line()] } = {}) {
    const due = status === 'AUTHORISED' ? total : 0;
    await handle.db.execute(sql`insert into xero_invoices (organisation_id, xero_invoice_id, type, invoice_number, xero_contact_id, status, issued_on,
        subtotal_cents, tax_cents, total_cents, amount_due_cents, amount_paid_cents, amount_credited_cents, lines, record_hash)
      values (${org()}, ${xid(n)}, 'ACCREC', ${number}, ${contact}, ${status}, ${issuedOn},
        ${total - 2500}, 2500, ${total}, ${due}, ${status === 'PAID' ? total - credited : 0}, ${credited}, ${JSON.stringify(lines)}::jsonb, 'h')`);
    return xid(n);
  }
  const job = (ref, extra = {}) => observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: ref, caseRef: ref, contactId: practice.id, shippedOn: '2024-05-10', jobDate: '2024-05-10', lines: [{ itemCode: 'CROWN' }], ...extra });
  const counts = async () => (await handle.pool.query(`select (select count(*) from invoices) as invoices, (select count(*) from contacts) as contacts,
    (select count(*) from xero_invoice_links) as links, (select next_invoice_number from organisations where id = $1) as next`, [org()])).rows[0];

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
      values (${org()}, ${XC}, 'Example Practice', 'ACTIVE', true, false, '[]'::jsonb, now()),
             (${org()}, ${XC2}, 'New Clinic', 'ACTIVE', true, false, '[]'::jsonb, now())`);

    // Flow's own invoice INV-0001, sent to Xero as Xero invoice 1.
    const draft = await createDraftInvoice(handle.db, org(), { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    const own = await issueInvoice(handle.db, org(), draft.id, { issuedBy: 'user:test', issueDate: '2026-10-18' });
    await copy(1, { number: own.number, issuedOn: '2026-10-18', status: 'AUTHORISED' });
    await handle.db.execute(sql`insert into xero_invoice_links (organisation_id, xero_invoice_id, invoice_id, matched_by, linked_by) values (${org()}, ${xid(1)}, ${own.id}, 'auto', 'test')`);
    // A Flow invoice made earlier from Xero invoice 2 (INV-0050): it took the
    // Flow number INV-0002, which Xero invoice 3 holds.
    const madeDraft = await createDraftInvoice(handle.db, org(), { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    const made = await issueInvoice(handle.db, org(), madeDraft.id, { issuedBy: 'user:test', issueDate: '2024-05-10' });
    assert.equal(made.number, 'INV-0002');
    await copy(2, { number: 'INV-0050' });
    await handle.db.execute(sql`insert into xero_invoice_links (organisation_id, xero_invoice_id, invoice_id, matched_by, linked_by) values (${org()}, ${xid(2)}, ${made.id}, 'made', 'test')`);
    await copy(3, { number: 'INV-0002', issuedOn: '2022-07-01' });
    // History: a paid one two jobs share, a credited one, an odd one for a
    // contact Flow does not have, a void, a Xero draft, and a removed draft.
    await copy(4, { issuedOn: '2023-02-01' });
    await copy(5, { issuedOn: '2023-03-01', credited: 5000 });
    await copy(6, { contact: XC2, issuedOn: '2024-06-01', lines: [line({ quantity: 0 })] });
    await copy(7, { issuedOn: '2024-06-02', status: 'VOIDED' });
    await copy(8, { issuedOn: '2026-11-01', status: 'DRAFT' });
    await copy(9, { issuedOn: '2026-11-02', status: 'DELETED' });
    await copy(10, { number: 'INV-0120', issuedOn: '2025-01-05', status: 'AUTHORISED' });
    for (const ref of ['JOB-A', 'JOB-B']) {
      const tied = await job(ref);
      await recordAccountingEvidence(handle.db, org(), tied.id, { state: 'paid', accountingRef: xid(4), matchedBy: 'accounting_ref', actor: 'test' });
    }
    await recordAccountingEvidence(handle.db, org(), (await job('JOB-C')).id, { state: 'not_found', actor: 'test' });
    await setHistoryNoCharge(handle.db, org(), (await job('JOB-D')).id, { reason: 'own clinic', actor: 'person:test' });
    await job('JOB-E');
  });
  after(async () => handle?.close());

  test('the dry run counts what the import would do, and writes nothing', async () => {
    const before = await counts();
    const res = await read('dry-run');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const plan = res.body;
    assert.equal(plan.writes, false);
    // No full read of Xero was recorded: the import would refuse to run.
    assert.deepEqual([plan.copy.complete, plan.canRun, plan.switchOn], [false, false, false]);
    assert.deepEqual(plan.invoices.byStatus, { AUTHORISED: 2, PAID: 5, VOIDED: 1, DRAFT: 1 });
    assert.deepEqual([plan.invoices.total, plan.invoices.inFlow, plan.invoices.toImport, plan.invoices.leftOut], [9, 2, 7, 1]);
    assert.deepEqual(plan.invoices.byYear.find((y) => y.year === '2024'), { year: '2024', total: 3, toImport: 2, inFlow: 1, void: 1 });
    assert.deepEqual(plan.invoices.byYear.map((y) => y.year), ['2022', '2023', '2024', '2025', '2026']);
    // INV-0002 is a Xero number that a Flow invoice of another Xero invoice holds.
    assert.equal(plan.numbers.taken.count, 1);
    assert.deepEqual(plan.numbers.taken.sample.map((s) => s.number), ['INV-0002']);
    assert.deepEqual(plan.blocked, { noNumber: 0, numberTaken: 1, numberTwice: 0, noContact: 0 });
    // Flow's next number moves above the highest Xero number.
    assert.deepEqual(plan.numbers.next, { now: 3, after: 121 });
    assert.deepEqual(plan.madeEarlier, { count: 1, otherNumber: 1 });
    assert.deepEqual(plan.contacts, { linked: 0, byName: 1, toCreate: 1, invoicesWithNoContact: 0 });
    assert.equal(plan.oddLines.invoices, 1);
    assert.deepEqual(plan.oddLines.byReason, { quantity: 1 });
    assert.deepEqual(plan.credited, { invoices: 1, creditedCents: 5000 });
    assert.deepEqual(plan.jobs, { invoicesWithJobs: 1, jobs: 2, invoicesWithSeveralJobs: 1 });
    assert.deepEqual(plan.money.void, { count: 1, totalCents: 27500, dueCents: 0 });
    assert.deepEqual(plan.money.awaiting, { count: 2, totalCents: 55000, dueCents: 55000 });
    assert.deepEqual([plan.money.paid.count, plan.money.draft.count], [5, 1]);
    assert.deepEqual(await counts(), before, 'no invoice, contact, link or number changed');
  });

  test('the dry run runs only on a complete, fresh copy', async () => {
    await handle.db.execute(sql`insert into xero_mirror_cursors (organisation_id, resource, passes, last_pass_finished_at)
      values (${org()}, 'invoices', 1, now()), (${org()}, 'credit_notes', 1, now())`);
    assert.equal((await read('dry-run')).body.canRun, true);
    await handle.db.execute(sql`update xero_mirror_cursors set last_pass_finished_at = now() - interval '3 days' where organisation_id = ${org()}`);
    const stale = (await read('dry-run')).body;
    assert.deepEqual([stale.copy.complete, stale.copy.fresh, stale.canRun], [true, false, false]);
  });

  test('reconcile cover says where each record stands, on both sides', async () => {
    const res = await read('cover', lab.staffToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { invoices, jobs } = res.body;
    assert.deepEqual([invoices.total, invoices.inFlow, invoices.tied, invoices.void], [9, 2, 1, 1]);
    assert.equal(invoices.inFlow + invoices.tied + invoices.fits + invoices.none + invoices.void, invoices.total);
    assert.deepEqual([jobs.total, jobs.invoiced, jobs.tied, jobs.noCharge, jobs.needsPerson, jobs.open], [5, 0, 2, 1, 1, 1]);
    assert.equal(jobs.invoiced + jobs.tied + jobs.noCharge + jobs.needsPerson + jobs.open, jobs.total);
  });
});
