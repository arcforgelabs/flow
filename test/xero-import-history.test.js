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
import { bootFlow, connectDirectly, OWNER, scriptedXero, seedLab } from './support/xero.js';

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
  let xero;
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
  const imported = async (number) => (await query(`select i.*, l.xero_invoice_id, l.batch_id, l.matched_by, l.linked_by, l.copy_hash from invoices i
    left join xero_invoice_links l on l.invoice_id = i.id where i.organisation_id = $1 and i.number = $2`, [org(), number]))[0];
  const versionsOf = async (invoiceId) => query('select version, issued_by, document from invoice_versions where invoice_id = $1 order by version', [invoiceId]);
  const jobs = () => query('select to_jsonb(b) as row from billing_obligations b where organisation_id = $1 order by id', [org()]);
  const tabOf = async (tab) => (await request(app, `/api/invoicing/invoices?organisationId=${org()}&status=${tab}&limit=200`, { token: lab.ownerToken })).body.invoices.map((i) => i.number).sort();

  before(async () => {
    handle = await freshDatabase();
    xero = scriptedXero();
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

  test('the Invoices page shows an imported invoice: its Xero lines, its jobs, and its place by date', async () => {
    const paid = await imported('INV-0004');
    const res = await request(app, `/api/invoicing/invoices/${paid.id}?organisationId=${org()}`, { token: lab.ownerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const invoice = res.body.invoice;
    assert.deepEqual([invoice.imported, invoice.tab, invoice.contact.name], [true, 'paid', 'Example Practice']);
    assert.deepEqual(invoice.lines.map((l) => [l.description, l.quantity, l.unitAmountCents, l.taxCode, l.lineAmountCents]), [['Crown', 1, 25000, 'GST', 25000]]);
    // The job stays tied by its accounting reference, and the page shows it.
    assert.deepEqual(invoice.tiedJobs.map((j) => j.sourceJobRef), ['JOB-A']);
    assert.equal(invoice.job.sourceJobRef, 'JOB-A');
    assert.equal(invoice.canOverride, false);
    const pdf = await request(app, `/api/invoicing/invoices/${paid.id}/pdf?organisationId=${org()}`, { token: lab.ownerToken });
    assert.equal(pdf.status, 200);

    const list = await request(app, `/api/invoicing/invoices?organisationId=${org()}&limit=200`, { token: lab.ownerToken });
    const rows = list.body.invoices;
    assert.deepEqual(rows.filter((i) => i.imported).map((i) => i.number).sort(), ['INV-0004', 'INV-0005', 'INV-0011', 'INV-0120']);
    assert.equal(rows.find((i) => i.number === 'INV-0004').job.sourceJobRef, 'JOB-A');
    assert.equal(rows.find((i) => i.number === own.number).imported, false);
    // Newest first. An invoice Flow made keeps its place by the time Flow
    // made it (INV-0001 has an issue date of June 2023). An imported one is
    // in its place by its own date, not by the day Flow copied it.
    assert.deepEqual(rows.map((i) => i.number), ['INV-0002', 'INV-0001', 'INV-0011', 'INV-0120', 'INV-0004', 'INV-0005']);
  });

  test('every imported invoice has a job: the tied one, or one built from the invoice', async () => {
    const list = (query = '') => request(app, `/api/invoicing/jobs?organisationId=${org()}${query}`, { token: lab.ownerToken });
    // A built job is past work: it is listed with the history only.
    const plain = await list();
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.ok(plain.body.jobs.every((j) => !j.built));
    assert.equal(plain.body.counts.built, undefined);

    const all = await list('&history=include');
    const built = all.body.jobs.filter((j) => j.built);
    // INV-0004 has its job from the work system (JOB-A), so no job is built.
    assert.deepEqual(built.map((j) => j.invoiceNumber).sort(), ['INV-0005', 'INV-0011', 'INV-0120']);
    assert.equal(all.body.counts.built, 3);
    assert.equal(all.body.jobs.filter((j) => j.accountingRef === xid(4)).map((j) => j.sourceJobRef).join(), 'JOB-A');
    const paid = built.find((j) => j.invoiceNumber === 'INV-0005');
    assert.deepEqual([paid.id, paid.sourceSystem, paid.sourceJobRef, paid.accountingRef, paid.invoiceId], [xid(5), 'xero', xid(5), xid(5), null]);
    assert.deepEqual([paid.view, paid.accountingState, paid.invoiceTab, paid.contactName, paid.jobDate, paid.totalCents], ['paid', 'paid', 'paid', 'Example Practice', '2023-03-01', 27500]);
    assert.equal(paid.importedInvoiceId, (await imported('INV-0005')).id);
    assert.deepEqual(paid.lines.map((l) => [l.itemCode, l.lineAmountCents]), [['CROWN', 25000]]);
    assert.deepEqual(built.map((j) => [j.invoiceNumber, j.view, j.accountingState]).sort(),
      [['INV-0005', 'paid', 'paid'], ['INV-0011', 'held', 'voided'], ['INV-0120', 'invoiced', 'authorised']]);

    const only = await list('&built=only&view=paid');
    assert.deepEqual(only.body.jobs.map((j) => j.invoiceNumber), ['INV-0005']);
    assert.deepEqual((await list('&built=only&limit=1&offset=1')).body.jobs.length, 1);
    // It is read only: a job route that writes does not know it.
    const hold = await request(app, `/api/invoicing/jobs/${xid(5)}/hold`, { token: lab.ownerToken, method: 'POST', body: { organisationId: org(), state: 'none', reason: 'test' } });
    assert.equal(hold.status, 404, JSON.stringify(hold.body));

    // A job from the work system takes the reference: the built job is gone.
    const job = await observeJob(handle.db, org(), { sourceSystem: 'worksystem', sourceJobRef: 'JOB-T', caseRef: 'JOB-T', contactId: practice.id, shippedOn: '2023-03-01', jobDate: '2023-03-01', lines: [{ itemCode: 'CROWN' }] });
    await recordAccountingEvidence(handle.db, org(), job.id, { state: 'paid', accountingRef: xid(5), matchedBy: 'accounting_ref', actor: 'test' });
    const after = await list('&history=include&limit=500');
    assert.ok(!after.body.jobs.some((j) => j.built && j.invoiceNumber === 'INV-0005'));
    assert.equal(after.body.jobs.filter((j) => j.accountingRef === xid(5)).length, 1, 'one job for the invoice, never two');
  });

  test('with the Xero adapter off, an imported invoice keeps its jobs', async () => {
    // The same database, started again with the adapter off (FLOW_INTEGRATIONS empty).
    const off = await bootFlow(handle, { on: false, runtime: xero.runtime, log: xero.log });
    const token = off.clerk.signIn(off.clerk.addUser({ email: OWNER, google: true, password: false }));
    const get = (path) => request(off.app, `/api/invoicing/${path}${path.includes('?') ? '&' : '?'}organisationId=${org()}`, { token });
    assert.equal((await request(off.app, `/api/xero/import/history?organisationId=${org()}`, { token })).status, 503, 'the adapter is off');

    // The invoice page and the list still name the job tied to the invoice.
    const paid = await imported('INV-0004');
    const page = await get(`invoices/${paid.id}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.deepEqual([page.body.invoice.imported, page.body.invoice.tiedJobs.map((j) => j.sourceJobRef), page.body.invoice.job.sourceJobRef], [true, ['JOB-A'], 'JOB-A']);
    assert.deepEqual(page.body.invoice.lines.map((l) => [l.description, l.lineAmountCents]), [['Crown', 25000]]);
    const rows = (await get('invoices?limit=200')).body.invoices;
    assert.equal(rows.find((i) => i.number === 'INV-0004').job.sourceJobRef, 'JOB-A');

    // The built jobs stay. Flow cannot read "paid" without the adapter, so an
    // invoice that is not void reads as invoiced.
    const all = await get('jobs?history=include&limit=500');
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const built = all.body.jobs.filter((j) => j.built);
    assert.deepEqual(built.map((j) => [j.invoiceNumber, j.view, j.accountingState, j.sourceSystem, j.accountingRef]).sort(),
      [['INV-0011', 'held', 'voided', 'xero', xid(11)], ['INV-0120', 'invoiced', 'authorised', 'xero', xid(10)]]);
    assert.equal(all.body.counts.built, 2);
    assert.deepEqual(built.find((j) => j.invoiceNumber === 'INV-0120').reasons, ['invoice INV-0120 is authorised in the accounting system', 'no job from a work system is tied to it']);
    // One job for each invoice a work system's job holds, never a built one too.
    assert.deepEqual([xid(4), xid(5)].map((ref) => all.body.jobs.filter((j) => j.accountingRef === ref).map((j) => j.sourceJobRef)), [['JOB-A'], ['JOB-T']]);
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

  test('a change Flow cannot follow yet waits, and follows after a person links the contact', async () => {
    const XC3 = '00000000-0000-4000-8000-0000000000c3';
    await handle.db.execute(sql`insert into xero_contacts (organisation_id, xero_contact_id, name, status, is_customer, is_supplier, sales_tracking, synced_at)
      values (${org()}, ${XC3}, 'Twin Dental', 'ACTIVE', true, false, '[]'::jsonb, now())`);
    // Two Flow customers hold the name: one by its name, one by an earlier name.
    const twin = await createContact(handle.db, org(), { kind: 'customer', name: 'Twin Dental' });
    const north = await createContact(handle.db, org(), { kind: 'customer', name: 'Twin Dental North' });
    await handle.db.execute(sql`update contacts set aliases = '["Twin Dental"]'::jsonb where id = ${north.id}`);
    const before = await imported('INV-0006');
    // Xero moved 6 to that contact.
    await handle.db.execute(sql`update xero_invoices set xero_contact_id = ${XC3}, record_hash = 'h6b' where xero_invoice_id = ${xid(6)}`);
    for (const read of ['the first read', 'the next read']) {
      assert.deepEqual(await followImports(handle.db, org()), { changed: 0, voided: 0, removed: 0, imported: 0, failed: 1 }, read);
      const waits = await imported('INV-0006');
      assert.deepEqual([waits.contact_id, waits.issued_version, waits.copy_hash], [before.contact_id, 1, 'h6'], `${read} changes nothing of it, and it stays to do`);
    }
    // A person says which customer the Xero contact is.
    await handle.db.execute(sql`insert into external_links (organisation_id, entity, flow_id, system, external_id, matched_by, state)
      values (${org()}, 'contact', ${twin.id}, 'xero', ${XC3}, 'person', 'active')`);
    assert.deepEqual(await followImports(handle.db, org()), { changed: 1, voided: 0, removed: 0, imported: 0, failed: 0 });
    const followed = await imported('INV-0006');
    assert.deepEqual([followed.contact_id, followed.issued_version, followed.copy_hash], [twin.id, 2, 'h6b']);
    assert.equal((await versionsOf(followed.id))[1].document.contact.name, 'Twin Dental');

    // A void in Xero is final, so it is followed with or without a contact.
    await handle.db.execute(sql`delete from external_links where organisation_id = ${org()} and external_id = ${XC3}`);
    await handle.db.execute(sql`update xero_invoices set xero_contact_id = ${XC2}, status = 'VOIDED', record_hash = 'h6c' where xero_invoice_id = ${xid(6)}`);
    await handle.db.execute(sql`update contacts set aliases = '["New Clinic"]'::jsonb where id = ${north.id}`);
    assert.deepEqual(await followImports(handle.db, org()), { changed: 0, voided: 1, removed: 0, imported: 0, failed: 0 });
    const voided = await imported('INV-0006');
    assert.deepEqual([voided.status, voided.contact_id, voided.issued_version, voided.copy_hash], ['void', twin.id, 2, 'h6c']);
  });

  test('two requests for one year at the same time make one batch', async () => {
    const both = await Promise.all([1, 2].map(() => call('history', { method: 'POST', body: { year: 2018 } })));
    assert.deepEqual(both.map((res) => res.status).sort(), [200, 409], JSON.stringify(both.map((res) => res.body)));
    assert.equal(both.find((res) => res.status === 409).body.code, 'batch_exists');
    const live = () => query('select id from xero_import_batches where organisation_id = $1 and year = 2018 and released_at is null', [org()]);
    assert.equal((await live()).length, 1);
    // The database keeps the rule, for a year and for every year.
    await assert.rejects(query("insert into xero_import_batches (organisation_id, year, started_by) values ($1, 2018, 'test')", [org()]), { code: '23505' });
    await query("insert into xero_import_batches (organisation_id, started_by) values ($1, 'test')", [org()]);
    await assert.rejects(query("insert into xero_import_batches (organisation_id, started_by) values ($1, 'test')", [org()]), { code: '23505' });
    await query('delete from xero_import_batches where organisation_id = $1 and year is null', [org()]);
    // A released batch does not hold the year.
    const batch = both.find((res) => res.status === 200).body.batch;
    assert.equal((await call(`history/${batch.id}/release`, { method: 'POST' })).status, 200);
    await query("insert into xero_import_batches (organisation_id, year, started_by, released_by, released_at) values ($1, 2018, 'test', 'test', now())", [org()]);
    assert.equal((await live()).length, 0);
  });

  test('a release and a read of Xero at the same time leave no invoice in a released batch', async () => {
    // Statements of this database that wait for a lock.
    const waiting = async (count) => {
      for (let tries = 0; tries < 200; tries += 1) {
        const [{ n }] = await query('select count(*)::int as n from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())');
        if (n >= count) return;
        await new Promise((done) => { setTimeout(done, 25); });
      }
      assert.fail(`${count} statements did not wait for a lock`);
    };
    let n = 30;
    for (const [year, first] of [[2020, 'the read'], [2021, 'the release']]) {
      const had = await copy(n += 1, { issuedOn: `${year}-02-01` });
      const started = await call('history', { method: 'POST', body: { year } });
      assert.equal(started.body.batch?.counts.imported, 1, JSON.stringify(started.body));
      const batch = started.body.batch;
      // Xero made one more in that year since.
      const since = await copy(n += 1, { issuedOn: `${year}-03-01` });
      const follow = () => followImports(handle.db, org());
      const release = () => call(`history/${batch.id}/release`, { method: 'POST' });
      // Both stop where they write a link, until this transaction ends.
      const hold = await handle.pool.connect();
      let results;
      try {
        await hold.query('begin');
        await hold.query('lock table xero_invoice_links in exclusive mode');
        const one = (first === 'the read' ? follow : release)();
        await waiting(1);
        const two = (first === 'the read' ? release : follow)();
        await waiting(2);
        await hold.query('commit');
        results = await Promise.all([one, two]);
      } finally {
        hold.release();
      }
      const released = results.find((r) => r.status);
      assert.equal(released.status, 200, JSON.stringify(released.body));
      assert.equal(released.body.batch.removed, first === 'the read' ? 2 : 1, `${first} went first`);
      assert.deepEqual(await query('select xero_invoice_id from xero_invoice_links where organisation_id = $1 and (batch_id = $2 or xero_invoice_id = any($3))', [org(), batch.id, [had, since]]), [],
        `${first} went first: the released batch holds no invoice`);
      assert.deepEqual(await query(`select number from invoices where organisation_id = $1 and origin = 'xero' and issue_date between $2 and $3`, [org(), `${year}-01-01`, `${year}-12-31`]), []);
      await query('delete from xero_invoices where organisation_id = $1 and xero_invoice_id = any($2)', [org(), [had, since]]);
    }
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
