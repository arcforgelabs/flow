// Flow's tables live in the schema "flow", never "public" (migration 0021):
// Replit's publish compares the workspace's "public" with production's and
// offers to make production match, deletes included (docs/REPLIT.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrateDatabase, migrationsFolder } from '../server/db/index.js';
import { migrateEverything } from '../server/db/migrate-all.js';
import { adapters } from '../server/integrations/adapters.js';
import { migrateAdapterSchema } from '../server/integrations/schema.js';
import { freshDatabase, skipWithoutDatabase, testDatabaseUrl } from './support/db.js';
import { explainObligation } from '../server/core/ledger.js';
import { getInvoice } from '../server/core/invoices.js';

async function inSchema(pool, schema) {
  const { rows } = await pool.query(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r', 'v', 'm', 'p') order by 1`,
    [schema],
  );
  return rows.map((row) => row.name);
}

async function functionsIn(pool, schema) {
  const { rows } = await pool.query('select proname from pg_proc where pronamespace = $1::regnamespace order by 1', [schema]);
  return rows.map((row) => row.proname);
}

// The core migrations before one schema change, for an upgrade fixture.
function coreBeforeMigration(index) {
  const folder = mkdtempSync(join(tmpdir(), 'flow-before-migration-'));
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalFile = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
  journal.entries = journal.entries.filter((entry) => entry.idx < index);
  writeFileSync(journalFile, JSON.stringify(journal));
  return folder;
}

// An adapter's migrations as an installation before the move has them: the
// ones written later (`from` on) create their tables in "flow" after it.
const ADAPTER_AFTER_MOVE = { xero: 13 };
function adapterBeforeMove(adapter) {
  const from = ADAPTER_AFTER_MOVE[adapter.id];
  if (from === undefined) return adapter;
  const folder = mkdtempSync(join(tmpdir(), `flow-before-move-${adapter.id}-`));
  cpSync(adapter.schema.migrationsFolder, folder, { recursive: true });
  const journalFile = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
  journal.entries = journal.entries.filter((entry) => entry.idx < from);
  writeFileSync(journalFile, JSON.stringify(journal));
  const tables = adapter.schema.tables.filter((table) => !['xero_contact_sync', 'xero_invoice_link_history'].includes(table));
  return { ...adapter, schema: { ...adapter.schema, migrationsFolder: folder, tables } };
}

test('Flow\'s tables live in "flow"', { skip: skipWithoutDatabase }, async (t) => {
  await t.test('a new database keeps no Flow table or function in "public"', async () => {
    const handle = await freshDatabase();
    try {
      await migrateEverything(handle.db);
      assert.deepEqual(await inSchema(handle.pool, 'public'), []);
      assert.deepEqual(await functionsIn(handle.pool, 'public'), []);
      const flow = await inSchema(handle.pool, 'flow');
      for (const table of ['organisations', 'invoices', 'captures', 'xero_calls', 'seazona_orders']) assert.ok(flow.includes(table), table);
      assert.deepEqual(await functionsIn(handle.pool, 'flow'), ['flow_invoice_lines_draft_only', 'flow_invoice_rules', 'flow_invoice_versions_append_only', 'flow_refuse_change']);
    } finally {
      await handle.close();
    }
  });

  await t.test('an installation from before moves its tables, rows and triggers to "flow"', async () => {
    const handle = await freshDatabase();
    // freshDatabase ran every core migration; start again from before the move.
    await handle.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS flow CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const before = coreBeforeMigration(21);
    try {
      await migrateDatabase(handle.db, { folder: before });
      for (const adapter of adapters.filter((a) => a.schema)) await migrateAdapterSchema(handle.db, adapterBeforeMove(adapter));
      assert.ok((await inSchema(handle.pool, 'public')).includes('xero_calls'));
      await handle.pool.query("insert into organisations (name) values ('Example Lab')");

      await migrateEverything(handle.db);
      assert.deepEqual(await inSchema(handle.pool, 'public'), []);
      assert.deepEqual(await functionsIn(handle.pool, 'public'), []);
      const { rows } = await handle.pool.query('select name from flow.organisations');
      assert.deepEqual(rows, [{ name: 'Example Lab' }]);
      // A second start finds nothing to move.
      await migrateEverything(handle.db);
      assert.ok((await inSchema(handle.pool, 'flow')).includes('xero_calls'));
      assert.ok((await inSchema(handle.pool, 'flow')).includes('xero_contact_sync'));
    } finally {
      rmSync(before, { recursive: true, force: true });
      await handle.close();
    }
  });

  await t.test('the move closes idle sessions opened before it, as a pooler keeps them', async () => {
    const handle = await freshDatabase();
    await handle.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS flow CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const before = coreBeforeMigration(21);
    // A pooler's server session: open before the move, searching "public".
    const stale = new pg.Client({ connectionString: testDatabaseUrl });
    const closed = new Promise((resolve) => stale.on('error', resolve));
    try {
      await migrateDatabase(handle.db, { folder: before });
      await stale.connect();
      await stale.query('set search_path to public');
      await migrateEverything(handle.db);
      const error = await closed;
      assert.match(error.message, /terminat/i);
    } finally {
      rmSync(before, { recursive: true, force: true });
      await stale.end().catch(() => {});
      await handle.close();
    }
  });

  await t.test('any new session finds the tables by name: the database searches "flow" first', async () => {
    const handle = await freshDatabase();
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    try {
      await migrateEverything(handle.db);
      await client.connect();
      const { rows: [{ search_path: path }] } = await client.query('show search_path');
      assert.match(path, /^flow, public$/);
      const { rows: [{ n }] } = await client.query('select count(*)::int as n from organisations');
      assert.equal(n, 0);
      // Set for Flow's role too, which a transaction pooler's sessions also get.
      const { rows: settings } = await client.query(
        `select s.setconfig from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase
          where d.datname = current_database() and s.setrole = (select oid from pg_roles where rolname = current_user)`,
      );
      assert.deepEqual(settings.map((row) => row.setconfig), [['search_path=flow, public']]);
    } finally {
      await client.end().catch(() => {});
      await handle.close();
    }
  });
});

