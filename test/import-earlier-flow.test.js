import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listPriceItems } from '../server/core/directory.js';
import { applyImport, planImport, summarisePlan, toCents } from '../server/import/earlier-flow.js';
import { freshDatabase, skipWithoutDatabase, testDatabaseUrl } from './support/db.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../server/import-earlier-flow.js', import.meta.url));

// Synthetic data only (CONTRIBUTING.md). These rows have the shape of the
// earlier codebase's copy of the accounting system.
const contact = (id, name, raw, extra = {}) => ({
  contact_id: id, name, email_address: `${id}@example.test`, status: 'ACTIVE', raw_json: JSON.stringify(raw), ...extra,
});
const item = (code, name, sales, extra = {}) => ({
  item_code: code, name, description: null, sales_details_json: sales === null ? null : JSON.stringify(sales), is_sold: 1, ...extra,
});

const SOURCE = {
  contacts: [
    contact('c1', 'Example Practice', { IsCustomer: true }),
    contact('c2', 'Example Supplies', { IsSupplier: true }),
    contact('c3', 'Both Ways Clinic', { IsCustomer: true, IsSupplier: true }),
    contact('c4', 'New Practice', {}),
    contact('c5', 'Old Practice', { IsCustomer: true }, { status: 'ARCHIVED' }),
    contact('c6', '  ', { IsCustomer: true }),
    contact('c7', 'Example Practice', { IsCustomer: true }),
    contact('c8', 'Camel Supplies', { isSupplier: true }),
  ],
  items: [
    item('CRN', 'Crown', { UnitPrice: 220, TaxType: 'OUTPUT' }),
    item('FRT', 'Freight', { UnitPrice: '15.505', TaxType: 'EXEMPTOUTPUT' }),
    item('RPR', 'Repair', { UnitPrice: 40.1 }),
    item('POL', 'Polish', { unitPrice: '12.5', taxType: 'OUTPUT' }),
    item('BUY', 'Bought in', { UnitPrice: 5, TaxType: 'INPUT' }, { is_sold: 0 }),
    item('NOP', 'No price', {}),
  ],
  invoices: [
    { invoice_number: 'INV-2440', type: 'ACCREC' },
    { invoice_number: 'INV-0999', type: 'ACCREC' },
    { invoice_number: 'CN-9000', type: 'ACCREC' },
    { invoice_number: 'BILL-99999', type: 'ACCPAY' },
  ],
};

describe('import from the earlier Flow codebase: plan', () => {
  test('amounts become whole cents, half away from zero, without float drift', () => {
    assert.deepEqual(['220', '15.505', '40.1', '0.004', '-1.005', 'x', ''].map(toCents), [22000, 1551, 4010, 0, -101, null, null]);
  });

  test('contacts keep their kind; archived, nameless and repeated ones stay behind', () => {
    const plan = planImport(SOURCE);
    assert.deepEqual(plan.contacts.map((c) => [c.kind, c.name]), [
      ['customer', 'Example Practice'],
      ['supplier', 'Example Supplies'],
      ['customer', 'Both Ways Clinic'],
      ['supplier', 'Both Ways Clinic'],
      ['customer', 'New Practice'],
      ['supplier', 'Camel Supplies'],
    ]);
    assert.deepEqual(plan.skipped.filter((s) => s.table === 'contacts').map((s) => [s.key, s.reason]), [
      ['c5', 'status_archived'], ['c6', 'no_name'], ['c7', 'duplicate_customer_name'],
    ]);
  });

  test('sold items with a price become price items with their tax code, in either key casing', () => {
    const plan = planImport(SOURCE);
    assert.deepEqual(plan.priceItems.map((p) => [p.code, p.unitAmountCents, p.taxCode]), [
      ['CRN', 22000, 'GST'], ['FRT', 1551, 'GST_FREE'], ['RPR', 4010, 'GST'], ['POL', 1250, 'GST'],
    ]);
    assert.deepEqual(plan.skipped.filter((s) => s.table === 'price_items').map((s) => [s.key, s.reason]), [
      ['BUY', 'not_sold'], ['NOP', 'no_sales_price'],
    ]);
    assert.deepEqual(plan.defaulted, [{ table: 'price_items', key: 'RPR', reason: 'no_tax_type_used_gst' }]);
  });

  test('numbering continues after the highest sales invoice of the main prefix', () => {
    assert.deepEqual(planImport(SOURCE).numbering, { invoicePrefix: 'INV-', nextInvoiceNumber: 2441, basis: 'highest_sales_invoice' });
    assert.deepEqual(planImport({}).numbering, { invoicePrefix: 'INV-', nextInvoiceNumber: 1, basis: 'no_sales_invoices' });
  });

  test('the summary carries counts and reasons, never names or amounts', () => {
    const text = JSON.stringify(summarisePlan(planImport(SOURCE)));
    for (const secret of ['Example Practice', 'example.test', '22000', 'c1']) assert.ok(!text.includes(secret), secret);
  });
});

