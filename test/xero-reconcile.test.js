import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createContact, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, issueInvoice, voidInvoice } from '../server/core/invoices.js';
import { mapInvoice } from '../server/integrations/xero/mirror.js';
import { checkSentInvoices, OUT_OF_SYNC, sentDifferences, stageOf } from '../server/integrations/xero/reconcile.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, scriptedXero, seedLab, xeroAnswer } from './support/xero.js';

// Each invoice Flow sent, against Flow's copy of Xero (issue #132). The send
// record and the copy are written directly; Xero is replayed with synthetic
// answers only for Mark resolved, which reads Xero's changes first.

const XC = '00000000-0000-4000-8000-0000000000c1';
const at = (iso) => `/Date(${Date.parse(iso)}+0000)/`;

test('a Xero copy is compared with the version Flow sent, field by field', () => {
  const sent = { Contact: { ContactID: XC }, Date: '2026-10-18' };
  const document = { subtotalCents: 25000, taxCents: 2500, totalCents: 27500, lines: [{ itemCode: 'CROWN' }] };
  const copy = { xero_contact_id: XC, subtotal_cents: 25000, tax_cents: 2500, total_cents: 27500, lines: [{ itemCode: 'CROWN' }], issued_on: '2026-10-18' };
  assert.deepEqual(sentDifferences(sent, document, copy), []);
  assert.deepEqual(sentDifferences(sent, document, { ...copy, total_cents: 30000, lines: [{ itemCode: 'BRIDGE' }] }).map((d) => d.field), ['total', 'items']);
  assert.deepEqual(sentDifferences(sent, document, { ...copy, lines: [{}, {}], issued_on: '2026-10-19' }), [
    { field: 'line count', flow: 1, xero: 2 },
    { field: 'date', flow: '2026-10-18', xero: '2026-10-19' },
  ]);
});

test('the Invoices page tab of an issued invoice follows its Xero stage', () => {
  const at = (state, extra = {}) => stageOf({ state, finding: null, xero: { sentToContact: null }, ...extra });
  assert.deepEqual(['not_sent', 'sending', 'not_copied', 'draft'].map((s) => at(s)), ['draft', 'draft', 'draft', 'draft']);
  assert.equal(at('approved'), 'approved');
  assert.equal(at('approved', { xero: { sentToContact: true } }), 'sent');
  assert.deepEqual([at('part_paid'), at('paid'), at('voided'), at('deleted')], ['sent', 'sent', 'void', 'void']);
  assert.equal(at('approved', { finding: 'edited_in_xero' }), 'pending', 'out of sync: a person looks');
  assert.equal(mapInvoice({ InvoiceID: 'x', Status: 'AUTHORISED', SentToContact: true }).sentToContact, true);
  assert.equal(mapInvoice({ InvoiceID: 'x', Status: 'DRAFT' }).sentToContact, null);
});

