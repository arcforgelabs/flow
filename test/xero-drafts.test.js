import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createContact, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, issueInvoice, listInvoiceVersions, reviseInvoice } from '../server/core/invoices.js';
import { saveCustomerBilling } from '../server/core/invoicing-rules.js';
import { draftInvoiceForObligation, observeJob, recordAccountingEvidence } from '../server/core/ledger.js';
import { sellingCodes, xeroItemsForCodes } from '../server/integrations/xero/catalogue.js';
import { buildDraft, differences, pushDrafts, readOnce } from '../server/integrations/xero/drafts.js';
import { createXeroRuntime } from '../server/integrations/xero/runtime.js';
import { resolveXeroSettings } from '../server/integrations/xero/settings.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, scriptedXero, seedLab, TOKEN_KEY, xeroAnswer } from './support/xero.js';

// Issued Flow invoices become Xero draft invoices. Xero is replayed with
// synthetic answers; Clerk is faked. Each test scripts the Xero answers it
// expects, so an unexpected call fails it.

const XC = '00000000-0000-4000-8000-0000000000c1';
const settings = resolveXeroSettings({ XERO_MODE: 'replay' });
const document = {
  number: 'INV-0007', version: 1, issueDate: '2026-10-18', dueDate: null, reference: 'CASE-7', currency: 'AUD',
  contact: { name: 'Example Practice' },
  lines: [
    { position: 1, itemCode: 'CROWN', description: 'Crown', quantity: 2, unitAmountCents: 25000, taxCode: 'GST', lineAmountCents: 50000, taxCents: 5000 },
    { position: 2, itemCode: null, description: 'Courier', quantity: 1, unitAmountCents: 1500, taxCode: 'GST_FREE', lineAmountCents: 1500, taxCents: 0 },
  ],
  subtotalCents: 51500, taxCents: 5000, totalCents: 56500,
};

function xeroInvoice(id, { total = 275, sub = 250, tax = 25, status = 'DRAFT', reference, date = '2026-10-18', contactId = XC, lines = 1 } = {}) {
  return {
    InvoiceID: id, InvoiceNumber: `INV-${id}`, Type: 'ACCREC', Status: status, Reference: reference,
    Contact: { ContactID: contactId, Name: 'Example Practice' }, DateString: `${date}T00:00:00`,
    SubTotal: sub, TotalTax: tax, Total: total, LineItems: Array.from({ length: lines }, () => ({})),
  };
}
const byReference = (list) => xeroAnswer('Invoices', { Invoices: list });
const created = (id) => xeroAnswer('Invoices', { Invoices: [{ InvoiceID: id, InvoiceNumber: `INV-${id}`, Status: 'DRAFT' }] }, { method: 'POST' });
const readBack = (id, options) => xeroAnswer(`Invoices/${id}`, { Invoices: [xeroInvoice(id, options)] });
const posts = (replay) => replay.calls.filter((c) => c.method === 'POST');

