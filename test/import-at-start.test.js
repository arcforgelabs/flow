import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { migrateDatabase } from '../server/db/index.js';
import { importEarlierAtStart, resolveImportAtStart } from '../server/import/at-start.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

const quiet = { info() {} };

describe('import from the earlier codebase at start: settings', () => {
  test('off unless FLOW_IMPORT_EARLIER_SCHEMA is set; a bad name or a missing lab name stops boot', () => {
    assert.equal(resolveImportAtStart({}), null);
    assert.deepEqual(
      resolveImportAtStart({ FLOW_IMPORT_EARLIER_SCHEMA: 'earlier', FLOW_IMPORT_ORGANISATION: ' Example Lab ' }),
      { schema: 'earlier', organisationName: 'Example Lab' },
    );
    assert.throws(() => resolveImportAtStart({ FLOW_IMPORT_EARLIER_SCHEMA: 'earlier"; drop', FLOW_IMPORT_ORGANISATION: 'x' }), /plain lower-case schema name/);
    assert.throws(() => resolveImportAtStart({ FLOW_IMPORT_EARLIER_SCHEMA: 'earlier' }), /FLOW_IMPORT_ORGANISATION/);
  });
});

describe('import from the earlier codebase at start', { skip: skipWithoutDatabase }, () => {
  let handle;

  before(async () => {
    handle = await freshDatabase();
    await handle.pool.query(`
      DROP SCHEMA IF EXISTS earlier CASCADE;
      CREATE SCHEMA earlier;
      CREATE TABLE earlier.xero_catalog_contacts (contact_id TEXT PRIMARY KEY, name TEXT NOT NULL, email_address TEXT, status TEXT, raw_json TEXT NOT NULL);
      CREATE TABLE earlier.xero_catalog_items (item_code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, sales_details_json TEXT, is_sold INTEGER NOT NULL);
      CREATE TABLE earlier.xero_catalog_invoices (invoice_number TEXT, type TEXT);
      INSERT INTO earlier.xero_catalog_contacts VALUES ('c1', 'Example Practice', NULL, 'ACTIVE', '{"IsCustomer":true}');
      INSERT INTO earlier.xero_catalog_items VALUES ('CRN', 'Crown', NULL, '{"unitPrice":220,"taxType":"OUTPUT"}', 1);
      INSERT INTO earlier.xero_catalog_invoices VALUES ('INV-0041', 'ACCREC');
    `);
  });

  after(async () => {
    await handle?.pool.query('DROP SCHEMA IF EXISTS earlier CASCADE');
    await handle?.close();
  });

  test('imports once while there is no organisation, then does nothing', async () => {
    await migrateDatabase(handle.db);
    const settings = { schema: 'earlier', organisationName: 'Example Lab' };
    assert.deepEqual(await importEarlierAtStart({ db: handle.db, pool: handle.pool, settings, log: quiet }), { contacts: 1, priceItems: 1 });
    const { rows: [organisation] } = await handle.pool.query('select name, next_invoice_number from organisations');
    assert.deepEqual(organisation, { name: 'Example Lab', next_invoice_number: 42 });
    assert.equal(await importEarlierAtStart({ db: handle.db, pool: handle.pool, settings, log: quiet }), null);
    const { rows: [{ count }] } = await handle.pool.query('select count(*)::int as count from contacts');
    assert.equal(count, 1);
  });

  test('a schema without the earlier tables is an error, and writes nothing', async () => {
    await handle.pool.query('DELETE FROM contacts; DELETE FROM price_items; DELETE FROM organisations');
    await assert.rejects(
      importEarlierAtStart({ db: handle.db, pool: handle.pool, settings: { schema: 'missing', organisationName: 'Example Lab' }, log: quiet }),
      /could not read schema "missing"/,
    );
    const { rows: [{ count }] } = await handle.pool.query('select count(*)::int as count from organisations');
    assert.equal(count, 0);
  });
});
