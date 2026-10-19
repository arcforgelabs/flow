import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { invoicePdfDocument, pdfFilename, pdfReference, renderInvoicePdf } from '../server/core/invoice-pdf.js';
import { createDraftInvoice, issueInvoice, reviseInvoice, updateDraftInvoice, voidInvoice } from '../server/core/invoices.js';
import { fakeClerk, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// The invoice PDF (server/core/invoice-pdf.js and GET /api/invoicing/invoices/:id/pdf).
// Synthetic data only (CONTRIBUTING.md).
const OWNER = 'owner@example.test';
const quiet = { info() {}, warn() {}, error() {} };
const MISSING = '00000000-0000-4000-8000-000000000000';

const pages = (bytes) => (bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

function document(lineCount) {
  return {
    number: 'INV-0001',
    issueDate: '2026-10-19',
    dueDate: '2026-11-18',
    reference: 'Dr Example - Sample Patient',
    currency: 'AUD',
    contact: { name: 'Example Practice', email: 'accounts@example.test' },
    lines: Array.from({ length: lineCount }, (_, i) => ({
      position: i + 1, itemCode: 'CRN', description: `Crown ${i + 1}`, quantity: 1, unitAmountCents: 22000, taxCode: 'GST', lineAmountCents: 22000, taxCents: 2200,
    })),
    subtotalCents: 22000 * lineCount,
    taxCents: 2200 * lineCount,
    totalCents: 24200 * lineCount,
  };
}

test('an invoice draws as a PDF, on more pages when it has many lines', async () => {
  const one = await renderInvoicePdf({ seller: 'Example Lab', document: document(1) });
  assert.equal(one.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pages(one), 1);
  const many = await renderInvoicePdf({ seller: 'Example Lab', document: document(80) });
  assert.ok(pages(many) > 1);
});

test('the reference is what the accounting system gets: its own, else the number', () => {
  assert.equal(pdfReference({ reference: 'Dr Example - Sample Patient', number: 'INV-0001' }), 'Dr Example - Sample Patient');
  assert.equal(pdfReference({ reference: '', number: 'INV-0001' }), 'INV-0001');
  assert.equal(pdfReference({ reference: null, number: null }), null);
});

test('the file name is safe in a header', () => {
  assert.equal(pdfFilename({ number: 'INV-0001' }), 'INV-0001.pdf');
  assert.equal(pdfFilename({ number: null }), 'draft-invoice.pdf');
  assert.equal(pdfFilename({ number: 'INV "1"/é' }), 'INV-1-.pdf');
});

describe('invoice PDF with PostgreSQL', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let lab;
  let practice;
  let crown;
  let token;

  before(async () => {
    handle = await freshDatabase();
    const clerk = fakeClerk();
    lab = await createOrganisation(handle.db, { name: 'Example Lab' });
    practice = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Example Practice', email: 'accounts@example.test' });
    crown = await createPriceItem(handle.db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
    await seedFirstOwner(handle.db, OWNER);
    token = clerk.signIn(clerk.addUser({ email: OWNER, google: true, password: false }));
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    app = createApp({ database: handle, auth: { settings, clerk, personAuth }, log: quiet });
  });

  after(async () => handle?.close());

  async function get(path, { auth = true } = {}) {
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/invoicing${path}`, {
        headers: auth ? { Authorization: `Bearer ${token}` } : {},
      });
      return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
    } finally {
      server.close();
    }
  }

  test('a draft shows its lines now; an issued invoice shows the version it was sent as', async () => {
    const draft = await createDraftInvoice(handle.db, lab.id, { contactId: practice.id, reference: 'Dr Example - Sample Patient', lines: [{ priceItemId: crown.id }] });
    const asDraft = await invoicePdfDocument(handle.db, lab.id, draft.id);
    assert.equal(asDraft.seller, 'Example Lab');
    assert.equal(asDraft.document.number, null);
    assert.deepEqual(asDraft.document.lines.map((l) => [l.itemCode, l.description]), [['CRN', 'Crown']]);

    await issueInvoice(handle.db, lab.id, draft.id, { issuedBy: 'test', issueDate: '2026-10-19' });
    const asIssued = await invoicePdfDocument(handle.db, lab.id, draft.id);
    assert.equal(asIssued.document.number, 'INV-0001');
    assert.equal(asIssued.document.reference, 'Dr Example - Sample Patient');

    // Revised: the draft's new lines, and version 1 as it was sent.
    await reviseInvoice(handle.db, lab.id, draft.id);
    await updateDraftInvoice(handle.db, lab.id, draft.id, { lines: [{ priceItemId: crown.id, quantity: 2 }] });
    assert.equal((await invoicePdfDocument(handle.db, lab.id, draft.id)).document.lines[0].quantity, 2);
    const first = await invoicePdfDocument(handle.db, lab.id, draft.id, { version: 1 });
    assert.equal(first.document.lines[0].quantity, 1);

    await issueInvoice(handle.db, lab.id, draft.id, { issuedBy: 'test', issueDate: '2026-10-20' });
    assert.equal((await invoicePdfDocument(handle.db, lab.id, draft.id)).document.version, 2);
    await voidInvoice(handle.db, lab.id, draft.id);
    assert.equal((await invoicePdfDocument(handle.db, lab.id, draft.id)).document.version, 2, 'a void invoice shows the version it was sent as');
  });

  test('GET /invoices/:id/pdf answers a PDF to a signed-in person', async () => {
    const draft = await createDraftInvoice(handle.db, lab.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    const res = await get(`/invoices/${draft.id}/pdf`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('content-disposition'), 'inline; filename="draft-invoice.pdf"');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.bytes.subarray(0, 5).toString(), '%PDF-');

    assert.equal((await get(`/invoices/${draft.id}/pdf`, { auth: false })).status, 401);
    assert.equal((await get(`/invoices/${MISSING}/pdf`)).status, 404);
    assert.equal((await get(`/invoices/${draft.id}/pdf?version=0`)).status, 400);
    assert.equal((await get(`/invoices/${draft.id}/pdf?version=1`)).status, 404, 'a draft never issued has no version 1');
  });
});