describe('sent invoices against the Xero copy', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let lab;
  let xero;
  let practice;
  let crown;
  let n = 0;

  before(async () => {
    handle = await freshDatabase();
    xero = scriptedXero({ XERO_MIRROR_PAGE_SIZE: '2' });
    const booted = await bootFlow(handle, { runtime: xero.runtime, log: xero.log });
    app = booted.app;
    lab = await seedLab(handle, booted.clerk);
    practice = await createContact(handle.db, lab.organisation.id, { kind: 'customer', name: 'Example Practice' });
    crown = await createPriceItem(handle.db, lab.organisation.id, { code: 'CROWN', name: 'Crown', unitAmountCents: 25000 });
    await connectDirectly(handle, xero.runtime, lab.organisation.id);
  });
  after(async () => handle?.close());
  beforeEach(() => {
    xero.clock.at += 10 * 60_000;
    xero.runtime.remember(lab.organisation.id, { access_token: 'synthetic-access-0', expires_in: 1800 });
  });

  const org = () => lab.organisation.id;

  // An issued invoice of one crown (250.00 + 25.00 GST), sent to Xero as
  // `xeroId`, and Xero's copy of it with `copy` changes.
  async function sent(xeroId, copy = {}) {
    const draft = await createDraftInvoice(handle.db, org(), { contactId: practice.id, reference: `CASE-${++n}`, lines: [{ priceItemId: crown.id }] });
    const invoice = await issueInvoice(handle.db, org(), draft.id, { issuedBy: 'user:test', issueDate: '2026-10-18' });
    const body = JSON.stringify({ Type: 'ACCREC', Status: 'DRAFT', Contact: { ContactID: XC }, Date: '2026-10-18', LineItems: [{ ItemCode: 'CROWN' }] });
    await handle.db.execute(sql`insert into xero_invoice_pushes (organisation_id, invoice_id, version, state, idempotency_key, request_body, body_hash, xero_invoice_id, xero_invoice_number, xero_status, verified)
      values (${org()}, ${invoice.id}, 1, 'created', ${`key-${n}`}, ${body}, 'hash', ${xeroId}, ${`INV-${xeroId}`}, 'DRAFT', true)`);
    const c = { status: 'DRAFT', total: 27500, sub: 25000, tax: 2500, lines: [{ itemCode: 'CROWN' }], paid: 0, ...copy };
    await handle.db.execute(sql`insert into xero_invoices (organisation_id, xero_invoice_id, type, invoice_number, xero_contact_id, status, issued_on,
        subtotal_cents, tax_cents, total_cents, amount_due_cents, amount_paid_cents, amount_credited_cents, lines, record_hash)
      values (${org()}, ${xeroId}, 'ACCREC', ${`INV-${xeroId}`}, ${XC}, ${c.status}, '2026-10-18',
        ${c.sub}, ${c.tax}, ${c.total}, ${c.total - c.paid}, ${c.paid}, 0, ${JSON.stringify(c.lines)}::jsonb, 'h')`);
    return invoice;
  }

  const status = async (ids) => {
    const res = await request(app, '/api/xero/invoices/status', { token: lab.staffToken, method: 'POST', body: { organisationId: org(), invoiceIds: ids } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.invoices;
  };
  const openItems = async () => (await handle.db.execute(sql`select flow_id, evidence from review_items
    where kind = ${OUT_OF_SYNC} and state = 'open'`)).rows;

  test('each invoice shows its Xero status from the copy, with no Xero calls', async () => {
    const replay = xero.script([]);
    const same = await sent('x-same');
    const paid = await sent('x-paid', { status: 'AUTHORISED', paid: 10000 });
    const draft = await createDraftInvoice(handle.db, org(), { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    const [a, b, c] = await status([same.id, paid.id, draft.id]).then((list) => [same, paid, draft].map((i) => list.find((s) => s.invoiceId === i.id)));
    assert.equal(a.state, 'draft');
    assert.equal(a.label, 'Draft in Xero');
    assert.equal(a.finding, null);
    assert.equal(b.state, 'part_paid');
    assert.equal(c.state, 'not_sent');
    assert.match(a.xero.url, /InvoiceID=x-same/);
    assert.equal(replay.calls.length, 0);
  });

  test('an edit in Xero, a void in Xero and a void in Flow each open one alert; a repeat does not add one', async () => {
    const edited = await sent('x-edited', { total: 30000, sub: 27273, tax: 2727 });
    const voidedInXero = await sent('x-void', { status: 'VOIDED' });
    const voidedInFlow = await sent('x-live', { status: 'AUTHORISED' });
    await voidInvoice(handle.db, org(), voidedInFlow.id);

    await checkSentInvoices(handle.db, xero.runtime, org());
    await checkSentInvoices(handle.db, xero.runtime, org());
    const items = await openItems();
    const finding = (invoice) => items.filter((i) => i.flow_id === invoice.id).map((i) => i.evidence.finding);
    assert.deepEqual(finding(edited), ['differs']);
    assert.deepEqual(finding(voidedInXero), ['voided_in_xero']);
    assert.deepEqual(finding(voidedInFlow), ['voided_in_flow']);
    const [differs] = items.filter((i) => i.flow_id === edited.id);
    assert.deepEqual(differs.evidence.differences.map((d) => d.field), ['subtotal', 'tax', 'total']);

    const [shown] = await status([edited.id]);
    assert.equal(shown.finding, 'differs');
    assert.equal(shown.message, 'Xero no longer matches the invoice Flow sent.');
  });

  test('Mark resolved reads Xero first, and closes the alert only when the difference is gone', async () => {
    const invoice = await sent('x-fix', { total: 30000 });
    await checkSentInvoices(handle.db, xero.runtime, org());
    assert.ok((await openItems()).some((i) => i.flow_id === invoice.id));
    const recheck = () => request(app, `/api/xero/invoices/${invoice.id}/recheck`, { token: lab.ownerToken, method: 'POST', body: { organisationId: org() } });

    const fixed = {
      InvoiceID: 'x-fix', Type: 'ACCREC', InvoiceNumber: 'INV-x-fix', Contact: { ContactID: XC }, Status: 'DRAFT',
      Date: at('2026-10-18T00:00:00Z'), SubTotal: 250, TotalTax: 25, Total: 275, AmountDue: 275, AmountPaid: 0, AmountCredited: 0,
      LineItems: [{ LineItemID: 'l1', ItemCode: 'CROWN', Quantity: 1, UnitAmount: 250, LineAmount: 250, TaxAmount: 25 }],
      UpdatedDateUTC: at('2026-10-19T00:00:00Z'),
    };
    const page = (list) => xeroAnswer('Invoices', { Invoices: list }, { query: { page: 1 } });
    xero.script([page([{ ...fixed, Total: 300, SubTotal: 272.73, TotalTax: 27.27 }])]);
    const still = await recheck();
    assert.equal(still.status, 200, JSON.stringify(still.body));
    assert.equal(still.body.resolved, false, 'still different: the alert stays open');
    assert.ok((await openItems()).some((i) => i.flow_id === invoice.id));

    xero.script([page([{ ...fixed, UpdatedDateUTC: at('2026-10-19T01:00:00Z') }])]);
    const done = await recheck();
    assert.equal(done.body.resolved, true, JSON.stringify(done.body));
    assert.equal(done.body.closed, 1);
    assert.ok(!(await openItems()).some((i) => i.flow_id === invoice.id));

    const staff = await request(app, `/api/xero/invoices/${invoice.id}/recheck`, { token: lab.staffToken, method: 'POST', body: { organisationId: org() } });
    assert.equal(staff.status, 403);
  });
});
