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

// The core migrations up to 0020, as an installation before the move has them.
function coreBeforeMove() {
  const folder = mkdtempSync(join(tmpdir(), 'flow-before-move-'));
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalFile = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
  journal.entries = journal.entries.filter((entry) => entry.idx < 21);
  writeFileSync(journalFile, JSON.stringify(journal));
  return folder;
}

test('Flow\'s tables live in "flow"', { skip: skipWithoutDatabase }, async (t) => {
  await t.test('a new database keeps no Flow table or function in "public"', async () => {
    const handle = await freshDatabase();
    try {
      await migrateEverything(handle.db);
      assert.deepEqual(await inSchema(handle.pool, 'public'), []);
      assert.deepEqual(await functionsIn(handle.pool, 'public'), []);
      const flow = await inSchema(handle.pool, 'flow');
      for (const table of ['organisations', 'invoices', 'xero_calls', 'seazona_orders']) assert.ok(flow.includes(table), table);
      assert.deepEqual(await functionsIn(handle.pool, 'flow'), ['flow_invoice_lines_draft_only', 'flow_invoice_rules', 'flow_refuse_change']);
    } finally {
      await handle.close();
    }
  });

  await t.test('an installation from before moves its tables, rows and triggers to "flow"', async () => {
    const handle = await freshDatabase();
    // freshDatabase ran every core migration; start again from before the move.
    await handle.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS flow CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const before = coreBeforeMove();
    try {
      await migrateDatabase(handle.db, { folder: before });
      for (const adapter of adapters.filter((a) => a.schema)) await migrateAdapterSchema(handle.db, adapter);
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
    } finally {
      rmSync(before, { recursive: true, force: true });
      await handle.close();
    }
  });

  await t.test('the move closes idle sessions opened before it, as a pooler keeps them', async () => {
    const handle = await freshDatabase();
    await handle.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS flow CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const before = coreBeforeMove();
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
