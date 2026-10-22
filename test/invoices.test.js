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

  test('a never-issued draft can be deleted; an issued invoice cannot', async () => {
    const draft = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    await deleteDraft(db, lab.id, draft.id);
    await assert.rejects(getInvoice(db, lab.id, draft.id), { code: 'not_found' });
    const { rows } = await handle.pool.query('SELECT id FROM invoice_lines WHERE invoice_id = $1', [draft.id]);
    assert.equal(rows.length, 0);

    const issued = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    await issueInvoice(db, lab.id, issued.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    await assert.rejects(deleteDraft(db, lab.id, issued.id), { code: 'was_issued' });
    assert.equal((await getInvoice(db, lab.id, issued.id)).status, 'issued');

    const revised = await createDraftInvoice(db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    await issueInvoice(db, lab.id, revised.id, { issuedBy: 'user:test', issueDate: '2026-10-16' });
    await reviseInvoice(db, lab.id, revised.id);
    await assert.rejects(deleteDraft(db, lab.id, revised.id), { code: 'was_issued' });
    assert.equal((await getInvoice(db, lab.id, revised.id)).status, 'draft');
    await assert.rejects(deleteDraft(db, otherLab.id, revised.id), { code: 'not_found' });
  });

  test('an invoice goes only to a customer contact', async () => {
    const supplier = await createContact(db, lab.id, { kind: 'supplier', name: 'Example Supplier' });
    await assert.rejects(createDraftInvoice(db, lab.id, { contactId: supplier.id }), /customer contact/);
  });
});
