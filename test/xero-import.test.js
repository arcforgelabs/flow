import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { createContact, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, issueInvoice } from '../server/core/invoices.js';
import { saveCustomerBilling } from '../server/core/invoicing-rules.js';
import { linkJobToInvoice, observeJob, recordAccountingEvidence, setReady } from '../server/core/ledger.js';
import { billingObligations, invoices } from '../server/db/schema.js';
import { importOverview, matchXero, useXeroInvoice } from '../server/integrations/xero/links.js';
import { findInvoices } from '../server/integrations/xero/lookup.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, scriptedXero, seedLab } from './support/xero.js';

// The Xero Import page (server/integrations/xero/links.js): each Xero sales
// invoice in Flow's copy against Flow's own invoices. The copy is written
// directly; nothing calls Xero. Synthetic data only.

const XC = '00000000-0000-4000-8000-0000000000c1';
const XC2 = '00000000-0000-4000-8000-0000000000c2';
const XC3 = '00000000-0000-4000-8000-0000000000c3';
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

  test('a history job with no invoice found that a person pairs with a Xero invoice no longer needs a person', async () => {
    const job = await observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-NF', caseRef: 'CASE-NF', contactId: practice.id, shippedOn: '2026-08-12', jobDate: '2026-08-12', lines: [{ itemCode: 'CROWN' }] });
    await recordAccountingEvidence(handle.db, org(), job.id, { state: 'not_found', actor: 'test' });
    const id = await copy(17, { issuedOn: '2026-08-12', status: 'PAID' });
    const made = await call(`/import/${id}/make`, { method: 'POST', body: { organisationId: org(), jobId: job.id } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const [row] = await handle.db.select().from(billingObligations).where(and(eq(billingObligations.organisationId, org()), eq(billingObligations.id, job.id)));
    // The job's accounting state is written in the same step, from the copy.
    assert.equal(row.accountingState, 'paid', 'billed and paid at once, not after the next pass');
    assert.equal(row.accountingRef, id, 'the matcher follows the paired invoice');
    assert.equal(row.accountingMatchedBy, 'accounting_ref');
    // A job linked before this change (no accountingRef) is found through its
    // Flow invoice, so the matcher settles it too.
    const { invoices: byFlow } = await findInvoices(handle.db, org(), { flowInvoiceIds: [made.body.invoice.id] });
    assert.deepEqual(byFlow.map((i) => [i.id, i.flowInvoiceId]), [[id, made.body.invoice.id]]);
  });

  test('a job with no accounting contact, checked already, is settled by the pair in the same step', async () => {
    // No Xero contact for its client: the matcher checked it and left it
    // `unknown`. It would not be read again until the copy changed.
    const job = await observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-NC', caseRef: 'CASE-NC', contactId: practice.id, shippedOn: '2026-08-14', jobDate: '2026-08-14', lines: [{ itemCode: 'CROWN' }] });
    await handle.db.update(billingObligations).set({ accountingCheckedAt: new Date() }).where(eq(billingObligations.id, job.id));
    const id = await copy(18, { issuedOn: '2026-08-14' });
    const made = await call(`/import/${id}/make`, { method: 'POST', body: { organisationId: org(), jobId: job.id } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const [row] = await handle.db.select().from(billingObligations).where(and(eq(billingObligations.organisationId, org()), eq(billingObligations.id, job.id)));
    assert.deepEqual([row.accountingState, row.accountingRef, row.invoiceId], ['authorised', id, made.body.invoice.id]);
  });

  test('a client billed to another customer finds the payer\'s Xero invoices; Make keeps the Flow invoice with the client', async () => {
    const member = await createContact(handle.db, org(), { kind: 'customer', name: 'Member Clinic' });
    await saveCustomerBilling(handle.db, org(), member.id, { billToContactId: practice.id });
    const job = await observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-BT', caseRef: 'CASE-BT', contactId: member.id, shippedOn: '2026-09-03', jobDate: '2026-09-03', lines: [{ itemCode: 'CROWN' }] });
    const id = await copy(19, { issuedOn: '2026-09-03' });
    const row = await stateOf(id);
    assert.deepEqual(row.jobs.map((j) => [j.id, j.tied]), [[job.id, false]]);
    const made = await call(`/import/${id}/make`, { method: 'POST', body: { organisationId: org(), jobId: job.id } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const [invoice] = await handle.db.select().from(invoices).where(eq(invoices.id, made.body.invoice.id));
    assert.equal(invoice.contactId, member.id, 'the work was for the clinic; the payer is only who Xero bills');
    // Use the Xero invoice for a client's own Flow invoice, with no job: the
    // new Flow invoice stays with the client too.
    const own = await createDraftInvoice(handle.db, org(), { contactId: member.id, lines: [{ priceItemId: crown.id }] });
    const issuedOwn = await issueInvoice(handle.db, org(), own.id, { issuedBy: 'user:test', issueDate: '2026-09-04' });
    const payerBill = await copy(20, { issuedOn: '2026-09-04' });
    const used = await useXeroInvoice(handle.db, org(), issuedOwn.id, { xeroInvoiceId: payerBill, actor: 'person:test' });
    const [replaced] = await handle.db.select().from(invoices).where(eq(invoices.id, used.invoice.id));
    assert.equal(replaced.contactId, member.id);
    // An invoice under the clinic's own Xero contact still fits its jobs.
    await handle.db.execute(sql`insert into xero_contacts (organisation_id, xero_contact_id, name, status, is_customer, is_supplier, sales_tracking, synced_at)
      values (${org()}, ${XC3}, 'Member Clinic', 'ACTIVE', true, false, '[]'::jsonb, now())`);
    const later = await observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-BT2', caseRef: 'CASE-BT2', contactId: member.id, shippedOn: '2026-09-08', jobDate: '2026-09-08', lines: [{ itemCode: 'CROWN' }] });
    const ownBill = await copy(25, { contact: XC3, issuedOn: '2026-09-08' });
    assert.deepEqual((await stateOf(ownBill)).jobs.map((j) => j.id), [later.id]);
    await saveCustomerBilling(handle.db, org(), member.id, { billToContactId: null });
  });

  test('a wrong pair is released: Flow\'s copy of the Xero invoice is removed, never voided, and both jobs can be paired again', async () => {
    const job = (ref, day) => observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: ref, caseRef: ref, contactId: practice.id, shippedOn: day, jobDate: day, lines: [{ itemCode: 'CROWN' }] });
    const wrong = await job('JOB-W1', '2026-09-17');
    const right = await job('JOB-W2', '2026-09-18');
    const theirs = await copy(30, { issuedOn: '2026-09-18' });
    const own = await copy(31, { issuedOn: '2026-09-17' });
    // The pair made by mistake: the wrong job got the other job's bill.
    const made = await call(`/import/${theirs}/make`, { method: 'POST', body: { organisationId: org(), jobId: wrong.id } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const release = (body) => call(`/import/${theirs}/release`, { method: 'POST', body: { organisationId: org(), reason: 'wrong pair: another job', ...body } });
    const refused = await call(`/import/${own}/make`, { method: 'POST', body: { organisationId: org(), jobId: wrong.id } });
    assert.match(refused.body.error, /already/, 'before the release, the job still holds the other bill');
    assert.equal((await release({ reason: '' })).status, 400);
    // Void is only for what a customer saw: the made invoice was only Flow's
    // copy of the Xero one, so the release removes it. Nothing is voided.
    const released = await release();
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.invoice.removed, true);
    assert.deepEqual(released.body.jobs, [wrong.id]);
    assert.deepEqual(await handle.db.select().from(invoices).where(eq(invoices.id, made.body.invoice.id)), []);
    // The released pair stays as a record after its link row went with the copy.
    const { rows: pairs } = await handle.db.execute(sql`select xero_invoice_id, invoice_number, matched_by, released_by is not null as released, removed_by is not null as removed, reason
      from xero_invoice_link_history where invoice_id = ${made.body.invoice.id}`);
    assert.deepEqual(pairs, [{ xero_invoice_id: theirs, invoice_number: made.body.invoice.number, matched_by: 'made', released: true, removed: true, reason: 'wrong pair: another job' }]);
    const { rows: [{ voids }] } = await handle.db.execute(sql`select count(*)::int as voids from invoices where organisation_id = ${org()} and status = 'void'`);
    assert.equal(voids, 0);
    const [freed] = await handle.db.select().from(billingObligations).where(eq(billingObligations.id, wrong.id));
    assert.deepEqual([freed.accountingRef, freed.accountingState], [null, 'unknown']);
    const { rows: rejected } = await handle.db.execute(sql`select external_id from link_rejections where obligation_id = ${wrong.id}`);
    assert.deepEqual(rejected.map((r) => r.external_id), [theirs], 'the matcher never pairs the two again');
    assert.notEqual((await stateOf(theirs)).state, 'linked');
    // Each job now gets its own bill.
    for (const [id, jobId] of [[theirs, right.id], [own, wrong.id]]) {
      const res = await call(`/import/${id}/make`, { method: 'POST', body: { organisationId: org(), jobId } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await stateOf(id)).link.matchedBy, 'made');
    }
    const { rows: history } = await handle.db.execute(sql`select released_by from xero_invoice_links where xero_invoice_id = ${theirs}`);
    assert.deepEqual(history.map((r) => r.released_by), [null], 'one row: the new link took the released one\'s place');
    // A Flow invoice Flow sent to that Xero invoice is that invoice: its link stays.
    const { rows: [link] } = await handle.db.execute(sql`select invoice_id from xero_invoice_links where xero_invoice_id = ${own}`);
    const { rows: [version] } = await handle.db.execute(sql`select version from invoice_versions where invoice_id = ${link.invoice_id} order by version desc limit 1`);
    await handle.db.execute(sql`insert into xero_invoice_pushes (organisation_id, invoice_id, version, state, idempotency_key, request_body, body_hash, xero_invoice_id)
      values (${org()}, ${link.invoice_id}, ${version.version}, 'created', 'key-sent', '{}', 'hash', ${own})`);
    const kept = await call(`/import/${own}/release`, { method: 'POST', body: { organisationId: org(), reason: 'try' } });
    assert.equal(kept.status, 400);
    assert.match(kept.body.error, /Flow sent/);
  });

  test('nothing fits: it stays in the copy; the match step makes no invoice, with the import switch on or off', async () => {
    const id = await copy(6, { contact: XC2, issuedOn: '2026-07-01' });
    assert.equal((await stateOf(id)).state, 'none');
    assert.equal((await matchXero(handle.db, org())).made, 0, 'off by default');
    const saved = await call('/import/settings', { method: 'PUT', body: { organisationId: org(), makeUnmatched: true } });
    assert.equal(saved.body.settings.makeUnmatched, true);
    // The switch belongs to the history import (test/xero-import-history.test.js).
    assert.equal((await matchXero(handle.db, org())).made, 0);
    assert.equal((await stateOf(id)).state, 'none');
    await call('/import/settings', { method: 'PUT', body: { organisationId: org(), makeUnmatched: false } });
  });

  test('with Link sure matches off, a sure fit waits for a person; check lists what fits', async () => {
    const off = await call('/import/settings', { method: 'PUT', body: { organisationId: org(), autoLink: false } });
    assert.deepEqual(off.body.settings, { autoLink: false, makeUnmatched: false }, 'a setting left out keeps its value');
    await flowInvoice('2026-05-05');
    const id = await copy(8, { issuedOn: '2026-05-05' });
    assert.equal((await stateOf(id)).sure, true);
    assert.equal((await matchXero(handle.db, org())).linked, 0);
    const check = await call(`/import?organisationId=${org()}&show=check`);
    assert.ok(check.body.rows.some((r) => r.xeroInvoiceId === id));
    assert.ok(check.body.rows.every((r) => ['invoice_fits', 'job_fits'].includes(r.state)));
    await call('/import/settings', { method: 'PUT', body: { organisationId: org(), autoLink: true } });
    assert.equal((await matchXero(handle.db, org())).linked, 1);
  });

  test('a Flow invoice whose job carries the work-system invoice number is a sure fit, even at another total', async () => {
    const job = await observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-N', caseRef: 'CASE-N', sourceInvoiceRef: 'INV-9R', contactId: practice.id, jobDate: '2026-04-02', lines: [{ itemCode: 'CROWN' }] });
    await setReady(handle.db, org(), job.id, { actor: 'person:test' });
    const own = await flowInvoice('2026-04-02');
    await handle.db.update(billingObligations).set({ invoiceId: own.id }).where(eq(billingObligations.id, job.id));
    const id = await copy(9, { contact: XC2, issuedOn: '2026-04-20', total: 30000 });
    const row = await stateOf(id);
    assert.equal(row.state, 'invoice_fits');
    assert.equal(row.sure, true);
    assert.equal(row.invoices[0].hard, 'work_invoice_number');
  });

  test('only an owner or admin links, makes or changes the setting', async () => {
    const id = await copy(7, { contact: XC2, issuedOn: '2026-06-01' });
    const res = await request(app, `/api/xero/import/${id}/make`, { token: lab.staffToken, method: 'POST', body: { organisationId: org() } });
    assert.equal(res.status, 403);
    const read = await request(app, `/api/xero/import?organisationId=${org()}`, { token: lab.staffToken });
    assert.equal(read.status, 200);
  });

  test('Use the Xero invoice: the Flow copy Send stopped is deleted (it never reached Xero) and the job gets the Xero bill', async () => {
    const job = await observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-U', caseRef: 'CASE-U', contactId: practice.id, shippedOn: '2026-10-20', jobDate: '2026-10-20', lines: [{ itemCode: 'CROWN' }] });
    const flowCopy = await flowInvoice('2026-10-20');
    await linkJobToInvoice(handle.db, org(), job.id, { invoiceId: flowCopy.id, actor: 'person:test' });
    // Xero already bills the job with a 15.00 line more: 290.00.
    const id = await copy(21, { issuedOn: '2026-10-20', total: 29000 });
    const other = await copy(22, { contact: XC2, issuedOn: '2026-10-20', total: 29000 });
    await assert.rejects(useXeroInvoice(handle.db, org(), flowCopy.id, { xeroInvoiceId: other, actor: 'person:test' }), /another client/);
    const used = await useXeroInvoice(handle.db, org(), flowCopy.id, { xeroInvoiceId: id, actor: 'person:test' });
    assert.equal(used.removed.id, flowCopy.id);
    assert.equal(used.jobId, job.id);
    assert.deepEqual(await handle.db.select().from(invoices).where(eq(invoices.id, flowCopy.id)), [], 'a send that failed is not a void');
    const [made] = await handle.db.select().from(invoices).where(eq(invoices.id, used.invoice.id));
    assert.equal(made.subtotalCents, 26500, 'the Xero bill, with its extra line');
    const [linkedJob] = await handle.db.select().from(billingObligations).where(eq(billingObligations.id, job.id));
    assert.equal(linkedJob.invoiceId, made.id);
    assert.equal((await stateOf(id)).link.matchedBy, 'made');
    // A copy voided by hand earlier, still holding its job, is cleaned up the same way.
    const job2 = await observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-V', caseRef: 'CASE-V', contactId: practice.id, shippedOn: '2026-10-21', jobDate: '2026-10-21', lines: [{ itemCode: 'CROWN' }] });
    const voidedEarlier = await flowInvoice('2026-10-21');
    await linkJobToInvoice(handle.db, org(), job2.id, { invoiceId: voidedEarlier.id, actor: 'person:test' });
    await handle.db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, voidedEarlier.id));
    const id2 = await copy(23, { issuedOn: '2026-10-21', total: 29000 });
    const second = await useXeroInvoice(handle.db, org(), voidedEarlier.id, { xeroInvoiceId: id2, actor: 'person:test' });
    assert.equal(second.jobId, job2.id);
    assert.equal(second.removed.id, voidedEarlier.id);
    // A send that started (in flight, no Xero id yet) may have reached Xero:
    // it is refused, never voided (void is only for what a customer saw).
    const job3 = await observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-F', caseRef: 'CASE-F', contactId: practice.id, shippedOn: '2026-10-22', jobDate: '2026-10-22', lines: [{ itemCode: 'CROWN' }] });
    const inFlight = await flowInvoice('2026-10-22');
    await linkJobToInvoice(handle.db, org(), job3.id, { invoiceId: inFlight.id, actor: 'person:test' });
    await handle.db.execute(sql`insert into xero_invoice_pushes (organisation_id, invoice_id, version, state, idempotency_key, request_body, body_hash)
      values (${org()}, ${inFlight.id}, 1, 'ambiguous', 'key-in-flight', '{}', 'hash')`);
    const id4 = await copy(26, { issuedOn: '2026-10-22', total: 29000 });
    await assert.rejects(useXeroInvoice(handle.db, org(), inFlight.id, { xeroInvoiceId: id4, actor: 'person:test' }), /already in Xero/);
    assert.equal((await handle.db.select().from(invoices).where(eq(invoices.id, inFlight.id)))[0].status, 'issued');
    // Gone, it cannot give way again.
    const id3 = await copy(24, { issuedOn: '2026-10-21', total: 29000 });
    await assert.rejects(useXeroInvoice(handle.db, org(), voidedEarlier.id, { xeroInvoiceId: id3, actor: 'person:test' }), /not found/);
  });
});