describe('import from the earlier Flow codebase: write', { skip: skipWithoutDatabase }, () => {
  let handle;

  before(async () => {
    handle = await freshDatabase();
  });

  after(async () => handle?.close());

  test('writes one organisation with its contacts, price list and numbering, then refuses a second run', async () => {
    const plan = planImport(SOURCE);
    const result = await applyImport(handle.db, plan, { organisationName: 'Example Lab' });
    assert.deepEqual(result.counts, { contacts: 6, priceItems: 4 });
    const { rows: [organisation] } = await handle.pool.query('select invoice_prefix, next_invoice_number from organisations');
    assert.deepEqual(organisation, { invoice_prefix: 'INV-', next_invoice_number: 2441 });
    assert.deepEqual((await listPriceItems(handle.db, result.organisationId)).map((p) => p.code), ['CRN', 'FRT', 'POL', 'RPR']);
    await assert.rejects(applyImport(handle.db, plan, { organisationName: 'Example Lab' }), /already has an organisation/);
  });

  test('the command reads the source read-only and moves the records', async () => {
    await handle.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS flow CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await handle.pool.query(`
      DROP SCHEMA IF EXISTS earlier CASCADE;
      CREATE SCHEMA earlier;
      CREATE TABLE earlier.xero_catalog_contacts (contact_id TEXT PRIMARY KEY, name TEXT NOT NULL, email_address TEXT, status TEXT, raw_json TEXT NOT NULL);
      CREATE TABLE earlier.xero_catalog_items (item_code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, sales_details_json TEXT, is_sold INTEGER NOT NULL);
      CREATE TABLE earlier.xero_catalog_invoices (invoice_number TEXT, type TEXT);
      INSERT INTO earlier.xero_catalog_contacts VALUES ('c1', 'Example Practice', NULL, 'ACTIVE', '{"IsCustomer":true}');
      INSERT INTO earlier.xero_catalog_items VALUES ('CRN', 'Crown', NULL, '{"UnitPrice":220,"TaxType":"OUTPUT"}', 1);
      INSERT INTO earlier.xero_catalog_invoices VALUES ('INV-0041', 'ACCREC');
    `);
    const source = new URL(testDatabaseUrl);
    source.searchParams.set('options', '-c search_path=earlier');
    const env = { ...process.env, EARLIER_FLOW_DATABASE_URL: source.toString(), DATABASE_URL: testDatabaseUrl };

    const dry = await run(process.execPath, [cli, '--dry-run'], { env });
    assert.match(dry.stdout, /"priceItems": 1/);
    const { rows: [{ exists }] } = await handle.pool.query("select to_regclass('organisations') is not null as exists");
    assert.equal(exists, false, 'a dry run writes nothing');

    const real = await run(process.execPath, [cli, '--organisation', 'Example Lab'], { env });
    assert.match(real.stdout, /"imported"/);
    const { rows: [counts] } = await handle.pool.query(
      'select (select count(*)::int from contacts) as contacts, (select next_invoice_number from organisations) as next',
    );
    assert.deepEqual(counts, { contacts: 1, next: 42 });
    await handle.pool.query('DROP SCHEMA earlier CASCADE');
  });
});
