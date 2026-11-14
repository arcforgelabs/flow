import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createContact, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, issueInvoice } from '../server/core/invoices.js';
import { jobMatchDetail, listReconcile } from '../server/core/job-match.js';
import { observeJob, recordAccountingEvidence, setReady } from '../server/core/ledger.js';
import { followImports, IMPORT_ACTOR } from '../server/integrations/xero/import-history.js';
import { matchXero } from '../server/integrations/xero/links.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, scriptedXero, seedLab } from './support/xero.js';

// The history import (server/integrations/xero/import-history.js): each Xero
// sales invoice a customer saw becomes a Flow invoice of origin 'xero', in
// batches by year, each with an undo. The copy is written directly; nothing
// calls Xero. Synthetic data only.

const XC = '00000000-0000-4000-8000-0000000000c1';
const XC2 = '00000000-0000-4000-8000-0000000000c2';
const xid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (extra = {}) => ({ itemCode: 'CROWN', description: 'Crown', quantity: 1, unitAmount: 250, lineAmountCents: 25000, taxAmountCents: 2500, taxType: 'OUTPUT', ...extra });

describe('Xero import: the history import', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let lab;
  let practice;
  let own;
  const batches = {};
  const org = () => lab.organisation.id;
  const call = (path, { token = lab.ownerToken, method = 'GET', body } = {}) => request(app, `/api/xero/import/${path}${method === 'GET' ? `?organisationId=${org()}` : ''}`,
    { token, method, ...(method === 'GET' ? {} : { body: { organisationId: org(), ...body } }) });
  const query = async (text, values = []) => (await handle.pool.query(text, values)).rows;

  async function copy(n, { number = `INV-${String(n).padStart(4, '0')}`, contact = XC, issuedOn = '2023-05-10', total = 27500, status = 'PAID', lines = [line()] } = {}) {
    const due = status === 'AUTHORISED' ? total : 0;
    await handle.db.execute(sql`insert into xero_invoices (organisation_id, xero_invoice_id, type, invoice_number, xero_contact_id, status, issued_on, due_on,
        subtotal_cents, tax_cents, total_cents, amount_due_cents, amount_paid_cents, lines, record_hash)
      values (${org()}, ${xid(n)}, 'ACCREC', ${number}, ${contact}, ${status}, ${issuedOn}, ${issuedOn},
        ${total - 2500}, 2500, ${total}, ${due}, ${status === 'PAID' ? total : 0}, ${JSON.stringify(lines)}::jsonb, ${`h${n}`})`);
    return xid(n);
  }
  const imported = async (number) => (await query(`select i.*, l.xero_invoice_id, l.batch_id, l.matched_by, l.linked_by from invoices i
    left join xero_invoice_links l on l.invoice_id = i.id where i.organisation_id = $1 and i.number = $2`, [org(), number]))[0];
  const versionsOf = async (invoiceId) => query('select version, issued_by, document from invoice_versions where invoice_id = $1 order by version', [invoiceId]);
  const jobs = () => query('select to_jsonb(b) as row from billing_obligations b where organisation_id = $1 order by id', [org()]);
  const tabOf = async (tab) => (await request(app, `/api/invoicing/invoices?organisationId=${org()}&status=${tab}&limit=200`, { token: lab.ownerToken })).body.invoices.map((i) => i.number).sort();

  before(async () => {
    handle = await freshDatabase();
    const xero = scriptedXero();
    const booted = await bootFlow(handle, { runtime: xero.runtime, log: xero.log });
    app = booted.app;
    lab = await seedLab(handle, booted.clerk);
    practice = await createContact(handle.db, org(), { kind: 'customer', name: 'Example Practice' });
    const crown = await createPriceItem(handle.db, org(), { code: 'CROWN', name: 'Crown', unitAmountCents: 25000 });
    await connectDirectly(handle, xero.runtime, org());
    await handle.db.execute(sql`insert into xero_contacts (organisation_id, xero_contact_id, name, status, is_customer, is_supplier, sales_tracking, synced_at)
      values (${org()}, ${XC}, 'Example Practice', 'ACTIVE', true, false, '[]'::jsonb, now()),
             (${org()}, ${XC2}, 'New Clinic', 'ACTIVE', true, false, '[]'::jsonb, now())`);

    // Flow's own invoice INV-0001, linked to Xero invoice 1: never imported.
    const draft = await createDraftInvoice(handle.db, org(), { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    own = await issueInvoice(handle.db, org(), draft.id, { issuedBy: 'user:test', issueDate: '2023-06-01' });
    await copy(1, { number: own.number, issuedOn: '2023-06-01', status: 'AUTHORISED' });
    await handle.db.execute(sql`insert into xero_invoice_links (organisation_id, xero_invoice_id, invoice_id, matched_by, linked_by) values (${org()}, ${xid(1)}, ${own.id}, 'auto', 'test')`);
    // A second Flow invoice holds INV-0002, a number Xero invoice 12 uses.
    const second = await createDraftInvoice(handle.db, org(), { contactId: practice.id, lines: [{ priceItemId: crown.id }] });
    assert.equal((await issueInvoice(handle.db, org(), second.id, { issuedBy: 'user:test', issueDate: '2026-11-01' })).number, 'INV-0002');

    // 2023: two paid, one awaiting payment, one void.
    await copy(4);
    await copy(5, { issuedOn: '2023-03-01' });
    await copy(10, { number: 'INV-0120', issuedOn: '2023-08-05', status: 'AUTHORISED' });
    await copy(11, { issuedOn: '2023-09-01', status: 'VOIDED' });
    // 2024: one with an odd line for a contact Flow does not have, a void, and
    // three the import cannot take: a taken number, no contact, no number.
    await copy(6, { contact: XC2, issuedOn: '2024-06-01', lines: [line({ quantity: 0 })] });
    await copy(7, { issuedOn: '2024-06-02', status: 'VOIDED' });
    await copy(12, { number: 'INV-0002', issuedOn: '2024-07-01' });
    await copy(13, { contact: null, issuedOn: '2024-07-02' });
    await copy(14, { number: null, issuedOn: '2024-07-03' });
    // No customer saw these: a Xero draft and a removed draft.
    await copy(8, { issuedOn: '2023-11-01', status: 'DRAFT' });
    await copy(9, { issuedOn: '2023-11-02', status: 'DELETED' });
    // A job the matcher tied to Xero invoice 4 by its accounting reference.
    const job = await observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-A', caseRef: 'JOB-A', contactId: practice.id, shippedOn: '2023-05-10', jobDate: '2023-05-10', lines: [{ itemCode: 'CROWN' }] });
    await recordAccountingEvidence(handle.db, org(), job.id, { state: 'paid', accountingRef: xid(4), matchedBy: 'accounting_ref', actor: 'test' });
  });
  after(async () => handle?.close());

  test('it runs only with the switch on, on a complete and fresh copy', async () => {
    const off = await call('history', { method: 'POST', body: { year: 2023 } });
    assert.deepEqual([off.status, off.body.code], [409, 'import_off']);
    await call('settings', { method: 'PUT', body: { makeUnmatched: true } });
    // The switch alone imports nothing: the match step makes no invoice.
    assert.deepEqual(await matchXero(handle.db, org()), { linked: 0, made: 0, failed: 0 });
    const noCopy = await call('history', { method: 'POST', body: { year: 2023 } });
    assert.deepEqual([noCopy.status, noCopy.body.code], [409, 'copy_not_ready']);
    assert.equal((await query('select count(*)::int as n from xero_import_batches'))[0].n, 0);
    await handle.db.execute(sql`insert into xero_mirror_cursors (organisation_id, resource, passes, last_pass_finished_at)
      values (${org()}, 'invoices', 1, now()), (${org()}, 'credit_notes', 1, now())`);
    const staff = await call('history', { method: 'POST', token: lab.staffToken, body: { year: 2023 } });
    assert.equal(staff.status, 403, 'a batch is for an owner or admin');
    const bad = await call('history', { method: 'POST', body: { year: 23 } });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
  });

  test('a batch imports one year: the Xero number, totals and document, and no job changes', async () => {
    const jobsBefore = await jobs();
    const res = await call('history', { method: 'POST', body: { year: 2023 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    batches[2023] = res.body.batch;
    assert.deepEqual(res.body.batch.counts, { imported: 4, void: 1, oddLines: 0, contactsMade: 0, blocked: { noNumber: 0, numberTaken: 0, noContact: 0 } });
    assert.equal(res.body.batch.year, 2023);
    assert.ok(res.body.batch.finishedAt);

    const paid = await imported('INV-0004');
    assert.deepEqual([paid.origin, paid.status, paid.issued_version, paid.contact_id, paid.total_cents, paid.tax_cents, paid.subtotal_cents],
      ['xero', 'issued', 1, practice.id, 27500, 2500, 25000]);
    assert.deepEqual([paid.xero_invoice_id, paid.batch_id, paid.matched_by], [xid(4), batches[2023].id, 'made']);
    const [version] = await versionsOf(paid.id);
    assert.equal(version.document.number, 'INV-0004');
    assert.deepEqual(version.document.source, { system: 'xero', invoiceId: xid(4), contactId: XC });
    assert.deepEqual(version.document.lines.map((l) => [l.itemCode, l.quantity, l.unitAmountCents, l.lineAmountCents, l.taxCents]), [['CROWN', 1, 25000, 25000, 2500]]);
    assert.equal((await imported('INV-0011')).status, 'void', 'a Xero void is a void: a customer saw it');

    // Only that year, and never a draft, a removed draft or Flow's own invoice.
    assert.deepEqual((await query(`select number from invoices where organisation_id = $1 and origin = 'xero' order by number`, [org()])).map((r) => r.number),
      ['INV-0004', 'INV-0005', 'INV-0011', 'INV-0120']);
    assert.equal((await imported(own.number)).origin, 'flow');
    // Each tab follows the copy of Xero.
    assert.deepEqual(await tabOf('paid'), ['INV-0004', 'INV-0005']);
    assert.ok((await tabOf('awaiting_payment')).includes('INV-0120'));
    assert.deepEqual(await tabOf('void'), ['INV-0011']);
    // Flow's next number is above the highest Xero number.
    assert.equal((await query('select next_invoice_number as n from organisations where id = $1', [org()]))[0].n, 121);
    assert.deepEqual(await jobs(), jobsBefore, 'the job stays tied by its accounting reference; no job row changed');

    const again = await call('history', { method: 'POST', body: { year: 2023 } });
    assert.deepEqual([again.status, again.body.code], [409, 'batch_exists']);
  });

  test('the Reconcile page never offers an imported invoice as a job\'s own', async () => {
    const job = await observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-B', caseRef: 'JOB-B', contactId: practice.id, shippedOn: '2023-05-11', jobDate: '2023-05-11', lines: [{ itemCode: 'CROWN' }] });
    await setReady(handle.db, org(), job.id, { actor: 'person:test' });
    const page = await listReconcile(handle.db, org());
    assert.deepEqual(page.invoices.map((i) => i.number).sort(), ['INV-0001', 'INV-0002'], 'only invoices Flow made');
    // Same client and total as the imported INV-0004, one day apart.
    assert.equal(page.jobs.find((j) => j.id === job.id).possible, 2, 'the two invoices Flow made');
    assert.ok((await jobMatchDetail(handle.db, org(), job.id)).invoices.every((i) => i.number === 'INV-0001'));
    assert.deepEqual((await jobMatchDetail(handle.db, org(), job.id, { q: 'INV-0004' })).invoices, []);
  });

  test('what the import cannot take is counted, not refused; a contact Flow does not have is made', async () => {
    const res = await call('history', { method: 'POST', body: { year: 2024 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    batches[2024] = res.body.batch;
    assert.deepEqual(res.body.batch.counts, { imported: 2, void: 1, oddLines: 1, contactsMade: 1, blocked: { noNumber: 1, numberTaken: 1, noContact: 1 } });
    const odd = await imported('INV-0006');
    const [clinic] = await query(`select id, kind from contacts where organisation_id = $1 and name = 'New Clinic'`, [org()]);
    assert.deepEqual([odd.contact_id, clinic.kind], [clinic.id, 'customer']);
    assert.equal((await versionsOf(odd.id))[0].document.lines[0].quantity, 0, 'the line stays as Xero gave it');
    assert.equal((await imported('INV-0002')).origin, 'flow', 'the Flow invoice keeps its number');

    const list = await call('history', { token: lab.staffToken });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.batches.map((b) => [b.year, b.invoices]), [[2024, 2], [2023, 4]]);
  });

  test('an imported invoice follows its Xero invoice, and an imported year takes new invoices', async () => {
    assert.deepEqual(await followImports(handle.db, org()), { changed: 0, voided: 0, removed: 0, imported: 0, failed: 0 }, 'nothing moved');
    // Xero changed the total of 4, voided 5 and made 15 in 2023, and 16 in a
    // year no batch covers.
    await handle.db.execute(sql`update xero_invoices set subtotal_cents = 30000, tax_cents = 3000, total_cents = 33000, record_hash = 'h4b',
      lines = ${JSON.stringify([line({ unitAmount: 300, lineAmountCents: 30000, taxAmountCents: 3000 })])}::jsonb where xero_invoice_id = ${xid(4)}`);
    await handle.db.execute(sql`update xero_invoices set status = 'VOIDED', record_hash = 'h5b' where xero_invoice_id = ${xid(5)}`);
    await copy(15, { issuedOn: '2023-12-01' });
    await copy(16, { issuedOn: '2022-12-01' });
    assert.deepEqual(await followImports(handle.db, org()), { changed: 1, voided: 1, removed: 0, imported: 1, failed: 0 });

    const changed = await imported('INV-0004');
    assert.deepEqual([changed.total_cents, changed.issued_version, changed.status], [33000, 2, 'issued']);
    const versions = await versionsOf(changed.id);
    assert.deepEqual(versions.map((v) => [v.version, v.issued_by, v.document.totalCents]), [[1, `person:${lab.owner.id}`, 27500], [2, IMPORT_ACTOR, 33000]], 'the earlier version stays');
    const voided = await imported('INV-0005');
    assert.deepEqual([voided.status, voided.issued_version], ['void', 1], 'a void adds no version');
    assert.equal((await imported('INV-0015')).batch_id, batches[2023].id);
    assert.equal(await imported('INV-0016'), undefined);
    assert.deepEqual(await followImports(handle.db, org()), { changed: 0, voided: 0, removed: 0, imported: 0, failed: 0 }, 'a second run finds nothing');

    // Xero gave 11 a number a Flow invoice holds: Flow cannot follow it, and
    // goes on with the rest.
    await handle.db.execute(sql`update xero_invoices set invoice_number = 'INV-0002', record_hash = 'h11b' where xero_invoice_id = ${xid(11)}`);
    await handle.db.execute(sql`update xero_invoices set invoice_number = 'INV-0004A', record_hash = 'h4c' where xero_invoice_id = ${xid(4)}`);
    assert.deepEqual(await followImports(handle.db, org()), { changed: 1, voided: 0, removed: 0, imported: 0, failed: 0 }, 'a void invoice is final: its number stays');
    assert.equal((await imported('INV-0004A')).issued_version, 3);
    await handle.db.execute(sql`update xero_invoices set invoice_number = 'INV-0002', record_hash = 'h4d' where xero_invoice_id = ${xid(4)}`);
    assert.deepEqual(await followImports(handle.db, org()), { changed: 0, voided: 0, removed: 0, imported: 0, failed: 1 });
    assert.equal((await imported('INV-0004A')).issued_version, 3, 'nothing of it changed');
    await handle.db.execute(sql`update xero_invoices set invoice_number = 'INV-0004', record_hash = 'h4e' where xero_invoice_id = ${xid(4)}`);
    await handle.db.execute(sql`update xero_invoices set invoice_number = 'INV-0011', record_hash = 'h11c' where xero_invoice_id = ${xid(11)}`);
    assert.deepEqual(await followImports(handle.db, org()), { changed: 1, voided: 0, removed: 0, imported: 0, failed: 0 });

    // With the switch off, an imported invoice still follows; no new one comes.
    await call('settings', { method: 'PUT', body: { makeUnmatched: false } });
    await copy(17, { issuedOn: '2023-12-02' });
    await handle.db.execute(sql`update xero_invoices set status = 'VOIDED', record_hash = 'h10b' where xero_invoice_id = ${xid(10)}`);
    assert.deepEqual(await followImports(handle.db, org()), { changed: 0, voided: 1, removed: 0, imported: 0, failed: 0 });
    await call('settings', { method: 'PUT', body: { makeUnmatched: true } });
  });

  test('release removes what the batch imported, keeps the pair record, and changes no job', async () => {
    const jobsBefore = await jobs();
    const staff = await call(`history/${batches[2023].id}/release`, { method: 'POST', token: lab.staffToken });
    assert.equal(staff.status, 403);
    const res = await call(`history/${batches[2023].id}/release`, { method: 'POST' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // 4, 5, 10, 11 from the batch, and 15, which the year took later.
    assert.equal(res.body.batch.removed, 5);
    assert.ok(res.body.batch.releasedAt);
    assert.deepEqual((await query(`select number from invoices where organisation_id = $1 and origin = 'xero' order by number`, [org()])).map((r) => r.number),
      ['INV-0006', 'INV-0007'], 'the 2024 batch stays');
    assert.equal((await query('select count(*)::int as n from invoice_versions v where not exists (select 1 from invoices i where i.id = v.invoice_id)'))[0].n, 0);
    assert.equal((await query('select count(*)::int as n from xero_invoice_links where batch_id = $1', [batches[2023].id]))[0].n, 0);
    const history = await query(`select xero_invoice_id, invoice_number, reason, removed_by from xero_invoice_link_history where organisation_id = $1 order by invoice_number`, [org()]);
    assert.deepEqual(history.map((h) => [h.xero_invoice_id, h.invoice_number, h.reason]),
      [[xid(4), 'INV-0004', 'import_batch_released'], [xid(5), 'INV-0005', 'import_batch_released'], [xid(11), 'INV-0011', 'import_batch_released'],
        [xid(15), 'INV-0015', 'import_batch_released'], [xid(10), 'INV-0120', 'import_batch_released']]);
    assert.ok(history.every((h) => h.removed_by === `person:${lab.owner.id}`));
    assert.equal((await imported(own.number)).status, 'issued', 'Flow\'s own invoice is not touched');
    assert.equal((await query(`select count(*)::int as n from contacts where organisation_id = $1 and name = 'New Clinic'`, [org()]))[0].n, 1, 'a contact a batch made stays');
    assert.deepEqual(await jobs(), jobsBefore);

    const twice = await call(`history/${batches[2023].id}/release`, { method: 'POST' });
    assert.deepEqual([twice.status, twice.body.code], [409, 'batch_released']);
    // A released year takes no new invoice, and it can be imported again.
    assert.deepEqual(await followImports(handle.db, org()), { changed: 0, voided: 0, removed: 0, imported: 0, failed: 0 });
    const again = await call('history', { method: 'POST', body: { year: 2023 } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.batch.counts.imported, 6, '4, 5, 10, 11, 15 and 17');
    assert.equal((await imported('INV-0005')).status, 'void');
  });

  test('a batch for every year takes the rest, and the Invoices list stays fast with the full history', async () => {
    // 3,000 more Xero invoices, over five years.
    await handle.db.execute(sql`insert into xero_invoices (organisation_id, xero_invoice_id, type, invoice_number, xero_contact_id, status, issued_on,
        subtotal_cents, tax_cents, total_cents, amount_due_cents, amount_paid_cents, lines, record_hash)
      select ${org()}, ('00000000-0000-4000-8000-' || lpad((100000 + n)::text, 12, '0'))::uuid, 'ACCREC', 'INV-' || (5000 + n), ${XC},
        case when n % 20 = 0 then 'AUTHORISED' when n % 97 = 0 then 'VOIDED' else 'PAID' end, date '2019-01-01' + (n % 1800),
        25000, 2500, 27500, case when n % 20 = 0 then 27500 else 0 end, case when n % 20 = 0 or n % 97 = 0 then 0 else 27500 end,
        ${JSON.stringify([line()])}::jsonb, 'bulk'
      from generate_series(1, 3000) n`);
    const started = Date.now();
    const res = await call('history', { method: 'POST', body: {} });
    const importMs = Date.now() - started;
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // The 3,000, and 16, which no year batch covered.
    assert.equal(res.body.batch.counts.imported, 3001);
    assert.equal(res.body.batch.year, null);

    await tabOf('paid');
    const listStarted = Date.now();
    const list = await request(app, `/api/invoicing/invoices?organisationId=${org()}&status=paid&limit=50`, { token: lab.ownerToken });
    const listMs = Date.now() - listStarted;
    assert.equal(list.status, 200);
    assert.equal(list.body.invoices.length, 50);
    assert.ok(list.body.counts.paid > 2800, JSON.stringify(list.body.counts));
    console.log(`# history import: 3,001 invoices in ${importMs} ms; Paid tab of ${list.body.counts.paid} in ${listMs} ms`);
    assert.ok(listMs < 3000, `the Paid tab took ${listMs} ms`);
  });
});