describe('the Xero draft for a document', () => {
  test('uses the issued document: item codes, Xero tax types, exclusive amounts, the due date', () => {
    const items = new Map([['CROWN', { code: 'CROWN' }]]);
    const { draft, problems } = buildDraft(document, { settings, contact: { xeroContactId: XC, salesTracking: [] }, items });
    assert.deepEqual(problems, []);
    assert.deepEqual(draft, {
      Type: 'ACCREC', Status: 'DRAFT', Contact: { ContactID: XC }, Date: '2026-10-18', DueDate: '2026-11-17',
      Reference: 'CASE-7', CurrencyCode: 'AUD', LineAmountTypes: 'Exclusive',
      LineItems: [
        { Description: 'Crown', Quantity: 2, UnitAmount: 250, LineAmount: 500, TaxType: 'OUTPUT', ItemCode: 'CROWN' },
        { Description: 'Courier', Quantity: 1, UnitAmount: 15, LineAmount: 15, TaxType: 'EXEMPTOUTPUT' },
      ],
    });
  });

  test('a line whose GST differs from its Xero item never goes', () => {
    const items = new Map([['CROWN', { code: 'CROWN', salesTaxType: 'EXEMPTOUTPUT' }]]);
    const { problems } = buildDraft(document, { settings, contact: { xeroContactId: XC, salesTracking: [] }, items });
    assert.deepEqual(problems.map((p) => [p.code, p.short]), [['xero_tax_differs', 'GST not as Xero']]);
    const agrees = new Map([['CROWN', { code: 'CROWN', salesTaxType: 'OUTPUT' }]]);
    assert.deepEqual(buildDraft(document, { settings, contact: { xeroContactId: XC, salesTracking: [] }, items: agrees }).problems, []);
    // GST from Xero off: Flow's own GST goes as it is.
    assert.deepEqual(buildDraft(document, { settings, contact: { xeroContactId: XC, salesTracking: [] }, items, taxFromXero: false }).problems, []);
  });

  test('a document whose prices include GST sends Inclusive line amounts', () => {
    const items = new Map([['CROWN', { code: 'CROWN' }]]);
    const { draft } = buildDraft({ ...document, amountsIncludeTax: true }, { settings, contact: { xeroContactId: XC, salesTracking: [] }, items });
    assert.equal(draft.LineAmountTypes, 'Inclusive');
    assert.deepEqual(draft.LineItems[0], { Description: 'Crown', Quantity: 2, UnitAmount: 250, LineAmount: 500, TaxType: 'OUTPUT', ItemCode: 'CROWN' });
  });

  test('a linked Xero item sends under Xero\'s own code; a gone link or an item not sold stops the draft', () => {
    const contact = { xeroContactId: XC, salesTracking: [] };
    const linked = buildDraft(document, { settings, contact, items: new Map([['CROWN', { code: 'CRN-01', linked: true }]]) });
    assert.deepEqual(linked.problems, []);
    assert.equal(linked.draft.LineItems[0].ItemCode, 'CRN-01');
    const gone = buildDraft(document, { settings, contact, items: new Map([['CROWN', { linkMissing: true }]]) });
    assert.equal(gone.problems[0].code, 'xero_item_missing');
    assert.match(gone.problems[0].message, /no longer in Xero/);
    assert.equal(gone.draft.LineItems[0].ItemCode, undefined);
    const unsold = buildDraft(document, { settings, contact, items: new Map([['CROWN', { code: 'CROWN', isSold: false }]]) });
    assert.match(unsold.problems[0].message, /not set to be sold/);
  });

  test('XERO_LINE_TEXT=item gives each line with an item the Xero item\'s name', () => {
    const contact = { xeroContactId: XC, salesTracking: [] };
    const items = new Map([['CROWN', { code: 'CRN-01', name: 'Crown - full contour' }]]);
    const flowText = buildDraft(document, { settings, contact, items }).draft.LineItems[0].Description;
    assert.equal(flowText, document.lines[0].description);
    const named = buildDraft(document, { settings: resolveXeroSettings({ XERO_MODE: 'replay', XERO_LINE_TEXT: 'item' }), contact, items });
    assert.equal(named.draft.LineItems[0].Description, 'Crown - full contour');
    assert.throws(() => resolveXeroSettings({ XERO_MODE: 'replay', XERO_LINE_TEXT: 'seazona' }), /XERO_LINE_TEXT/);
  });

  test('an item code Xero does not have stops the draft; tracking follows the contact, then the setting', () => {
    const tracked = { ...settings, tracking: { category: 'Department', option: 'Laboratory' }, invoiceNumber: 'flow' };
    const contact = { xeroContactId: XC, salesTracking: [{ category: 'department', option: 'Milling' }] };
    const { draft, problems } = buildDraft(document, { settings: tracked, contact, items: new Map() });
    assert.equal(problems[0].code, 'xero_item_missing');
    assert.deepEqual(draft.LineItems[1].Tracking, [{ Name: 'Department', Option: 'Milling' }]);
    assert.equal(draft.InvoiceNumber, 'INV-0007');
    const plain = buildDraft(document, { settings: tracked, contact: { xeroContactId: XC }, items: new Map([['CROWN', {}]]) });
    assert.deepEqual(plain.draft.LineItems[0].Tracking, [{ Name: 'Department', Option: 'Laboratory' }]);
  });

  test('a Xero invoice is compared with the document on contact, amounts, lines, reference and date', () => {
    const { draft } = buildDraft(document, { settings, contact: { xeroContactId: XC }, items: new Map([['CROWN', {}]]) });
    const same = xeroInvoice('x', { sub: 515, tax: 50, total: 565, reference: 'case-7', lines: 2 });
    assert.deepEqual(differences(same, draft, document), []);
    assert.deepEqual(differences({ ...same, Total: 566, Contact: { ContactID: 'other' } }, draft, document), ['contact', 'total']);
  });

  test('live mode writes nothing without XERO_ALLOW_LIVE_WRITES=on', async () => {
    const live = createXeroRuntime({
      settings: resolveXeroSettings({ XERO_MODE: 'live', XERO_CLIENT_ID: 'id', XERO_CLIENT_SECRET: 'secret', XERO_TOKEN_KEY: TOKEN_KEY, XERO_TENANT_NAME: 'Example Lab' }),
      fetch: async () => assert.fail('no request'),
    });
    await assert.rejects(pushDrafts(null, live, 'org', ['inv']), (error) => error.code === 'xero_writes_off');
  });

  test('a batch shares one read per key; a shared read that fails once is read again by each caller', async () => {
    const once = readOnce();
    let calls = 0;
    const read = async () => {
      calls += 1;
      if (calls === 1) throw new Error('passing fault');
      return 'contact';
    };
    const answers = await Promise.all([1, 2, 3, 4].map(() => once('payer', read)));
    assert.deepEqual(answers, ['contact', 'contact', 'contact', 'contact']);
    assert.equal(calls, 5, 'one shared read, then one read for each caller that waited on it');
    assert.equal(await once('payer', read), 'contact');
    assert.equal(calls, 6, 'the failed read is forgotten, so a later caller reads again');

    const shared = readOnce();
    let good = 0;
    const ok = async () => { good += 1; return 'items'; };
    await Promise.all([1, 2, 3].map(() => shared('items', ok)));
    assert.equal(good, 1, 'a read that works is shared');
  });
});

