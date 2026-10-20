import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { createContact, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, issueInvoice } from '../server/core/invoices.js';
import { observeJob, recordAccountingEvidence, setReady } from '../server/core/ledger.js';
import { billingObligations, invoices } from '../server/db/schema.js';
import { importOverview, matchXero } from '../server/integrations/xero/links.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, scriptedXero, seedLab } from './support/xero.js';

// The Xero Import page (server/integrations/xero/links.js): each Xero sales
// invoice in Flow's copy against Flow's own invoices. The copy is written
// directly; nothing calls Xero. Synthetic data only.

const XC = '00000000-0000-4000-8000-0000000000c1';
const XC2 = '00000000-0000-4000-8000-0000000000c2';
const xid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Xero import: Xero invoices against Flow invoices', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let lab;
  let practice;
  let crown;

  before(async () => {
    handle = await freshDatabase();
    const xero = scriptedXero();
    const booted = await bootFlow(handle, { runtime: xero.runtime, log: xero.log });
    app = booted.app;
    lab = await seedLab(handle, booted.clerk);
    practice = await createContact(handle.db, lab.organisation.id, { kind: 'customer', name: 'Example Practice' });
    crown = await createPriceItem(handle.db, lab.organisation.id, { code: 'CROWN', name: 'Crown', unitAmountCents: 25000 });
    await connectDirectly(handle, xero.runtime, lab.organisation.id);
    await handle.db.execute(sql`insert into xero_contacts (organisation_id, xero_contact_id, name, status, is_customer, is_supplier, sales_tracking, synced_at)
      values (${lab.organisation.id}, ${XC}, 'Example Practice', 'ACTIVE', true, false, '[]'::jsonb, now()),
             (${lab.organisation.id}, ${XC2}, 'New Clinic', 'ACTIVE', true, false, '[]'::jsonb, now())`);
  });
  after(async () => handle?.close());

  const org = () => lab.organisation.id;
  const call = (path, options = {}) => request(app, `/api/xero${path}`, { token: lab.ownerToken, ...options });

  // A Xero invoice in the copy: one crown, 250.00 + 25.00 GST.
  async function copy(n, { contact = XC, issuedOn = '2026-10-18', total = 27500, status = 'AUTHORISED' } = {}) {
    await handle.db.execute(sql`insert into xero_invoices (organisation_id, xero_invoice_id, type, invoice_number, xero_contact_id, status, issued_on,
        subtotal_cents, tax_cents, total_cents, amount_due_cents, amount_paid_cents, amount_credited_cents, lines, record_hash)
      values (${org()}, ${xid(n)}, 'ACCREC', ${`INV-${n}`}, ${contact}, ${status}, ${issuedOn},
        ${total - 2500}, 2500, ${total}, ${total}, 0, 0,
        ${JSON.stringify([{ itemCode: 'CROWN', quantity: 1, lineAmountCents: total - 2500, taxAmountCents: 2500 }])}::jsonb, 'h')`);
    return xid(n);
  }
  const flowInvoice = async (issueDate = '2026-10-18') => {
    const draft = await createDraftInvoice(handle.db, org(), { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    return issueInvoice(handle.db, org(), draft.id, { issuedBy: 'user:test', issueDate });
  };
  const stateOf = async (id) => (await importOverview(handle.db, org(), { limit: 500 })).rows.find((r) => r.xeroInvoiceId === id);

  test('a Xero invoice with one sure Flow fit is linked; two fits wait for a person', async () => {
    const own = await flowInvoice();
    const sure = await copy(1);
    assert.equal((await stateOf(sure)).state, 'invoice_fits');
    assert.equal((await stateOf(sure)).sure, true);
    const result = await matchXero(handle.db, org());
    assert.equal(result.linked, 1);
    const linked = await stateOf(sure);
    assert.equal(linked.state, 'linked');
    assert.deepEqual([linked.link.invoiceId, linked.link.matchedBy], [own.id, 'auto']);

    const a = await copy(2, { issuedOn: '2026-10-01' });
    const b = await copy(3, { issuedOn: '2026-10-02' });
    const one = await flowInvoice('2026-10-01');
    assert.equal((await stateOf(a)).sure, false, 'one Flow invoice fits two Xero invoices');
    assert.equal((await matchXero(handle.db, org())).linked, 0);
    const res = await call(`/import/${b}/link`, { method: 'POST', body: { organisationId: org(), invoiceId: one.id } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await stateOf(b)).link.matchedBy, 'person');
    const again = await call(`/import/${a}/link`, { method: 'POST', body: { organisationId: org(), invoiceId: one.id } });
    assert.equal(again.status, 400, 'one Xero invoice per Flow invoice');
  });

  test('a Flow invoice linked here shows its Xero status like a sent one', async () => {
    const own = await flowInvoice('2026-09-01');
    const id = await copy(4, { issuedOn: '2026-09-01', status: 'PAID' });
    await matchXero(handle.db, org());
    const res = await request(app, '/api/xero/invoices/status', { token: lab.staffToken, method: 'POST', body: { organisationId: org(), invoiceIds: [own.id] } });
    const [status] = res.body.invoices;
    assert.equal(status.state, 'paid');
    assert.equal(status.xero.invoiceId, id);
    assert.equal(status.linkedBy, 'auto');
    assert.equal(status.finding, null);
  });

  test('a job the matcher tied to a Xero invoice is a job fit; Make Flow invoice links all three', async () => {
    const job = await observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-T', caseRef: 'CASE-T', contactId: practice.id, shippedOn: '2026-08-10', jobDate: '2026-08-10', lines: [{ itemCode: 'CROWN' }] });
    await setReady(handle.db, org(), job.id, { actor: 'person:test' });
    const id = await copy(5, { issuedOn: '2026-08-10' });
    await recordAccountingEvidence(handle.db, org(), job.id, { state: 'authorised', accountingRef: id, matchedBy: 'prior_link', actor: 'person:test' });
    const row = await stateOf(id);
    assert.equal(row.state, 'job_fits');
    assert.deepEqual(row.jobs.map((j) => [j.id, j.tied]), [[job.id, true]]);
    const made = await call(`/import/${id}/make`, { method: 'POST', body: { organisationId: org(), jobId: job.id } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const [invoice] = await handle.db.select().from(invoices).where(eq(invoices.id, made.body.invoice.id));
    assert.equal(invoice.status, 'issued');
    assert.equal(invoice.issueDate, '2026-08-10');
    assert.equal(invoice.totalCents, 27500);
    const [linkedJob] = await handle.db.select().from(billingObligations).where(and(eq(billingObligations.organisationId, org()), eq(billingObligations.id, job.id)));
    assert.equal(linkedJob.invoiceId, invoice.id);
    assert.equal((await stateOf(id)).link.matchedBy, 'made');
  });

  test('nothing fits: it stays in the copy, until the setting makes Flow invoices', async () => {
    const id = await copy(6, { contact: XC2, issuedOn: '2026-07-01' });
    assert.equal((await stateOf(id)).state, 'none');
    assert.equal((await matchXero(handle.db, org())).made, 0, 'off by default');
    const saved = await call('/import/settings', { method: 'PUT', body: { organisationId: org(), makeUnmatched: true } });
    assert.equal(saved.body.settings.makeUnmatched, true);
    const result = await matchXero(handle.db, org());
    assert.equal(result.made, 2, 'this one, and INV-2, whose only fit a person gave to INV-3');
    const row = await stateOf(id);
    assert.equal(row.link.matchedBy, 'made');
    const page = await call(`/import?organisationId=${org()}&show=linked&q=INV-6`);
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.rows.map((r) => r.number), ['INV-6']);
    assert.ok(page.body.counts.linked >= 4);
    await call('/import/settings', { method: 'PUT', body: { organisationId: org(), makeUnmatched: false } });
  });

  test('only an owner or admin links, makes or changes the setting', async () => {
    const id = await copy(7, { contact: XC2, issuedOn: '2026-06-01' });
    const res = await request(app, `/api/xero/import/${id}/make`, { token: lab.staffToken, method: 'POST', body: { organisationId: org() } });
    assert.equal(res.status, 403);
    const read = await request(app, `/api/xero/import?organisationId=${org()}`, { token: lab.staffToken });
    assert.equal(read.status, 200);
  });
});
