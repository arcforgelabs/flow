import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { migrateDatabase } from '../server/db/index.js';
import { priorLinkFor } from '../server/core/links.js';
import {
  importEarlierAtStart, importEarlierLinksAtStart, importEarlierMappingsAtStart, resolveImportAtStart,
} from '../server/import/at-start.js';
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
      CREATE TABLE earlier.seazona_order_xero_match_overrides (seazona_order_id TEXT PRIMARY KEY, xero_invoice_id TEXT, xero_invoice_number TEXT,
        match_source TEXT NOT NULL, match_rule TEXT NOT NULL DEFAULT '', matched_at TEXT NOT NULL, matched_by TEXT, notes TEXT NOT NULL DEFAULT '');
      INSERT INTO earlier.seazona_order_xero_match_overrides VALUES
        ('9001', 'x-1', 'INV-0040', 'operator_link', '', '2026-05-01T02:03:04.000Z', 'someone@example.test', 'Example Patient'),
        ('9002', 'x-2', 'INV-0041', 'backfill_sweep', 'patient_doctor_surname_total', 'not a date', NULL, ''),
        ('9003', NULL, NULL, 'operator_link', '', '2026-05-01T00:00:00Z', NULL, 'pinned no match');
      CREATE TABLE earlier.xero_item_match_rules (source_lookup_text TEXT NOT NULL, unit_amount_cents INTEGER NOT NULL, xero_item_code TEXT NOT NULL);
      INSERT INTO earlier.xero_item_match_rules VALUES ('Crown - Upper 4', 22000, 'CRN'), ('', 100, 'CRN'), ('Bad price', -5, 'CRN');
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

  test('carries the earlier order to invoice links over at each start, adding only new ones and no free text', async () => {
    const settings = { schema: 'earlier', organisationName: 'Example Lab' };
    assert.deepEqual(await importEarlierLinksAtStart({ db: handle.db, pool: handle.pool, settings, log: quiet }), { read: 2, added: 2 });
    assert.deepEqual(await importEarlierLinksAtStart({ db: handle.db, pool: handle.pool, settings, log: quiet }), { read: 2, added: 0 });
    const { rows: [lab] } = await handle.pool.query('select id from organisations');
    const person = await priorLinkFor(handle.db, lab.id, { sourceSystem: 'seazona', sourceJobRef: '9001', system: 'xero' });
    assert.equal(person.externalId, 'x-1');
    assert.equal(person.externalNumber, 'INV-0040');
    assert.equal(person.matchedBy, 'person');
    assert.equal(person.matchedAt.toISOString(), '2026-05-01T02:03:04.000Z');
    const sweep = await priorLinkFor(handle.db, lab.id, { sourceSystem: 'seazona', sourceJobRef: '9002', system: 'xero' });
    assert.equal(sweep.matchedBy, 'imported');
    assert.equal(sweep.matchedAt, null);
    assert.equal(await priorLinkFor(handle.db, lab.id, { sourceSystem: 'seazona', sourceJobRef: '9003', system: 'xero' }), null);
    const { rows } = await handle.pool.query('select * from prior_links');
    assert.doesNotMatch(JSON.stringify(rows), /Example Patient|someone@example/);
    assert.equal(await importEarlierLinksAtStart({ db: handle.db, pool: handle.pool, settings: null, log: quiet }), null);
  });

  test('carries the earlier line mapping choices over as saved mappings, adding only new ones', async () => {
    const settings = { schema: 'earlier', organisationName: 'Example Lab' };
    assert.deepEqual(await importEarlierMappingsAtStart({ db: handle.db, pool: handle.pool, settings, log: quiet }), { rules: 1, added: 1, described: 0 });
    assert.deepEqual(await importEarlierMappingsAtStart({ db: handle.db, pool: handle.pool, settings, log: quiet }), { rules: 1, added: 0, described: 0 });
    const { rows } = await handle.pool.query('select kind, label, unit_amount_cents, item_code, origin from line_mappings');
    assert.deepEqual(rows, [{ kind: 'saved', label: 'crown', unit_amount_cents: 22000, item_code: 'CRN', origin: 'earlier:xero_item_match_rules' }]);
    assert.equal(await importEarlierMappingsAtStart({ db: handle.db, pool: handle.pool, settings: null, log: quiet }), null);
  });

  test('a schema without the earlier tables is an error, and writes nothing', async () => {
    await handle.pool.query('DELETE FROM prior_links; DELETE FROM line_mappings');
    await handle.pool.query('DELETE FROM contacts; DELETE FROM price_items; DELETE FROM organisations');
    await assert.rejects(
      importEarlierAtStart({ db: handle.db, pool: handle.pool, settings: { schema: 'missing', organisationName: 'Example Lab' }, log: quiet }),
      /could not read schema "missing"/,
    );
    const { rows: [{ count }] } = await handle.pool.query('select count(*)::int as count from organisations');
    assert.equal(count, 0);
  });
});
