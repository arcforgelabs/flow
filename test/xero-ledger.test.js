import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createContact, createPriceItem } from '../server/core/directory.js';
import { issueInvoice } from '../server/core/invoices.js';
import { draftInvoiceForObligation, explainObligation, observeJob } from '../server/core/ledger.js';
import { pushDrafts } from '../server/integrations/xero/drafts.js';
import { ledgerState, recordXeroEvidence, xeroLiveCheck } from '../server/integrations/xero/ledger.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, scriptedXero, seedLab, xeroAnswer } from './support/xero.js';

// The Reference rule's text for a job (server/core/references.js).
const REFERENCE = 'Dr Example - Pat Sample';

// The Xero adapter answering the billing obligation ledger (#24): the live
// invoice check before a draft, and payments. Xero is replayed with
// synthetic answers; each test scripts the answers it expects.

const XC = '00000000-0000-4000-8000-0000000000c1';
const actor = 'user:test';
const organisation = xeroAnswer('Organisation', { Organisations: [{ Name: 'Example Lab (Demo)', Class: 'DEMO', ShortCode: '!Ex4mp' }] }, { repeat: true });

function xeroInvoice(id, { status = 'DRAFT', reference, contactId = XC, number = `INV-${id}`, paid = 0 } = {}) {
  return {
    InvoiceID: id, InvoiceNumber: number, Type: 'ACCREC', Status: status, Reference: reference,
    Contact: { ContactID: contactId, Name: 'Example Practice' }, DateString: '2026-10-18T00:00:00',
    SubTotal: 220, TotalTax: 22, Total: 242, AmountPaid: paid, LineItems: [{}],
  };
}
const invoicesAnswer = (list, query) => xeroAnswer('Invoices', { Invoices: list }, query ? { query } : {});
const readBack = (id, options) => xeroAnswer(`Invoices/${id}`, { Invoices: [xeroInvoice(id, options)] });

test('Xero invoice states map to the ledger\'s accounting states', () => {
  assert.equal(ledgerState({ Status: 'DRAFT' }), 'drafted');
  assert.equal(ledgerState({ Status: 'SUBMITTED' }), 'drafted');
  assert.equal(ledgerState({ Status: 'AUTHORISED', AmountPaid: 0 }), 'authorised');
  assert.equal(ledgerState({ Status: 'AUTHORISED', AmountPaid: 10 }), 'part_paid');
  assert.equal(ledgerState({ Status: 'PAID' }), 'paid');
  assert.equal(ledgerState({ Status: 'VOIDED' }), 'voided');
  assert.equal(ledgerState({ Status: 'DELETED' }), 'deleted');
  assert.equal(ledgerState({ Status: 'UNKNOWN' }), null);
});