describe('Xero drafts from issued invoices', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let integrations;
  let lab;
  let xero;
  let practice;
  let crown;
  let counter = 0;

  before(async () => {
    handle = await freshDatabase();
    xero = scriptedXero();
    const booted = await bootFlow(handle, { runtime: xero.runtime, log: xero.log });
    app = booted.app;
    integrations = booted.integrations;
    lab = await seedLab(handle, booted.clerk);
    const org = lab.organisation.id;
    practice = await createContact(handle.db, org, { kind: 'customer', name: 'Example Practice' });
    crown = await createPriceItem(handle.db, org, { code: 'CROWN', name: 'Crown', unitAmountCents: 25000 });
    await connectDirectly(handle, xero.runtime, org);
    await handle.db.execute(sql`insert into xero_contacts (organisation_id, xero_contact_id, name, status, is_customer) values (${org}, ${XC}, 'Example Practice', 'ACTIVE', true)`);
    await handle.db.execute(sql`insert into xero_items (organisation_id, xero_item_id, code, name) values (${org}, 'i1', 'CROWN', 'Crown')`);
    await handle.db.execute(sql`insert into xero_sync_runs (organisation_id, status, finished_at) values (${org}, 'succeeded', now())`);
  });
  after(async () => handle?.close());

  beforeEach(() => {
    // Ten minutes on: the governor's minute window is clear, and the access
    // token is renewed in memory.
    xero.clock.at += 10 * 60_000;
    xero.runtime.remember(lab.organisation.id, { access_token: 'synthetic-access-0', expires_in: 1800 });
  });

  // An issued invoice of one crown: 250.00 + 25.00 GST.
  async function issued(reference = `CASE-${++counter}`) {
    const draft = await createDraftInvoice(handle.db, lab.organisation.id, { contactId: practice.id, reference, lines: [{ priceItemId: crown.id }] });
    return issueInvoice(handle.db, lab.organisation.id, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-18' });
  }

  const push = (ids, extra = {}, token = lab.ownerToken) => request(app, '/api/xero/invoices/push', {
    token, method: 'POST', body: { organisationId: lab.organisation.id, invoiceIds: ids, ...extra },
  });
  const pushRow = async (invoiceId) => (await handle.db.execute(sql`select * from xero_invoice_pushes where invoice_id = ${invoiceId} order by version`)).rows;

  test('Flow finds the Xero item by its link, by Xero\'s id, and never falls back when the link is gone', async () => {
    const org = lab.organisation.id;
    const bridge = await createPriceItem(handle.db, org, { code: 'BRIDGE', name: 'Bridge', unitAmountCents: 50000 });
    const veneer = await createPriceItem(handle.db, org, { code: 'VENEER', name: 'Veneer', unitAmountCents: 40000 });
    await handle.db.execute(sql`insert into xero_items (organisation_id, xero_item_id, code, name) values (${org}, 'i2', 'BR-X', 'Bridge unit'), (${org}, 'i3', 'VENEER', 'Veneer')`);
    await handle.db.execute(sql`insert into price_item_links (organisation_id, price_item_id, system, external_id, external_code, matched_by)
      values (${org}, ${bridge.id}, 'xero', 'i2', 'OLD-CODE', 'person'), (${org}, ${veneer.id}, 'xero', 'i-gone', 'VENEER', 'code')`);
    const found = await xeroItemsForCodes(handle.db, org, ['CROWN', 'BRIDGE', 'VENEER', 'NONE']);
    assert.equal(found.get('CROWN').code, 'CROWN', 'no link: same code');
    assert.equal(found.get('BRIDGE').code, 'BR-X', 'linked: Xero\'s current code, not the saved one');
    assert.equal(found.get('VENEER').linkMissing, true, 'the link wins over a same-code item');
    assert.equal(found.has('NONE'), false);
    // The rule field "Every item is in accounting" counts only items that sell.
    await handle.db.execute(sql`insert into xero_items (organisation_id, xero_item_id, code, name, is_sold) values (${org}, 'i4', 'INLAY', 'Inlay', false)`);
    assert.deepEqual((await sellingCodes(handle.db, org, ['CROWN', 'BRIDGE', 'VENEER', 'NONE', 'INLAY'])).sort(), ['BRIDGE', 'CROWN']);

    // Through the Send preview route: the linked code sends as Xero's item,
    // with Flow's own line text (XERO_LINE_TEXT is not set); a gone link stops it.
    const make = async (item) => {
      const draft = await createDraftInvoice(handle.db, org, { contactId: practice.id, reference: `CASE-${++counter}`, lines: [{ priceItemId: item.id }] });
      return issueInvoice(handle.db, org, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-18' });
    };
    const [linked, gone] = [await make(bridge), await make(veneer)];
    const res = await request(app, '/api/xero/invoices/preview', {
      token: lab.staffToken, method: 'POST', body: { organisationId: org, invoiceIds: [linked.id, gone.id] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [a, b] = res.body.invoices;
    assert.deepEqual(a.problems, []);
    assert.equal(a.draft.LineItems[0].ItemCode, 'BR-X');
    assert.equal(a.draft.LineItems[0].Description, 'Bridge');
    assert.equal(b.state, 'blocked');
    assert.equal(b.problems[0].code, 'xero_item_missing');
  });

  test('preview shows the draft and what stops it, without calling Xero', async () => {
    const replay = xero.script([]);
    const ready = await issued();
    const other = await createContact(handle.db, lab.organisation.id, { kind: 'customer', name: 'Unknown Practice' });
    const blocked = await createDraftInvoice(handle.db, lab.organisation.id, {
      contactId: other.id, lines: [{ description: 'Hand line', unitAmountCents: 100 }],
    });
    const res = await request(app, '/api/xero/invoices/preview', {
      token: lab.staffToken, method: 'POST', body: { organisationId: lab.organisation.id, invoiceIds: [ready.id, blocked.id] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [a, b] = res.body.invoices;
    assert.equal(a.state, 'ready');
    assert.deepEqual(a.problems, []);
    assert.equal(a.contact.xeroContactId, XC);
    assert.equal(a.draft.LineItems[0].ItemCode, 'CROWN');
    assert.equal(a.draft.Reference, `CASE-${counter}`);
    assert.equal(b.state, 'blocked');
    assert.deepEqual(b.problems.map((p) => p.code).sort(), ['invoice_not_issued', 'xero_contact_missing']);
    assert.equal(replay.calls.length, 0);
  });

  test('a preview of many invoices answers each one, in the order asked, with its own customer', async () => {
    const org = lab.organisation.id;
    const stranger = await createContact(handle.db, org, { kind: 'customer', name: 'Stranger Practice' });
    const ids = [];
    for (let i = 0; i < 9; i++) {
      const draft = await createDraftInvoice(handle.db, org, { contactId: i % 3 === 2 ? stranger.id : practice.id, reference: `CASE-${++counter}`, lines: [{ priceItemId: crown.id }] });
      ids.push((await issueInvoice(handle.db, org, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-18' })).id);
    }
    const res = await request(app, '/api/xero/invoices/preview', {
      token: lab.staffToken, method: 'POST', body: { organisationId: org, invoiceIds: ids },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.invoices.map((p) => p.invoiceId), ids);
    assert.deepEqual(res.body.invoices.map((p) => p.state), ids.map((_, i) => (i % 3 === 2 ? 'blocked' : 'ready')));
    assert.deepEqual(res.body.invoices.filter((p) => p.state === 'blocked').map((p) => p.problems.map((q) => q.code)), [['xero_contact_missing'], ['xero_contact_missing'], ['xero_contact_missing']]);
  });

  test('a client billed to another customer previews under the payer\'s Xero contact', async () => {
    const org = lab.organisation.id;
    const member = await createContact(handle.db, org, { kind: 'customer', name: 'Member Clinic' });
    await saveCustomerBilling(handle.db, org, member.id, { billToContactId: practice.id });
    const lost = await createContact(handle.db, org, { kind: 'customer', name: 'Lost Payer' });
    const orphan = await createContact(handle.db, org, { kind: 'customer', name: 'Orphan Clinic' });
    await saveCustomerBilling(handle.db, org, orphan.id, { billToContactId: lost.id });
    const ids = [];
    for (const contactId of [member.id, orphan.id]) {
      const draft = await createDraftInvoice(handle.db, org, { contactId, reference: `CASE-${++counter}`, lines: [{ priceItemId: crown.id }] });
      ids.push((await issueInvoice(handle.db, org, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-18' })).id);
    }
    const res = await request(app, '/api/xero/invoices/preview', {
      token: lab.staffToken, method: 'POST', body: { organisationId: org, invoiceIds: ids },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [billed, missing] = res.body.invoices;
    assert.equal(billed.state, 'ready');
    assert.equal(billed.contact.xeroContactId, XC);
    assert.equal(missing.state, 'blocked');
    assert.deepEqual(missing.problems.map((p) => [p.code, p.short]), [['xero_contact_missing', 'Payer not in Xero']]);
    assert.match(missing.problems[0].message, /billed to Lost Payer/);
    for (const c of [member, orphan]) await saveCustomerBilling(handle.db, org, c.id, { billToContactId: null });
  });

  test('staff cannot send invoices to Xero', async () => {
    const invoice = await issued();
    assert.equal((await push([invoice.id], {}, lab.staffToken)).status, 403);
  });

  test('an issued invoice becomes one verified Xero draft, and sending again makes no second one', async () => {
    const invoice = await issued();
    const replay = xero.script([byReference([]), created('x1'), readBack('x1', { reference: invoice.reference })]);
    const res = await push([invoice.id]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.invoices[0].outcome, 'created');
    assert.equal(res.body.invoices[0].verified, true);
    assert.equal(res.body.summary.created, 1);
    const [sent] = posts(replay);
    assert.match(sent.headers['Idempotency-Key'], /^flow-xero-[0-9a-f]{48}$/);
    assert.equal(sent.body.Invoices[0].Status, 'DRAFT');
    assert.equal(sent.body.Invoices[0].Type, 'ACCREC');
    const [row] = await pushRow(invoice.id);
    assert.equal(row.state, 'created');
    assert.equal(row.xero_invoice_id, 'x1');

    const again = xero.script([]);
    const second = await push([invoice.id]);
    assert.equal(second.body.invoices[0].outcome, 'already_in_xero');
    assert.equal(again.calls.length, 0);
  });

  test('the PDF learns what the customer\'s Xero copy says, from Flow\'s copy, with no calls', async () => {
    const org = lab.organisation.id;
    const invoice = await issued('Dr Example - Sample Patient');
    const facts = integrations.with('documentFacts')[0].capabilities.documentFacts;
    const none = xero.script([]);
    assert.deepEqual(await facts({ organisationId: org, invoiceId: invoice.id, version: 1 }),
      { system: 'Xero', sent: false, numberedBy: 'xero', defaultDueDays: xero.runtime.settings.defaultDueDays });

    xero.script([byReference([]), created('xpdf'), readBack('xpdf', { reference: invoice.reference })]);
    assert.equal(none.calls.length, 0);
    assert.equal((await push([invoice.id])).status, 200);
    const silent = xero.script([]);
    const sent = await facts({ organisationId: org, invoiceId: invoice.id, version: 1 });
    assert.equal(sent.sent, true);
    assert.equal(sent.number, 'INV-xpdf');
    assert.equal(sent.reference, 'Dr Example - Sample Patient', 'from the request Flow sent');
    assert.equal(sent.issueDate, '2026-10-18');

    // The mirror, once it has the invoice, wins over what Flow sent.
    await handle.db.execute(sql`insert into xero_invoices (organisation_id, xero_invoice_id, type, invoice_number, status, issued_on, due_on, record_hash)
      values (${org}, 'xpdf', 'ACCREC', 'INV-9001', 'AUTHORISED', '2026-10-20', '2026-11-19', 'h')`);
    const mirrored = await facts({ organisationId: org, invoiceId: invoice.id, version: 1 });
    assert.deepEqual([mirrored.number, mirrored.issueDate, mirrored.dueDate, mirrored.status], ['INV-9001', '2026-10-20', '2026-11-19', 'AUTHORISED']);
    assert.equal(silent.calls.length, 0);
  });

  test('an invoice made by hand in Xero with the same contact, reference and total is recorded, not made twice', async () => {
    const invoice = await issued();
    const replay = xero.script([byReference([xeroInvoice('hand-1', { reference: invoice.reference, total: 275, sub: 250, tax: 25, status: 'AUTHORISED' })])]);
    const res = await push([invoice.id]);
    assert.equal(res.body.invoices[0].outcome, 'existing');
    assert.equal(res.body.invoices[0].xero.invoiceId, 'hand-1');
    assert.equal(posts(replay).length, 0);
    assert.equal((await pushRow(invoice.id))[0].state, 'existing');
  });

  test('the same reference at another amount is held, unless a person chose to send anyway', async () => {
    const invoice = await issued();
    const recent = xeroInvoice('hand-2', { reference: invoice.reference, total: 300, date: new Date(xero.clock.at).toISOString().slice(0, 10) });
    let replay = xero.script([byReference([recent])]);
    const held = await push([invoice.id]);
    assert.equal(held.body.invoices[0].outcome, 'failed');
    assert.equal(held.body.invoices[0].error.code, 'xero_same_reference_different_amount');
    assert.equal(held.body.invoices[0].error.short, 'Duplicate?');
    assert.equal(posts(replay).length, 0);
    assert.equal((await pushRow(invoice.id)).length, 0);

    replay = xero.script([byReference([recent]), created('x2'), readBack('x2', { reference: invoice.reference, total: 275, sub: 250, tax: 25 })]);
    const sent = await push([invoice.id], { allowExistingReference: [invoice.id] });
    assert.equal(sent.body.invoices[0].outcome, 'created');
    assert.deepEqual((await pushRow(invoice.id))[0].pre_existing_ids, ['hand-2']);
  });

  test('an override passes its own tax warning by key, sends Flow\'s tax, and hides no other problem', async () => {
    const org = lab.organisation.id;
    const ship = await createPriceItem(handle.db, org, { code: 'SHIP', name: 'Shipping', unitAmountCents: 1500 });
    await handle.db.execute(sql`insert into xero_items (organisation_id, xero_item_id, code, name, sales_tax_type) values (${org}, 'i-ship', 'SHIP', 'Shipping', 'EXEMPTOUTPUT')`);
    const pushInvoices = integrations.with('pushInvoices')[0].capabilities.pushInvoices;
    const shipped = async (lines = [{ priceItemId: ship.id }]) => {
      const draft = await createDraftInvoice(handle.db, org, { contactId: practice.id, reference: `CASE-${++counter}`, lines });
      return issueInvoice(handle.db, org, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-18' });
    };
    const key = 'xero_tax_differs:1:SHIP';

    // With no override the line never goes, and the public push route takes no override.
    const invoice = await shipped();
    let replay = xero.script([]);
    const held = await push([invoice.id], { accepted: { [invoice.id]: [key] } });
    assert.equal(held.body.invoices[0].error.code, 'xero_tax_differs');
    assert.equal(replay.calls.length, 0);

    // A key for another line passes nothing.
    const wrong = await pushInvoices({ organisationId: org, invoiceIds: [invoice.id], accepted: new Map([[invoice.id, ['xero_tax_differs:2:SHIP']]]) });
    assert.equal(wrong.invoices[0].error.code, 'xero_tax_differs');

    // The recorded key passes: the line goes with its item code and Flow's tax.
    replay = xero.script([byReference([]), created('o1'), readBack('o1', { reference: invoice.reference, total: 16.5, sub: 15, tax: 1.5 })]);
    const sent = await pushInvoices({ organisationId: org, invoiceIds: [invoice.id], accepted: new Map([[invoice.id, [key]]]) });
    assert.equal(sent.invoices[0].outcome, 'created', JSON.stringify(sent.invoices[0]));
    const [line] = posts(replay)[0].body.Invoices[0].LineItems;
    assert.equal(line.ItemCode, 'SHIP');
    assert.equal(line.TaxType, 'OUTPUT');

    // An accepted warning does not hide a second problem.
    const gone = await createPriceItem(handle.db, org, { code: 'GONE', name: 'Not in Xero', unitAmountCents: 1000 });
    const two = await shipped([{ priceItemId: ship.id }, { priceItemId: gone.id }]);
    replay = xero.script([]);
    const stopped = await pushInvoices({ organisationId: org, invoiceIds: [two.id], accepted: new Map([[two.id, [key]]]) });
    assert.equal(stopped.invoices[0].error.code, 'xero_item_missing');
    assert.equal(replay.calls.length, 0);
  });

  test('an override goes as a Xero draft, also for a customer whose invoices Flow approves and emails', async () => {
    const org = lab.organisation.id;
    const XO = '00000000-0000-4000-8000-0000000000f1';
    const emailing = await createContact(handle.db, org, { kind: 'customer', name: 'Override Practice' });
    await handle.db.execute(sql`insert into xero_contacts (organisation_id, xero_contact_id, name, email, status, is_customer) values (${org}, ${XO}, 'Override Practice', 'accounts@example.com', 'ACTIVE', true)`);
    await saveCustomerBilling(handle.db, org, emailing.id, { sendMode: 'approve_and_email' });
    const [ship] = (await handle.db.execute(sql`select id from price_items where organisation_id = ${org} and code = 'SHIP'`)).rows;
    const draft = await createDraftInvoice(handle.db, org, { contactId: emailing.id, reference: `CASE-${++counter}`, lines: [{ priceItemId: ship.id }] });
    const invoice = await issueInvoice(handle.db, org, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-18' });
    const replay = xero.script([byReference([]), created('o2'), xeroAnswer('Invoices/o2', { Invoices: [{ ...xeroInvoice('o2', { reference: invoice.reference, total: 16.5, sub: 15, tax: 1.5 }), Contact: { ContactID: XO } }] })]);
    const sent = await integrations.with('pushInvoices')[0].capabilities.pushInvoices({
      organisationId: org, invoiceIds: [invoice.id], accepted: new Map([[invoice.id, ['xero_tax_differs:1:SHIP']]]),
    });
    assert.equal(sent.invoices[0].outcome, 'created', JSON.stringify(sent.invoices[0]));
    assert.equal(posts(replay).length, 1);
    assert.equal(posts(replay)[0].body.Invoices[0].Status, 'DRAFT');
    assert.equal((await pushRow(invoice.id))[0].send_mode, 'accounting_draft');
  });

  test('when Xero refuses the draft, nothing is recorded and it can be sent again', async () => {
    const invoice = await issued();
    xero.script([byReference([]), xeroAnswer('Invoices', { Invoices: [{ HasErrors: true, ValidationErrors: [{ Message: 'Contact is archived.' }] }] }, { method: 'POST' })]);
    const res = await push([invoice.id]);
    assert.equal(res.body.invoices[0].outcome, 'failed');
    assert.equal(res.body.invoices[0].error.code, 'xero_validation_failed');
    assert.equal((await pushRow(invoice.id)).length, 0);
  });

  test('an unknown outcome is repeated with the same key and body inside six minutes', async () => {
    const invoice = await issued();
    const first = xero.script([byReference([]), xeroAnswer('Invoices', { Message: 'unavailable' }, { method: 'POST', status: 503 })]);
    const res = await push([invoice.id]);
    assert.equal(res.body.invoices[0].outcome, 'ambiguous');
    assert.equal((await pushRow(invoice.id))[0].state, 'ambiguous');

    xero.clock.at += 2 * 60_000;
    xero.runtime.remember(lab.organisation.id, { access_token: 'synthetic-access-0', expires_in: 1800 });
    const second = xero.script([created('x3'), readBack('x3', { reference: invoice.reference, total: 275, sub: 250, tax: 25 })]);
    const retried = await push([invoice.id]);
    assert.equal(retried.body.invoices[0].outcome, 'created');
    assert.equal(posts(second)[0].headers['Idempotency-Key'], posts(first)[0].headers['Idempotency-Key']);
    assert.deepEqual(posts(second)[0].body, posts(first)[0].body);
    assert.equal(second.calls.filter((c) => c.path.endsWith('/Invoices') && c.method === 'GET').length, 0, 'inside the window Flow does not look first');
  });

  test('after six minutes Flow looks in Xero first and settles on the draft it finds', async () => {
    const invoice = await issued();
    xero.script([byReference([]), xeroAnswer('Invoices', {}, { method: 'POST', status: 502 })]);
    assert.equal((await push([invoice.id])).body.invoices[0].outcome, 'ambiguous');

    xero.clock.at += 7 * 60_000;
    xero.runtime.remember(lab.organisation.id, { access_token: 'synthetic-access-0', expires_in: 1800 });
    const found = xeroInvoice('x4', { reference: invoice.reference, total: 275, sub: 250, tax: 25 });
    const replay = xero.script([byReference([found]), readBack('x4', { reference: invoice.reference, total: 275, sub: 250, tax: 25 })]);
    const res = await push([invoice.id]);
    assert.equal(res.body.invoices[0].outcome, 'reconciled');
    assert.equal(posts(replay).length, 0);
    assert.equal((await pushRow(invoice.id))[0].xero_invoice_id, 'x4');
  });

  test('after six minutes, with no draft in Xero, Flow sends again under a new key', async () => {
    const invoice = await issued();
    const first = xero.script([byReference([]), xeroAnswer('Invoices', {}, { method: 'POST', status: 504 })]);
    await push([invoice.id]);
    xero.clock.at += 7 * 60_000;
    xero.runtime.remember(lab.organisation.id, { access_token: 'synthetic-access-0', expires_in: 1800 });
    const second = xero.script([byReference([]), created('x5'), readBack('x5', { reference: invoice.reference, total: 275, sub: 250, tax: 25 })]);
    const res = await push([invoice.id]);
    assert.equal(res.body.invoices[0].outcome, 'created');
    assert.notEqual(posts(second)[0].headers['Idempotency-Key'], posts(first)[0].headers['Idempotency-Key']);
    assert.equal((await pushRow(invoice.id))[0].attempts, 2);
  });

  test('a draft Xero holds differently from the document is recorded for a person to check', async () => {
    const invoice = await issued();
    xero.script([byReference([]), created('x6'), readBack('x6', { reference: invoice.reference, total: 275.01, sub: 250, tax: 25.01 })]);
    const res = await push([invoice.id]);
    assert.equal(res.body.invoices[0].outcome, 'mismatch');
    assert.match(res.body.invoices[0].error.message, /tax, total/);
    assert.equal((await pushRow(invoice.id))[0].state, 'mismatch');
  });

  test('a revised invoice goes to Xero only once the earlier version\'s draft is gone there; the earlier record stays', async () => {
    const invoice = await issued();
    xero.script([byReference([]), created('x7'), readBack('x7', { reference: invoice.reference, total: 275, sub: 250, tax: 25 })]);
    assert.equal((await push([invoice.id])).body.invoices[0].outcome, 'created');
    await reviseInvoice(handle.db, lab.organisation.id, invoice.id);
    await issueInvoice(handle.db, lab.organisation.id, invoice.id, { issuedBy: 'user:test', issueDate: '2026-10-18' });

    let replay = xero.script([readBack('x7', { reference: invoice.reference, total: 275, sub: 250, tax: 25 })]);
    const held = await push([invoice.id]);
    assert.equal(held.body.invoices[0].error.code, 'xero_earlier_version_in_xero');
    assert.equal(posts(replay).length, 0);

    replay = xero.script([
      readBack('x7', { status: 'DELETED', reference: invoice.reference }),
      byReference([xeroInvoice('x7', { status: 'DELETED', reference: invoice.reference })]),
      created('x8'),
      readBack('x8', { reference: invoice.reference, total: 275, sub: 250, tax: 25 }),
    ]);
    const sent = await push([invoice.id]);
    assert.equal(sent.body.invoices[0].outcome, 'created');
    assert.equal(sent.body.invoices[0].version, 2);
    const rows = await pushRow(invoice.id);
    assert.deepEqual(rows.map((r) => [r.version, r.state, r.xero_invoice_id]), [[1, 'created', 'x7'], [2, 'created', 'x8']]);
    assert.equal((await listInvoiceVersions(handle.db, lab.organisation.id, invoice.id)).length, 2);
  });

  test('a draft or void invoice is never sent', async () => {
    const draft = await createDraftInvoice(handle.db, lab.organisation.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    xero.script([]);
    const res = await push([draft.id]);
    assert.equal(res.body.invoices[0].error.code, 'invoice_not_issued');
  });

  test('the port\'s pushInvoice sends one invoice', async () => {
    const invoice = await issued();
    xero.script([byReference([]), created('x9'), readBack('x9', { reference: invoice.reference, total: 275, sub: 250, tax: 25 })]);
    const result = await integrations.whenEnabled('xero', (adapter) => adapter.capabilities.pushInvoice({ organisationId: lab.organisation.id, invoiceId: invoice.id }));
    assert.equal(result.outcome, 'created');
    assert.equal(result.xero.invoiceId, 'x9');
  });

  test('the database refuses a push of a version that was never issued', async () => {
    const draft = await createDraftInvoice(handle.db, lab.organisation.id, { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    await assert.rejects(handle.pool.query(
      "insert into xero_invoice_pushes (organisation_id, invoice_id, version, state, idempotency_key, request_body, body_hash) values ($1, $2, 1, 'dispatching', 'k', '{}', 'h')",
      [lab.organisation.id, draft.id],
    ), /xero_invoice_pushes_version_issued/);
  });

  test('the push record of an invoice is shown without the request', async () => {
    const [row] = (await handle.db.execute(sql`select invoice_id from xero_invoice_pushes where state = 'created' limit 1`)).rows;
    const res = await request(app, `/api/xero/invoices/${row.invoice_id}/pushes?organisationId=${lab.organisation.id}`, { token: lab.staffToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.pushes[0].state, 'created');
    assert.equal(res.body.pushes[0].requestBody, undefined);
    assert.equal(res.body.pushes[0].idempotencyKey, undefined);
  });

  describe('a customer whose invoices are approved in Flow and emailed by Xero', () => {
    const XE = '00000000-0000-4000-8000-0000000000e1';
    let emailing;
    const emailed = (id, options = {}) => xeroAnswer(`Invoices/${id}/Email`, undefined, { method: 'POST', status: 204, ...options });
    const approved = (id) => xeroAnswer('Invoices', { Invoices: [{ InvoiceID: id, InvoiceNumber: `INV-${id}`, Status: 'AUTHORISED' }] }, { method: 'POST' });
    const readApproved = (id, reference) => xeroAnswer(`Invoices/${id}`, { Invoices: [{ ...xeroInvoice(id, { reference, status: 'AUTHORISED' }), Contact: { ContactID: XE } }] });

    before(async () => {
      const org = lab.organisation.id;
      emailing = await createContact(handle.db, org, { kind: 'customer', name: 'Email Practice' });
      await handle.db.execute(sql`insert into xero_contacts (organisation_id, xero_contact_id, name, email, status, is_customer) values (${org}, ${XE}, 'Email Practice', 'accounts@example.com', 'ACTIVE', true)`);
      await saveCustomerBilling(handle.db, org, emailing.id, { sendMode: 'approve_and_email' });
    });

    async function issuedFor(contact, reference = `CASE-${++counter}`) {
      const draft = await createDraftInvoice(handle.db, lab.organisation.id, { contactId: contact.id, reference, lines: [{ priceItemId: crown.id }] });
      return issueInvoice(handle.db, lab.organisation.id, draft.id, { issuedBy: 'user:test', issueDate: '2026-10-18' });
    }

    test('preview names the send mode', async () => {
      xero.script([]);
      const invoice = await issuedFor(emailing);
      const res = await request(app, '/api/xero/invoices/preview', {
        token: lab.staffToken, method: 'POST', body: { organisationId: lab.organisation.id, invoiceIds: [invoice.id] },
      });
      assert.equal(res.body.invoices[0].sendMode, 'approve_and_email');
      assert.equal(res.body.invoices[0].draft.Status, 'AUTHORISED');
      assert.deepEqual(res.body.invoices[0].problems, []);
    });

    test('the invoice goes to Xero approved, Xero emails it once, and sending again emails nothing', async () => {
      const invoice = await issuedFor(emailing);
      const replay = xero.script([byReference([]), approved('e1'), readApproved('e1', invoice.reference), emailed('e1')]);
      const res = await push([invoice.id]);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const [result] = res.body.invoices;
      assert.equal(result.outcome, 'created');
      assert.equal(result.email.state, 'sent');
      assert.equal(res.body.summary.emailed, 1);
      const [sent] = posts(replay);
      assert.equal(sent.body.Invoices[0].Status, 'AUTHORISED');
      assert.equal(posts(replay)[1].path, '/api.xro/2.0/Invoices/e1/Email');
      const [row] = await pushRow(invoice.id);
      assert.equal(row.send_mode, 'approve_and_email');
      assert.equal(row.email_state, 'sent');

      const again = xero.script([]);
      const second = await push([invoice.id]);
      assert.equal(second.body.invoices[0].outcome, 'already_in_xero');
      assert.equal(second.body.invoices[0].email.state, 'sent');
      assert.equal(again.calls.length, 0);
    });

    test('an email Xero refused is tried again on the next send; an unknown outcome is not', async () => {
      const invoice = await issuedFor(emailing);
      xero.script([byReference([]), approved('e2'), readApproved('e2', invoice.reference),
        emailed('e2', { status: 400 })]);
      const refused = await push([invoice.id]);
      assert.equal(refused.body.invoices[0].outcome, 'created');
      assert.equal(refused.body.invoices[0].email.state, 'failed');
      assert.equal(refused.body.summary.emailProblems, 1);

      xero.script([emailed('e2', { status: 503 })]);
      const unknown = await push([invoice.id]);
      assert.equal(unknown.body.invoices[0].email.state, 'unknown');

      const none = xero.script([]);
      const after = await push([invoice.id]);
      assert.equal(after.body.invoices[0].email.state, 'unknown');
      assert.equal(none.calls.length, 0);
    });

    test('a press that chose Approve and email sends a draft-mode customer approved, and Xero emails it', async () => {
      const org = lab.organisation.id;
      const XP = '00000000-0000-4000-8000-0000000000e2';
      const chosen = await createContact(handle.db, org, { kind: 'customer', name: 'Chosen Practice' });
      await handle.db.execute(sql`insert into xero_contacts (organisation_id, xero_contact_id, name, email, status, is_customer) values (${org}, ${XP}, 'Chosen Practice', 'billing@example.com', 'ACTIVE', true)`);
      const invoice = await issuedFor(chosen);
      await handle.db.execute(sql`update invoices set send_mode = 'approve_and_email' where id = ${invoice.id}`);
      const preview = await request(app, '/api/xero/invoices/preview', {
        token: lab.staffToken, method: 'POST', body: { organisationId: org, invoiceIds: [invoice.id] },
      });
      assert.equal(preview.body.invoices[0].sendMode, 'approve_and_email');
      assert.equal(preview.body.invoices[0].contact.email, 'billing@example.com');
      const replay = xero.script([byReference([]), approved('e3'), xeroAnswer('Invoices/e3', { Invoices: [{ ...xeroInvoice('e3', { reference: invoice.reference, status: 'AUTHORISED' }), Contact: { ContactID: XP } }] }), emailed('e3')]);
      const res = await push([invoice.id]);
      assert.equal(res.body.invoices[0].outcome, 'created', JSON.stringify(res.body));
      assert.equal(res.body.invoices[0].email.state, 'sent');
      assert.equal(posts(replay)[0].body.Invoices[0].Status, 'AUTHORISED');
      assert.equal((await pushRow(invoice.id))[0].send_mode, 'approve_and_email');
    });

    test('a press that chose Approve and email sends a Xero draft when the Xero contact has no email', async () => {
      const org = lab.organisation.id;
      const XN = '00000000-0000-4000-8000-0000000000e3';
      const silent = await createContact(handle.db, org, { kind: 'customer', name: 'Silent Practice' });
      await handle.db.execute(sql`insert into xero_contacts (organisation_id, xero_contact_id, name, email, status, is_customer) values (${org}, ${XN}, 'Silent Practice', null, 'ACTIVE', true)`);
      const invoice = await issuedFor(silent);
      await handle.db.execute(sql`update invoices set send_mode = 'approve_and_email' where id = ${invoice.id}`);
      const replay = xero.script([byReference([]), created('n1'), xeroAnswer('Invoices/n1', { Invoices: [{ ...xeroInvoice('n1', { reference: invoice.reference }), Contact: { ContactID: XN } }] })]);
      const res = await push([invoice.id]);
      assert.equal(res.body.invoices[0].outcome, 'created', JSON.stringify(res.body));
      assert.equal(res.body.invoices[0].email, undefined);
      assert.equal(posts(replay).length, 1);
      assert.equal(posts(replay)[0].body.Invoices[0].Status, 'DRAFT');
    });

    test('a press that chose Draft sends an emailing customer as a Xero draft', async () => {
      const invoice = await issuedFor(emailing);
      await handle.db.execute(sql`update invoices set send_mode = 'accounting_draft' where id = ${invoice.id}`);
      const replay = xero.script([byReference([]), created('d9'), xeroAnswer('Invoices/d9', { Invoices: [{ ...xeroInvoice('d9', { reference: invoice.reference }), Contact: { ContactID: XE } }] })]);
      const res = await push([invoice.id]);
      assert.equal(res.body.invoices[0].outcome, 'created', JSON.stringify(res.body));
      assert.equal(posts(replay)[0].body.Invoices[0].Status, 'DRAFT');
      assert.equal(posts(replay).length, 1);
    });

    test('other customers still get a Xero draft and no email', async () => {
      const invoice = await issued();
      const replay = xero.script([byReference([]), created('d1'), readBack('d1', { reference: invoice.reference })]);
      const res = await push([invoice.id]);
      assert.equal(res.body.invoices[0].outcome, 'created');
      assert.equal(res.body.invoices[0].email, undefined);
      assert.equal(posts(replay)[0].body.Invoices[0].Status, 'DRAFT');
      assert.equal(posts(replay).length, 1);
    });
  });

  test('an invoice drafted from a job that Flow\'s fresh copy of Xero cleared still gets the live duplicate check', async () => {
    const org = lab.organisation.id;
    const now = new Date(xero.clock.at);
    for (const resource of ['invoices', 'credit_notes', 'payments']) {
      await handle.db.execute(sql`insert into xero_mirror_cursors (organisation_id, resource, passes, last_pass_finished_at)
        values (${org}, ${resource}, 1, ${now}) on conflict (organisation_id, resource) do update set passes = 1, last_pass_finished_at = ${now}`);
    }
    const job = await observeJob(handle.db, org, {
      sourceSystem: 'seazona', sourceJobRef: 'job-copy-1', caseRef: 'CASE-COPY-1', contactId: practice.id,
      lines: [{ itemCode: 'CROWN', description: 'Crown', quantity: 1 }], observedAt: now,
    });
    await recordAccountingEvidence(handle.db, org, job.id, { state: 'not_found', actor: 'test', checkedAt: now });
    const { invoice } = await draftInvoiceForObligation(handle.db, org, job.id, { liveCheck: async () => ({ state: 'not_found' }), actor: 'test', now, reference: 'Dr Copy - Pat Copy' });
    await issueInvoice(handle.db, org, invoice.id, { issuedBy: 'user:test', issueDate: '2026-10-18' });
    const replay = xero.script([byReference([]), created('c1'), readBack('c1', { reference: 'Dr Copy - Pat Copy' })]);
    const res = await push([invoice.id]);
    assert.equal(res.body.invoices[0].outcome, 'created', JSON.stringify(res.body));
    assert.equal(replay.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/Invoices')).length, 1);
  });
});
