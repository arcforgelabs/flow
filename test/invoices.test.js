import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import {
  createDraftInvoice,
  deleteDraft,
  getInvoice,
  issueInvoice,
  listInvoices,
  listInvoiceVersions,
  reviseInvoice,
  updateDraftInvoice,
  voidInvoice,
} from '../server/core/invoices.js';
import { linkJobToInvoice, observeJob } from '../server/core/ledger.js';
import { billingObligations, obligationEvents } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Synthetic data only (CONTRIBUTING.md).
describe('invoices', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  let otherLab;
  let practice;
  let crown;

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
    lab = await createOrganisation(db, { name: 'Example Lab' });
    otherLab = await createOrganisation(db, { name: 'Other Lab' });
    practice = await createContact(db, lab.id, { kind: 'customer', name: 'Example Practice', email: 'accounts@example.test' });
    crown = await createPriceItem(db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
  });

  after(async () => handle?.close());

  test('a draft takes its lines from the price list and totals them', async () => {
    const draft = await createDraftInvoice(db, lab.id, {
      contactId: practice.id,
      reference: 'CASE-1001',
      lines: [{ priceItemId: crown.id }, { description: 'Courier', unitAmountCents: 1500, taxCode: 'GST_FREE' }],
    });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.number, null);
    assert.deepEqual([draft.subtotalCents, draft.taxCents, draft.totalCents], [23500, 2200, 25700]);
    const { lines } = await getInvoice(db, lab.id, draft.id);
    assert.deepEqual(lines.map((l) => [l.description, l.lineAmountCents, l.taxCents]), [['Crown', 22000, 2200], ['Courier', 1500, 0]]);
  });

  test('issuing numbers the invoice and stores the document as sent', async () => {
    const draft = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id, quantity: 2 }] });
    const issued = await issueInvoice(db, lab.id, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    assert.equal(issued.status, 'issued');
    assert.match(issued.number, /^INV-\d{4}$/);
    assert.equal(issued.issuedVersion, 1);
    const [v1] = await listInvoiceVersions(db, lab.id, draft.id);
    assert.equal(v1.document.totalCents, 48400);
    assert.equal(v1.document.contact.name, 'Example Practice');
    assert.equal(v1.document.lines[0].itemCode, 'CRN', 'the document names the item sold');
    await assert.rejects(updateDraftInvoice(db, lab.id, draft.id, { reference: 'x' }), { code: 'not_draft' });
  });

  test('a revision keeps the number and every earlier version unchanged', async () => {
    const draft = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    const first = await issueInvoice(db, lab.id, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    await reviseInvoice(db, lab.id, draft.id);
    await updateDraftInvoice(db, lab.id, draft.id, { lines: [{ priceItemId: crown.id, unitAmountCents: 20000 }] });
    const second = await issueInvoice(db, lab.id, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-17' });
    assert.equal(second.number, first.number);
    assert.equal(second.issuedVersion, 2);
    const versions = await listInvoiceVersions(db, lab.id, draft.id);
    assert.deepEqual(versions.map((v) => v.document.totalCents), [24200, 22000]);
    assert.deepEqual(versions.map((v) => v.document.lines[0].itemCode), ['CRN', 'CRN']);
  });

  test('invoice numbers count up per organisation', async () => {
    const otherPractice = await createContact(db, otherLab.id, { kind: 'customer', name: 'Example Practice' });
    const a = await createDraftInvoice(db, otherLab.id, { contactId: otherPractice.id, lines: [{ description: 'Item', unitAmountCents: 100 }] });
    const b = await createDraftInvoice(db, otherLab.id, { contactId: otherPractice.id, lines: [{ description: 'Item', unitAmountCents: 100 }] });
    const ia = await issueInvoice(db, otherLab.id, a.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    const [version] = await listInvoiceVersions(db, otherLab.id, a.id);
    assert.equal(version.document.lines[0].itemCode, null, 'a line typed by hand names no item');
    const ib = await issueInvoice(db, otherLab.id, b.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    assert.deepEqual([ia.number, ib.number], ['INV-0001', 'INV-0002']);
  });

  test('one organisation cannot read or use another organisation\'s records', async () => {
    const draft = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    await assert.rejects(getInvoice(db, otherLab.id, draft.id), { code: 'not_found' });
    await assert.rejects(issueInvoice(db, otherLab.id, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-16' }), { code: 'not_found' });
    await assert.rejects(createDraftInvoice(db, otherLab.id, { contactId: practice.id }), /contact not found/);
    const otherCustomer = await createContact(db, otherLab.id, { kind: 'customer', name: 'Another Practice' });
    await assert.rejects(
      createDraftInvoice(db, otherLab.id, { contactId: otherCustomer.id, lines: [{ priceItemId: crown.id }] }),
      /price item not found/,
    );
    assert.ok((await listInvoices(db, otherLab.id)).every((i) => i.organisationId === otherLab.id));
  });

  test('the database refuses a row that joins two organisations', async () => {
    await assert.rejects(
      handle.pool.query('INSERT INTO invoices (organisation_id, contact_id) VALUES ($1, $2)', [otherLab.id, practice.id]),
      /invoices_contact_same_org/,
    );
  });

  test('the database refuses changes to what was sent', async () => {
    const draft = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    const issued = await issueInvoice(db, lab.id, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    await assert.rejects(handle.pool.query("UPDATE invoice_versions SET issued_by = 'someone' WHERE invoice_id = $1", [draft.id]), /append-only/);
    await assert.rejects(handle.pool.query('DELETE FROM invoice_versions WHERE invoice_id = $1', [draft.id]), /append-only/);
    await assert.rejects(handle.pool.query('UPDATE invoice_lines SET unit_amount_cents = 1 WHERE invoice_id = $1', [draft.id]), /only while the invoice is a draft/);
    await assert.rejects(handle.pool.query("UPDATE invoices SET number = 'INV-9999' WHERE id = $1", [issued.id]), /number never changes/);
    await assert.rejects(handle.pool.query('DELETE FROM invoices WHERE id = $1', [issued.id]), /cannot be deleted/);
  });

  test('a void invoice is final; a never-issued draft cannot be voided', async () => {
    const draft = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    await assert.rejects(voidInvoice(db, lab.id, draft.id), { code: 'never_issued' });
    await issueInvoice(db, lab.id, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    const voided = await voidInvoice(db, lab.id, draft.id);
    assert.equal(voided.status, 'void');
    await assert.rejects(reviseInvoice(db, lab.id, draft.id), { code: 'not_issued' });
    await assert.rejects(handle.pool.query("UPDATE invoices SET status = 'issued' WHERE id = $1", [draft.id]), /void invoice cannot change/);
  });

  test('with an accounting system, Flow refuses to void: delete what never reached it, void the rest there', async () => {
    const system = (everSent) => ({ name: 'Books', capabilities: { everSent: async () => everSent } });
    const draft = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    // A draft that was never issued is refused as before, whatever the system says.
    await assert.rejects(voidInvoice(db, lab.id, draft.id, { accounting: system(false) }), { code: 'never_issued' });
    await issueInvoice(db, lab.id, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    await assert.rejects(voidInvoice(db, lab.id, draft.id, { accounting: system(false) }), { code: 'delete_instead', message: /never reached Books/ });
    await assert.rejects(voidInvoice(db, lab.id, draft.id, { accounting: system(true) }), { code: 'void_in_accounting', message: /Void it in Books/ });
    const [row] = (await handle.pool.query('SELECT status FROM invoices WHERE id = $1', [draft.id])).rows;
    assert.equal(row.status, 'issued', 'a refused void changes nothing');
    // With no accounting system Flow sent the invoice itself, so Flow voids it.
    assert.equal((await voidInvoice(db, lab.id, draft.id)).status, 'void');
  });

  test('a never-issued draft can be deleted; an issued invoice needs an accounting system', async () => {
    const draft = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    await deleteDraft(db, lab.id, draft.id);
    await assert.rejects(getInvoice(db, lab.id, draft.id), { code: 'not_found' });
    const { rows } = await handle.pool.query('SELECT id FROM invoice_lines WHERE invoice_id = $1', [draft.id]);
    assert.equal(rows.length, 0);

    const issued = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    await issueInvoice(db, lab.id, issued.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    await assert.rejects(deleteDraft(db, lab.id, issued.id), { code: 'accounting_unavailable' });
    assert.equal((await getInvoice(db, lab.id, issued.id)).status, 'issued');

    const revised = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    await issueInvoice(db, lab.id, revised.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    await reviseInvoice(db, lab.id, revised.id);
    await assert.rejects(deleteDraft(db, lab.id, revised.id), { code: 'accounting_unavailable' });
    assert.equal((await getInvoice(db, lab.id, revised.id)).status, 'draft');
    await assert.rejects(deleteDraft(db, otherLab.id, revised.id), { code: 'not_found' });
  });

  test('an issued or void invoice that never reached the accounting system is deleted, not voided', async () => {
    let sent = false;
    const accounting = { name: 'Xero', capabilities: { everSent: async () => sent, deleteInvoice: async () => ({ state: 'unavailable' }) } };
    const job = await observeJob(db, lab.id, { sourceSystem: 'worksystem', sourceJobRef: 'JOB-UNSENT', caseRef: 'CASE-UNSENT', contactId: practice.id, shippedOn: '2026-10-16', jobDate: '2026-10-16', lines: [{ itemCode: 'CROWN', description: 'Crown', quantity: 1, unitAmountCents: 22000 }] });
    const failed = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    const issued = await issueInvoice(db, lab.id, failed.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    await linkJobToInvoice(db, lab.id, job.id, { invoiceId: failed.id, actor: 'person:test' });

    // The database still refuses it without the code's check.
    await assert.rejects(handle.pool.query('DELETE FROM invoices WHERE id = $1', [failed.id]), /cannot be deleted; void it/);
    await assert.rejects(handle.pool.query('DELETE FROM invoice_versions WHERE invoice_id = $1', [failed.id]), /append-only/);
    // On its way: wait for the send to finish.
    await handle.pool.query("UPDATE invoices SET send_state = 'queued' WHERE id = $1", [failed.id]);
    await assert.rejects(deleteDraft(db, lab.id, failed.id, { actor: 'person:test', accounting }), /on its way to Xero/);
    await handle.pool.query("UPDATE invoices SET send_state = 'failed' WHERE id = $1", [failed.id]);

    const removed = await deleteDraft(db, lab.id, failed.id, { actor: 'person:test', accounting });
    assert.equal(removed.removed, true);
    await assert.rejects(getInvoice(db, lab.id, failed.id), { code: 'not_found' });
    assert.equal((await handle.pool.query('SELECT 1 FROM invoice_versions WHERE invoice_id = $1', [failed.id])).rows.length, 0);
    const [freed] = await db.select().from(billingObligations).where(eq(billingObligations.id, job.id));
    assert.equal(freed.invoiceId, null, 'the job can be invoiced again');
    const events = await db.select().from(obligationEvents).where(eq(obligationEvents.obligationId, job.id));
    const kept = events.find((e) => e.kind === 'draft_deleted');
    assert.deepEqual([kept.evidence.number, kept.evidence.reason, kept.actor], [issued.number, 'never_sent', 'person:test']);

    // A void invoice that never reached it goes too.
    const voided = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    await issueInvoice(db, lab.id, voided.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    await voidInvoice(db, lab.id, voided.id);
    await deleteDraft(db, lab.id, voided.id, { actor: 'person:test', accounting });
    await assert.rejects(getInvoice(db, lab.id, voided.id), { code: 'not_found' });

    // An owner's override record stays, so its invoice is never deleted: the
    // old rules apply (here: the test system is not connected, so nothing changes).
    const held = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    const heldIssued = await issueInvoice(db, lab.id, held.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    const { rows: [person] } = await handle.pool.query("INSERT INTO people (email, role, status) VALUES ('override-owner@example.test', 'owner', 'active') RETURNING id");
    await handle.pool.query("INSERT INTO send_overrides (organisation_id, invoice_id, version, document_hash, problems, reason_code, person_id) VALUES ($1, $2, $3, 'sample', '[]', 'one_off', $4)",
      [lab.id, held.id, heldIssued.issuedVersion, person.id]);
    await assert.rejects(deleteDraft(db, lab.id, held.id, { actor: 'person:test', accounting }), { code: 'accounting_not_connected' });
    assert.equal((await getInvoice(db, lab.id, held.id)).status, 'issued');

    // One the accounting system has (a send started, or a link) keeps the old rules.
    sent = true;
    const real = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    await issueInvoice(db, lab.id, real.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    await voidInvoice(db, lab.id, real.id);
    await assert.rejects(deleteDraft(db, lab.id, real.id, { actor: 'person:test', accounting }), /void invoice is final/);
    assert.equal((await getInvoice(db, lab.id, real.id)).status, 'void');
  });

  test('an invoice goes only to a customer contact', async () => {
    const supplier = await createContact(db, lab.id, { kind: 'supplier', name: 'Example Supplier' });
    await assert.rejects(createDraftInvoice(db, lab.id, { contactId: supplier.id }), /customer contact/);
  });
});