// The Xero adapter as an installation before one of its migrations has it.
function xeroBeforeMigration(index, laterTables) {
  const adapter = adapters.find((a) => a.id === 'xero');
  const folder = mkdtempSync(join(tmpdir(), 'flow-xero-before-migration-'));
  cpSync(adapter.schema.migrationsFolder, folder, { recursive: true });
  const journalFile = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
  journal.entries = journal.entries.filter((entry) => entry.idx < index);
  writeFileSync(journalFile, JSON.stringify(journal));
  return { ...adapter, schema: { ...adapter.schema, migrationsFolder: folder, tables: adapter.schema.tables.filter((table) => !laterTables.includes(table)) } };
}

test('the Xero pair history upgrade keeps every invoice, version, override, push and link row', { skip: skipWithoutDatabase }, async () => {
  const handle = await freshDatabase();
  // Release 2026.11.19: the Xero adapter up to migration 0016.
  const before = xeroBeforeMigration(17, ['xero_invoice_link_history']);
  try {
    await migrateAdapterSchema(handle.db, before);
    assert.equal((await inSchema(handle.pool, 'flow')).includes('xero_invoice_link_history'), false);
    const one = async (text, values) => (await handle.pool.query(text, values)).rows[0];
    const organisation = await one("insert into organisations (name) values ('Sample Upgrade Lab') returning id");
    const contact = await one("insert into contacts (organisation_id, kind, name) values ($1, 'customer', 'Sample Practice') returning id", [organisation.id]);
    const person = await one("insert into people (email, role, status) values ('upgrade-owner@example.test', 'owner', 'active') returning id");
    const invoice = await one(`insert into invoices (organisation_id, contact_id, number, status, issued_version, issue_date, subtotal_cents, tax_cents, total_cents)
      values ($1, $2, 'INV-0001', 'issued', 1, '2026-11-01', 10000, 1000, 11000) returning id`, [organisation.id, contact.id]);
    const linked = await one(`insert into invoices (organisation_id, contact_id, number, status, issued_version, issue_date, subtotal_cents, tax_cents, total_cents)
      values ($1, $2, 'INV-0002', 'issued', 1, '2026-11-01', 10000, 1000, 11000) returning id`, [organisation.id, contact.id]);
    for (const id of [invoice.id, linked.id]) {
      await handle.pool.query(`insert into invoice_versions (organisation_id, invoice_id, version, issued_by, document) values ($1, $2, 1, 'user:sample', '{"totalCents": 11000}')`, [organisation.id, id]);
    }
    await handle.pool.query(`insert into send_overrides (organisation_id, invoice_id, version, document_hash, problems, reason_code, person_id)
      values ($1, $2, 1, 'sample', '[]', 'one_off', $3)`, [organisation.id, invoice.id, person.id]);
    await handle.pool.query(`insert into xero_invoices (organisation_id, xero_invoice_id, type, invoice_number, status, issued_on, total_cents, record_hash)
      values ($1, 'sample-x1', 'ACCREC', 'INV-0001', 'AUTHORISED', '2026-11-01', 11000, 'h1'), ($1, 'sample-x2', 'ACCREC', 'INV-0002', 'PAID', '2026-11-01', 11000, 'h2')`, [organisation.id]);
    await handle.pool.query(`insert into xero_invoice_pushes (organisation_id, invoice_id, version, state, idempotency_key, request_body, body_hash, xero_invoice_id, xero_invoice_number, xero_status, verified)
      values ($1, $2, 1, 'created', 'sample-key', '{}', 'hash', 'sample-x1', 'INV-0001', 'AUTHORISED', true)`, [organisation.id, invoice.id]);
    await handle.pool.query(`insert into xero_invoice_links (organisation_id, xero_invoice_id, invoice_id, matched_by, linked_by)
      values ($1, 'sample-x2', $2, 'made', 'person:sample')`, [organisation.id, linked.id]);
    const tables = ['invoices', 'invoice_versions', 'send_overrides', 'xero_invoices', 'xero_invoice_pushes', 'xero_invoice_links'];
    const stored = async () => Object.fromEntries(await Promise.all(tables.map(async (table) => [table,
      (await handle.pool.query(`select to_jsonb(t) as data from ${table} t order by to_jsonb(t)::text`)).rows.map((row) => row.data)])));
    const old = await stored();
    assert.deepEqual(tables.map((table) => old[table].length), [2, 2, 1, 2, 1, 1]);

    await migrateEverything(handle.db);
    await migrateEverything(handle.db);
    assert.deepEqual(await stored(), old, 'the upgrade changes no existing row');
    assert.deepEqual((await handle.pool.query('select count(*)::int as n from xero_invoice_link_history')).rows, [{ n: 0 }]);
    assert.equal((await getInvoice(handle.db, organisation.id, invoice.id)).status, 'issued');
  } finally {
    rmSync(before.schema.migrationsFolder, { recursive: true, force: true });
    await handle.close();
  }
});

