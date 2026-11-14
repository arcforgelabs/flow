import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { createContact, createPriceItem } from '../server/core/directory.js';
import {
  createDraftInvoice, deleteDraft, isImported, issueInvoice, mirrorWrite, removeImportedInvoice, reviseInvoice, updateDraftInvoice, voidInvoice,
} from '../server/core/invoices.js';
import { linkJobToInvoice, observeJob } from '../server/core/ledger.js';
import { markReady, sendAgain } from '../server/core/sending.js';
import { invoices, invoiceVersions } from '../server/db/schema.js';
import { linkXeroInvoice, releaseXeroLink, useXeroInvoice } from '../server/integrations/xero/links.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, scriptedXero, seedLab } from './support/xero.js';

// An imported invoice (invoices.origin is not 'flow') belongs to the
// accounting system it was copied from. Flow shows it and never changes,
// sends, voids or deletes it; only the import writes it. The core refuses
// with the code `imported`, and the database refuses whatever the code missed.
// The rows are written directly, as the import will write them. Synthetic
// data only.

const xid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const refused = (pattern) => (error) => pattern.test(String(error?.cause?.message ?? error?.message));

describe('an imported invoice', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let app;
  let lab;
  let practice;
  let crown;
  let seq = 0;
  const org = () => lab.organisation.id;

  // One imported invoice, as the import stores it: the accounting number, and
  // for an issued one a first version that holds the accounting document.
  async function imported({ status = 'issued' } = {}) {
    seq += 1;
    const number = `XR-${String(seq).padStart(4, '0')}`;
    const issued = status !== 'draft';
    const [row] = await db.insert(invoices).values({
      organisationId: org(), contactId: practice.id, origin: 'xero', number, status: issued ? 'issued' : 'draft',
      issuedVersion: issued ? 1 : 0, issueDate: '2024-03-01', subtotalCents: 25000, taxCents: 2500, totalCents: 27500,
    }).returning();
    if (issued) {
      await db.insert(invoiceVersions).values({ organisationId: org(), invoiceId: row.id, version: 1, issuedBy: 'automation:xero-import', document: { number, totalCents: 27500, lines: [] } });
    }
    if (status === 'void') {
      await db.transaction((tx) => mirrorWrite(tx, row.id, () => tx.update(invoices).set({ status: 'void' }).where(eq(invoices.id, row.id))));
    }
    return { ...row, status };
  }

  const stored = async (id) => (await db.select().from(invoices).where(eq(invoices.id, id)))[0];

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
    const xero = scriptedXero();
    const booted = await bootFlow(handle, { runtime: xero.runtime, log: xero.log });
    app = booted.app;
    lab = await seedLab(handle, booted.clerk);
    practice = await createContact(db, org(), { kind: 'customer', name: 'Example Practice' });
    crown = await createPriceItem(db, org(), { code: 'CROWN', name: 'Crown', unitAmountCents: 25000 });
    await connectDirectly(handle, xero.runtime, org());
  });
  after(async () => handle?.close());

  test('an invoice Flow makes is its own; an imported one is not', async () => {
    const draft = await createDraftInvoice(db, org(), { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    assert.equal(draft.origin, 'flow');
    assert.equal(isImported(draft), false);
    assert.equal(isImported(await imported()), true);
  });

  test('the core refuses every change, send, void and delete', async () => {
    const issued = await imported();
    const draft = await imported({ status: 'draft' });
    const books = { name: 'Books', capabilities: { everSent: async () => false, deleteInvoice: async () => assert.fail('the accounting system is never called') } };
    const code = { code: 'imported' };
    await assert.rejects(updateDraftInvoice(db, org(), draft.id, { reference: 'changed' }), code);
    await assert.rejects(issueInvoice(db, org(), draft.id, { issuedBy: 'user:test', issueDate: '2026-11-14' }), code);
    await assert.rejects(reviseInvoice(db, org(), issued.id), code);
    await assert.rejects(voidInvoice(db, org(), issued.id), code);
    await assert.rejects(voidInvoice(db, org(), issued.id, { accounting: books }), code);
    await assert.rejects(deleteDraft(db, org(), issued.id, { actor: 'person:test', accounting: books }), code);
    await assert.rejects(deleteDraft(db, org(), draft.id, { actor: 'person:test', accounting: books }), code);
    await assert.rejects(markReady(db, org(), [draft.id], { personId: null }), { code: 'not_draft' });
    await db.transaction((tx) => mirrorWrite(tx, issued.id, () => tx.update(invoices).set({ sendState: 'failed' }).where(eq(invoices.id, issued.id))));
    const sends = { name: 'Books', capabilities: { sendStatus: async () => ({ connected: true, writesAllowed: true }) } };
    assert.deepEqual(await sendAgain(db, org(), { accounting: sends, personId: null, invoiceIds: [issued.id] }), { queued: 0 });
    assert.deepEqual([(await stored(issued.id)).status, (await stored(draft.id)).status], ['issued', 'draft'], 'nothing changed');
  });

  test('a job is never given an imported invoice as its own', async () => {
    const issued = await imported();
    const job = await observeJob(db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-I1', caseRef: 'CASE-I1', contactId: practice.id, shippedOn: '2024-03-01', jobDate: '2024-03-01', lines: [{ itemCode: 'CROWN' }] });
    await assert.rejects(linkJobToInvoice(db, org(), job.id, { invoiceId: issued.id, actor: 'person:test' }), { code: 'imported' });
    // The database rule, for a path that skips the core.
    await assert.rejects(db.execute(sql`update billing_obligations set invoice_id = ${issued.id} where id = ${job.id}`), refused(/tied to an imported invoice by its accounting reference/));
  });

  test('the Xero link steps refuse it', async () => {
    const issued = await imported();
    await db.execute(sql`insert into xero_invoices (organisation_id, xero_invoice_id, type, invoice_number, status, issued_on, total_cents, record_hash)
      values (${org()}, ${xid(1)}, 'ACCREC', 'XR-9001', 'AUTHORISED', '2024-03-01', 27500, 'h1'), (${org()}, ${xid(2)}, 'ACCREC', ${issued.number}, 'AUTHORISED', '2024-03-01', 27500, 'h2')`);
    await db.execute(sql`insert into xero_invoice_links (organisation_id, xero_invoice_id, invoice_id, matched_by, linked_by) values (${org()}, ${xid(2)}, ${issued.id}, 'made', 'automation:xero-import')`);
    await assert.rejects(linkXeroInvoice(db, org(), xid(1), { invoiceId: issued.id, actor: 'person:test' }), { code: 'imported' });
    await assert.rejects(useXeroInvoice(db, org(), issued.id, { xeroInvoiceId: xid(1), actor: 'person:test' }), { code: 'imported' });
    await assert.rejects(releaseXeroLink(db, org(), xid(2), { actor: 'person:test', reason: 'wrong pair' }), { code: 'imported' });
    const res = await request(app, `/api/xero/import/${xid(2)}/release`, { token: lab.ownerToken, method: 'POST', body: { organisationId: org(), reason: 'wrong pair' } });
    assert.deepEqual([res.status, res.body.code], [409, 'imported']);
    assert.equal((await stored(issued.id)).status, 'issued');
  });

  test('the database refuses a change, a delete and a push row', async () => {
    const issued = await imported();
    await assert.rejects(db.execute(sql`update invoices set status = 'void' where id = ${issued.id}`), refused(/follows its accounting system/));
    await assert.rejects(db.execute(sql`update invoices set send_state = 'queued' where id = ${issued.id}`), refused(/follows its accounting system/));
    await assert.rejects(db.execute(sql`delete from invoices where id = ${issued.id}`), refused(/removed only by its import/));
    await assert.rejects(db.execute(sql`insert into xero_invoice_pushes (organisation_id, invoice_id, version, state, idempotency_key, request_body, body_hash)
      values (${org()}, ${issued.id}, 1, 'dispatching', 'key-imported', '{}', 'hash')`), refused(/never sent to Xero/));
    const own = await createDraftInvoice(db, org(), { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    await assert.rejects(db.execute(sql`update invoices set origin = 'xero' where id = ${own.id}`), refused(/origin of an invoice never changes/));
  });

  test('a contact merge still moves an imported or void invoice to the kept contact', async () => {
    const kept = await createContact(db, org(), { kind: 'customer', name: 'Kept Practice' });
    const issued = await imported();
    const gone = await imported({ status: 'void' });
    await db.execute(sql`update invoices set contact_id = ${kept.id}, updated_at = now() where id in (${issued.id}, ${gone.id})`);
    assert.deepEqual([(await stored(issued.id)).contactId, (await stored(gone.id)).contactId], [kept.id, kept.id]);
    await assert.rejects(db.execute(sql`update invoices set contact_id = ${practice.id}, reference = 'x' where id = ${gone.id}`), refused(/follows its accounting system|void invoice cannot change/));
  });

  test('the import writes it, and removes it with its versions; the accounting system is not called', async () => {
    const issued = await imported();
    await db.transaction((tx) => mirrorWrite(tx, issued.id, () => tx.update(invoices).set({ number: 'XR-RENAMED', totalCents: 30000 }).where(eq(invoices.id, issued.id))));
    assert.deepEqual([(await stored(issued.id)).number, (await stored(issued.id)).totalCents], ['XR-RENAMED', 30000], 'the copy follows a change in the accounting system');
    // The setting ends with the write: the next change is refused again.
    await assert.rejects(db.transaction(async (tx) => {
      await mirrorWrite(tx, issued.id, async () => {});
      await tx.update(invoices).set({ totalCents: 1 }).where(eq(invoices.id, issued.id));
    }), refused(/follows its accounting system/));
    await db.transaction((tx) => removeImportedInvoice(tx, org(), issued.id));
    assert.equal(await stored(issued.id), undefined);
    assert.equal((await db.select().from(invoiceVersions).where(eq(invoiceVersions.invoiceId, issued.id))).length, 0);
    const own = await createDraftInvoice(db, org(), { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    await assert.rejects(db.transaction((tx) => removeImportedInvoice(tx, org(), own.id)), { code: 'invalid' });
    // The import's setting does not open an invoice Flow issued.
    await issueInvoice(db, org(), own.id, { issuedBy: 'user:test', issueDate: '2026-11-14' });
    await assert.rejects(db.transaction((tx) => mirrorWrite(tx, own.id, () => tx.delete(invoices).where(eq(invoices.id, own.id)))), refused(/issued cannot be deleted|append-only|violates/));
  });

  test('the API answers 409 imported', async () => {
    const issued = await imported();
    const call = (path, method = 'POST') => request(app, `/api/invoicing/invoices/${issued.id}${path}`, { token: lab.ownerToken, method, body: { organisationId: org() } });
    for (const res of [await call('/void'), await call('/revise'), await call('', 'DELETE')]) {
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.code, 'imported');
    }
  });
});