describe('Xero answers the billing ledger', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let lab;
  let xero;
  let org;
  let practice;
  let jobs = 0;

  before(async () => {
    handle = await freshDatabase();
    xero = scriptedXero();
    const booted = await bootFlow(handle, { runtime: xero.runtime, log: xero.log });
    app = booted.app;
    lab = await seedLab(handle, booted.clerk);
    org = lab.organisation.id;
    practice = await createContact(handle.db, org, { kind: 'customer', name: 'Example Practice' });
    await createPriceItem(handle.db, org, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
    await connectDirectly(handle, xero.runtime, org);
    await handle.db.execute(sql`insert into xero_contacts (organisation_id, xero_contact_id, name, status, is_customer) values (${org}, ${XC}, 'Example Practice', 'ACTIVE', true)`);
    await handle.db.execute(sql`insert into xero_items (organisation_id, xero_item_id, code, name) values (${org}, 'i1', 'CRN', 'Crown')`);
  });
  after(async () => handle?.close());

  beforeEach(() => {
    xero.clock.at += 10 * 60_000;
    xero.runtime.remember(org, { access_token: 'synthetic-access-0', expires_in: 1800 });
  });

  const job = (overrides = {}) => observeJob(handle.db, org, {
    sourceSystem: 'worksystem', sourceJobRef: `JOB-${++jobs}`, caseRef: `CASE-${jobs}`, contactId: practice.id,
    shippedOn: '2026-10-17', lines: [{ itemCode: 'CRN' }], ...overrides,
  });

  test('with no invoice in Xero, the ledger records not found and makes the draft', async () => {
    const obligation = await job();
    const replay = xero.script([invoicesAnswer([]), invoicesAnswer([])]);
    const checked = await recordXeroEvidence(handle.db, xero.runtime, org, obligation, { actor });
    assert.equal(checked.accountingState, 'not_found');
    const { invoice } = await draftInvoiceForObligation(handle.db, org, obligation.id, { liveCheck: xeroLiveCheck(handle.db, xero.runtime, org), actor, reference: REFERENCE });
    assert.equal(invoice.reference, REFERENCE);
    assert.equal(replay.calls.length, 2);
    assert.match(replay.calls[0].query.where, new RegExp(`Reference=="${obligation.caseRef}"`));
  });

  test('a Xero invoice for the same customer and case reference refuses the draft and goes to a person', async () => {
    const obligation = await job();
    xero.script([invoicesAnswer([]), invoicesAnswer([xeroInvoice('hand-1', { reference: obligation.caseRef })]), organisation]);
    await recordXeroEvidence(handle.db, xero.runtime, org, obligation, { actor });
    await assert.rejects(
      draftInvoiceForObligation(handle.db, org, obligation.id, { liveCheck: xeroLiveCheck(handle.db, xero.runtime, org), actor }),
      (error) => error.code === 'not_ready' && /reports drafted/.test(error.details.reasons.join(' ')),
    );
    xero.script([invoicesAnswer([xeroInvoice('hand-1', { reference: obligation.caseRef })]), organisation]);
    const recorded = await recordXeroEvidence(handle.db, xero.runtime, org, obligation, { actor });
    assert.equal(recorded.accountingState, 'ambiguous', 'a reference match is not exact');
  });

  test('another customer\'s invoice with the same reference is not this job\'s', async () => {
    const obligation = await job();
    xero.script([invoicesAnswer([xeroInvoice('other-1', { reference: obligation.caseRef, contactId: 'someone-else' })])]);
    const evidence = await xeroLiveCheck(handle.db, xero.runtime, org)(obligation);
    assert.equal(evidence.state, 'not_found');
  });

  test('the work system\'s own invoice number is an exact match, with a link into Xero', async () => {
    const obligation = await job({ sourceInvoiceRef: 'WS-INV-5' });
    const replay = xero.script([
      invoicesAnswer([xeroInvoice('x-ws', { status: 'AUTHORISED', number: 'WS-INV-5' })], { InvoiceNumbers: 'WS-INV-5' }),
      invoicesAnswer([]),
      organisation,
    ]);
    const recorded = await recordXeroEvidence(handle.db, xero.runtime, org, obligation, { actor });
    assert.equal(recorded.accountingState, 'authorised');
    assert.equal(recorded.accountingRef, 'x-ws');
    assert.equal(recorded.accountingMatchedBy, 'source_invoice_ref');
    assert.match(recorded.accountingUrl, /^https:\/\/go\.xero\.com\/organisationlogin\/default\.aspx\?shortcode=!Ex4mp&redirecturl=/);
    assert.match(decodeURIComponent(recorded.accountingUrl), /InvoiceID=x-ws/);
    assert.equal(replay.calls[0].query.InvoiceNumbers, 'WS-INV-5');
  });

  test('a Xero error refuses the draft instead of guessing', async () => {
    const obligation = await job();
    xero.script([invoicesAnswer([])]);
    await recordXeroEvidence(handle.db, xero.runtime, org, obligation, { actor });
    xero.script([xeroAnswer('Invoices', { Message: 'down' }, { status: 503 })]);
    await assert.rejects(
      draftInvoiceForObligation(handle.db, org, obligation.id, { liveCheck: xeroLiveCheck(handle.db, xero.runtime, org), actor }),
      (error) => /the live accounting check failed/.test(error.details.reasons.join(' ')),
    );
  });

  test('a job\'s Flow invoice sent to Xero is found by flow_invoice, and its payment marks the job paid', async () => {
    const obligation = await job();
    xero.script([invoicesAnswer([]), invoicesAnswer([])]);
    await recordXeroEvidence(handle.db, xero.runtime, org, obligation, { actor });
    const { invoice } = await draftInvoiceForObligation(handle.db, org, obligation.id, { liveCheck: xeroLiveCheck(handle.db, xero.runtime, org), actor, reference: REFERENCE });
    await issueInvoice(handle.db, org, invoice.id, { issuedBy: actor, issueDate: '2026-10-18' });
    xero.script([
      invoicesAnswer([]),
      xeroAnswer('Invoices', { Invoices: [{ InvoiceID: 'x-flow', InvoiceNumber: 'INV-X', Status: 'DRAFT' }] }, { method: 'POST' }),
      readBack('x-flow', { reference: REFERENCE }),
    ]);
    const pushed = await pushDrafts(handle.db, xero.runtime, org, [invoice.id]);
    assert.equal(pushed.invoices[0].outcome, 'created', JSON.stringify(pushed));

    const payment = (id, extra = {}) => ({
      PaymentID: id, Date: '/Date(1792281600000+0000)/', Amount: 242, Reference: 'EFT 1', IsReconciled: true, Status: 'AUTHORISED',
      PaymentType: 'ACCRECPAYMENT', Invoice: { InvoiceID: 'x-flow', InvoiceNumber: 'INV-X' }, UpdatedDateUTC: '/Date(1792300000000+0000)/', ...extra,
    });
    const replay = xero.script([
      xeroAnswer('Payments', { Payments: [
        payment('p1'),
        payment('p2', { Invoice: { InvoiceID: 'not-a-job' } }),
        payment('p3', { Status: 'DELETED' }),
      ] }),
      readBack('x-flow', { status: 'PAID', paid: 242, reference: REFERENCE }),
      organisation,
    ]);
    const res = await request(app, '/api/xero/payments/sync', { token: lab.ownerToken, method: 'POST', body: { organisationId: org } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.recorded.map((p) => [p.paymentRef, p.matchedBy]), [['p1', 'flow_invoice']]);
    assert.deepEqual(res.body.unmatched.map((p) => p.paymentRef), ['p2']);
    assert.deepEqual(res.body.deleted.map((p) => p.paymentRef), ['p3']);
    assert.equal(res.body.cursor, new Date(1792300000000).toISOString());
    assert.equal(replay.calls[0].headers['If-Modified-Since'].length, 19, 'payments are read since a time');

    const explained = await explainObligation(handle.db, org, obligation.id);
    assert.equal(explained.view, 'paid');
    assert.equal(explained.obligation.accountingRef, 'x-flow');
    assert.equal(explained.obligation.accountingMatchedBy, 'flow_invoice');
    assert.deepEqual(explained.payments.map((p) => [p.paymentRef, p.paidOn, p.amountCents, p.reconciled]), [['p1', '2026-10-18', 24200, true]]);
    assert.equal(explained.writebacks.length, 1);
    assert.equal(explained.writebacks[0].status, 'paid');

    const { rows } = await handle.db.execute(sql`select payments_since from xero_payment_cursors where organisation_id = ${org}`);
    assert.equal(new Date(rows[0].payments_since).toISOString(), new Date(1792300000000).toISOString());

    // Read again: the same payment does not count twice.
    xero.script([xeroAnswer('Payments', { Payments: [payment('p1')] }), readBack('x-flow', { status: 'PAID', paid: 242, reference: REFERENCE }), organisation]);
    const again = await request(app, '/api/xero/payments/sync', { token: lab.ownerToken, method: 'POST', body: { organisationId: org } });
    assert.equal(again.status, 200);
    assert.equal((await explainObligation(handle.db, org, obligation.id)).obligation.paidCents, 24200);
  });

  test('staff cannot sync payments', async () => {
    const res = await request(app, '/api/xero/payments/sync', { token: lab.staffToken, method: 'POST', body: { organisationId: org } });
    assert.equal(res.status, 403);
  });
});