test('source totals upgrade preserves old rows and does not backfill them', { skip: skipWithoutDatabase }, async () => {
  const handle = await freshDatabase();
  const before = coreBeforeMigration(25);
  try {
    await handle.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS flow CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrateDatabase(handle.db, { folder: before });
    const { rows: [organisation] } = await handle.pool.query("insert into organisations (name) values ('Sample Upgrade Lab') returning id");
    const { rows: [old] } = await handle.pool.query(
      `insert into billing_obligations (organisation_id, source_system, source_job_ref, lines, line_fingerprint,
        subtotal_cents, tax_cents, total_cents, mapping_complete, source_seen_at, hold_state, hold_reason)
        values ($1, 'sample', 'SAMPLE-OLD', '[]', 'sample', 10000, 1000, 11000, false, now(), 'held', 'Sample hold')
        returning to_jsonb(billing_obligations) as data`, [organisation.id],
    );
    assert.equal('source_totals' in old.data, false);
    await migrateDatabase(handle.db);
    await migrateDatabase(handle.db);
    const { rows: [upgraded] } = await handle.pool.query('select to_jsonb(o) as data from billing_obligations o where id = $1', [old.data.id]);
    const { source_totals, remake, no_charge_reason, no_charge_by, no_charge_at, amounts_include_tax, ...unchanged } = upgraded.data;
    assert.equal(source_totals, null);
    assert.equal(remake, false, 'an old job is not a remake until its work system says so');
    assert.deepEqual([no_charge_reason, no_charge_by, no_charge_at], [null, null, null], 'an old job is charged until a person says No Charge');
    assert.equal(amounts_include_tax, false, 'an old job keeps tax-exclusive amounts');
    assert.deepEqual(unchanged, old.data, 'the upgrade changes no existing value');
    const { rows: [column] } = await handle.pool.query(`select is_nullable, column_default from information_schema.columns
      where table_schema = 'flow' and table_name = 'billing_obligations' and column_name = 'source_totals'`);
    assert.deepEqual(column, { is_nullable: 'YES', column_default: null });
    const detail = await explainObligation(handle.db, organisation.id, old.data.id);
    assert.equal(detail.view, 'held');
    assert.ok(detail.reasons.includes('Sample hold'));
  } finally {
    rmSync(before, { recursive: true, force: true });
    await handle.close();
  }
});

test('send mode and shown email upgrade keeps old invoices on their customer\'s mode', { skip: skipWithoutDatabase }, async () => {
  const handle = await freshDatabase();
  const before = coreBeforeMigration(38);
  try {
    await handle.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS flow CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrateDatabase(handle.db, { folder: before });
    const { rows: [organisation] } = await handle.pool.query("insert into organisations (name) values ('Sample Upgrade Lab') returning id");
    const { rows: [contact] } = await handle.pool.query("insert into contacts (organisation_id, kind, name) values ($1, 'customer', 'Sample Practice') returning id", [organisation.id]);
    const { rows: [old] } = await handle.pool.query(
      `insert into invoices (organisation_id, contact_id, send_state, send_requested_by) values ($1, $2, 'queued', null)
        returning to_jsonb(invoices) as data`, [organisation.id, contact.id],
    );
    assert.equal('send_mode' in old.data, false);
    await migrateDatabase(handle.db);
    await migrateDatabase(handle.db);
    const { rows: [upgraded] } = await handle.pool.query('select to_jsonb(i) as data from invoices i where id = $1', [old.data.id]);
    const { send_mode, send_email, ...unchanged } = upgraded.data;
    assert.deepEqual([send_mode, send_email], [null, null], 'an old invoice keeps its customer\'s send mode and has no shown email');
    assert.deepEqual(unchanged, old.data, 'the upgrade changes no existing value');
    const loaded = await getInvoice(handle.db, organisation.id, old.data.id);
    assert.deepEqual([loaded.sendState, loaded.sendMode, loaded.sendEmail], ['queued', null, null]);
  } finally {
    rmSync(before, { recursive: true, force: true });
    await handle.close();
  }
});
