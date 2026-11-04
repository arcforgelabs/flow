import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createContact, createPriceItem } from '../server/core/directory.js';
import { getInvoice, issueInvoice, listInvoiceVersions, reviseInvoice, deleteDraft } from '../server/core/invoices.js';
import { draftInvoiceForObligation, explainObligation, observeJob, recordAccountingEvidence, setReady } from '../server/core/ledger.js';
import { invoicePdfDocument } from '../server/core/invoice-pdf.js';
import { mapInvoice, storeRows } from '../server/integrations/xero/mirror.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { request } from './support/clerk.js';
import { bootFlow, connectDirectly, scriptedXero, seedLab } from './support/xero.js';

// One primary boundary: the real authenticated API and durable PostgreSQL
// state. Refusal is seeded as a precondition, not claimed as send-worker proof.
describe('retained invoice duplicate workflow', { skip: skipWithoutDatabase }, () => {
  let handle, flow, lab, ownerToken, staffToken, practice, item, xero;
  before(async () => {
    handle = await freshDatabase();
    xero = scriptedXero();
    flow = await bootFlow(handle, { runtime: xero.runtime });
    ({ organisation: lab, ownerToken, staffToken } = await seedLab(handle, flow.clerk));
    await connectDirectly(handle, xero.runtime, lab.id);
    practice = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Synthetic Practice' });
    item = await createPriceItem(handle.db, lab.id, { code: 'CROWN', name: 'Synthetic crown', unitAmountCents: 20000 });
    await handle.db.execute(sql`insert into xero_contacts (organisation_id,xero_contact_id,name,status,is_customer) values (${lab.id}, 'synthetic-client', 'Synthetic Practice', 'ACTIVE', true)`);
    await handle.db.execute(sql`insert into xero_mirror_cursors (organisation_id,resource,passes,last_pass_finished_at) values (${lab.id},'invoices',1,clock_timestamp()), (${lab.id},'credit_notes',1,clock_timestamp())`);
  });
  after(async () => { await flow?.integrations.stop(); await handle?.close(); });
  const api = (path, options = {}) => request(flow.app, '/api/invoicing' + path, { token: ownerToken, ...options });
  async function refused() {
    const job = await observeJob(handle.db, lab.id, { sourceSystem: 'synthetic', sourceJobRef: randomUUID(), contactId: practice.id, lines: [{ itemCode: item.code }], observedAt: new Date().toISOString() });
    await setReady(handle.db, lab.id, job.id, { actor: 'synthetic' });
    await recordAccountingEvidence(handle.db, lab.id, job.id, { state: 'not_found', actor: 'synthetic' });
    const { invoice } = await draftInvoiceForObligation(handle.db, lab.id, job.id, { actor: 'synthetic', liveCheck: null, reference: 'Synthetic case' });
    const issued = await issueInvoice(handle.db, lab.id, invoice.id, { issuedBy: 'synthetic', issueDate: '2026-10-16' });
    const candidateId = randomUUID();
    await storeRows(handle.db, lab.id, 'invoices', [mapInvoice({ InvoiceID: candidateId, Type: 'ACCREC', InvoiceNumber: 'SYNTH-XERO', Reference: issued.reference, Contact: { ContactID: 'synthetic-client' }, Status: 'AUTHORISED', CurrencyCode: 'AUD', DateString: '2026-10-16', Total: 235, SubTotal: 215, TotalTax: 20, AmountPaid: 0, AmountCredited: 0, AmountDue: 235,
      LineItems: [{ ItemCode: 'CROWN', Quantity: 1, UnitAmount: 200, LineAmount: 200, TaxAmount: 20 }, { ItemCode: 'FREIGHT', Quantity: 1, UnitAmount: 15, LineAmount: 15, TaxAmount: 0 }] }, { keepReference: true })], { inserted: 0, changed: 0, unchanged: 0 });
    const error = { code: 'xero_same_reference_different_amount', message: 'Compare the matched invoice.', xero: { invoiceId: candidateId, number: 'SYNTH-XERO', status: 'AUTHORISED' } };
    await handle.db.execute(sql`update invoices set send_state='failed',send_error=${JSON.stringify(error)}::jsonb where id=${issued.id}`);
    return { job, issued, candidateId };
  }
  const confirm = async (record) => {
    const shown = await api('/invoices/' + record.issued.id);
    assert.equal(shown.status, 200, shown.text);
    const candidate = shown.body.invoice.duplicateCandidate;
    assert.ok(candidate, 'a trusted same-product candidate offers an explicit link');
    return { candidateId: candidate.id, confirmation: candidate.confirmation };
  };
  test('confirming a match atomically retains the number, versions and audit; links the job; retries do not duplicate events', async () => {
    const record = await refused();
    const versions = await listInvoiceVersions(handle.db, lab.id, record.issued.id);
    const document = await invoicePdfDocument(handle.db, lab.id, record.issued.id);
    const body = await confirm(record);
    await assert.rejects(handle.db.execute(sql`update invoices set duplicate='{}'::jsonb where id=${record.issued.id}`), (e) => (e.code ?? e.cause?.code) === '23514', 'a resolution receipt cannot leave an active invoice');
    assert.equal((await api('/invoices/' + record.issued.id + '/duplicate', { token: staffToken, method: 'POST', body })).status, 403);
    const results = await Promise.all([api('/invoices/' + record.issued.id + '/duplicate', { method: 'POST', body }), api('/invoices/' + record.issued.id + '/duplicate', { method: 'POST', body })]);
    for (const res of results) { assert.equal(res.status, 200, res.text); assert.equal(res.body.invoice.tab, 'duplicate'); assert.equal(res.body.invoice.number, record.issued.number); }
    assert.deepEqual(await listInvoiceVersions(handle.db, lab.id, record.issued.id), versions);
    const retainedPdf = await invoicePdfDocument(handle.db, lab.id, record.issued.id);
    assert.deepEqual(retainedPdf.document, document.document);
    assert.equal(retainedPdf.duplicate.id, record.candidateId);
    const explained = await explainObligation(handle.db, lab.id, record.job.id);
    assert.equal(explained.obligation.accountingRef, record.candidateId);
    assert.equal(explained.view, 'invoiced');
    assert.equal(explained.events.filter((e) => e.kind === 'duplicate_linked').length, 1);
    await assert.rejects(draftInvoiceForObligation(handle.db, lab.id, record.job.id, { actor: 'synthetic', liveCheck: null }), { code: 'not_ready' });
    await assert.rejects(reviseInvoice(handle.db, lab.id, record.issued.id), { code: 'not_issued' });
    await assert.rejects(deleteDraft(handle.db, lab.id, record.issued.id), { code: 'conflict' });
    const voids = await api('/invoices?status=void');
    assert.ok(!voids.body.invoices.some((i) => i.id === record.issued.id));
    assert.ok((await api('/invoices?status=duplicate')).body.invoices.some((i) => i.id === record.issued.id));
  });
  test('changed evidence, wrong clients/products/tenants, stale copies and any prior push fail closed', async () => {
    const record = await refused();
    const body = await confirm(record);
    const reject = async () => assert.equal((await api('/invoices/' + record.issued.id + '/duplicate', { method: 'POST', body })).status, 409);
    await handle.db.execute(sql`update xero_invoices set invoice_number='CHANGED' where organisation_id=${lab.id} and xero_invoice_id=${record.candidateId}`);
    await reject();
    const { rows: [connection] } = await handle.db.execute(sql`select tenant_id,connected_at from xero_connections where organisation_id=${lab.id}`);
    for (const kind of ['client', 'product', 'sent', 'queued', 'push', 'tenant', 'stale']) {
      const r = await refused();
      const confirmed = await confirm(r); // each negative starts from a valid offer
      const mutations = {
        client: sql`update xero_invoices set xero_contact_id='other' where organisation_id=${lab.id} and xero_invoice_id=${r.candidateId}`,
        product: sql`update xero_invoices set lines='[]'::jsonb where organisation_id=${lab.id} and xero_invoice_id=${r.candidateId}`,
        sent: sql`update invoices set send_state='sent' where id=${r.issued.id}`,
        queued: sql`update invoices set send_state='queued' where id=${r.issued.id}`,
        push: sql`insert into xero_invoice_pushes (organisation_id,invoice_id,version,state,idempotency_key,request_body,body_hash) values (${lab.id},${r.issued.id},1,'ambiguous',${randomUUID()},'{}','synthetic')`,
        tenant: sql`update xero_connections set tenant_id='other-tenant',connected_at=clock_timestamp() where organisation_id=${lab.id}`,
        stale: sql`update xero_mirror_cursors set last_pass_finished_at=now()-interval '2 days' where organisation_id=${lab.id}`,
      };
      await handle.db.execute(mutations[kind]);
      assert.equal((await api('/invoices/' + r.issued.id)).body.invoice.duplicateCandidate, null, kind);
      const stopped = await api('/invoices/' + r.issued.id + '/duplicate', { method: 'POST', body: confirmed });
      assert.equal(stopped.status, 409, kind + ': ' + stopped.text);
      assert.equal((await getInvoice(handle.db, lab.id, r.issued.id)).duplicate, null, kind);
      await handle.db.execute(sql`update xero_connections set tenant_id=${connection.tenant_id},connected_at=${connection.connected_at} where organisation_id=${lab.id}`);
      await handle.db.execute(sql`update xero_mirror_cursors set last_pass_finished_at=clock_timestamp() where organisation_id=${lab.id}`);
    }
    const final = await getInvoice(handle.db, lab.id, record.issued.id);
    assert.equal(final.status, 'issued');
    assert.equal(final.duplicate, null);
  });
});
