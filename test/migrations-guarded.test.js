// Core migrations from GUARD_FROM on, and every adapter's, must run on a
// database that already has their tables and columns. A second safety net: on
// Replit, a publish whose database prompt was approved by mistake adds them to
// production before Flow starts (docs/REPLIT.md, "The workspace database").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrateEverything } from '../server/db/migrate-all.js';
import { adapters } from '../server/integrations/adapters.js';
import { migrationsTable } from '../server/integrations/schema.js';
import { GUARD_FROM, expectedSql, guardSql, inFlowSchema, migrationFiles, namesFlowSchema } from '../scripts/db-guard-migrations.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

const journal = JSON.parse(readFileSync(fileURLToPath(new URL('../server/db/migrations/meta/_journal.json', import.meta.url)), 'utf8'));

test('every migration from GUARD_FROM on is guarded and only adds', () => {
  const files = migrationFiles();
  assert.ok(files.length > 0);
  for (const file of files) {
    const sql = readFileSync(file, 'utf8');
    const { sql: guarded, problems } = expectedSql(file, sql);
    assert.deepEqual(problems, [], file);
    assert.equal(guarded, sql, `${file} is not guarded: run node scripts/db-guard-migrations.js`);
  }
});

test('migrations from 0021 on, and every adapter\'s, name Flow\'s tables in "flow"', () => {
  const files = migrationFiles();
  assert.ok(files.some((file) => /0021_flow_schema\.sql$/.test(file) && namesFlowSchema(file)));
  assert.ok(files.some((file) => /0020_[^/]*\.sql$/.test(file) && !namesFlowSchema(file)), 'older core migrations stay as they ran');
  assert.ok(files.some((file) => /integrations\/xero\//.test(file) && namesFlowSchema(file)));
  assert.equal(
    inFlowSchema('ALTER TABLE "a" ADD CONSTRAINT "f" FOREIGN KEY ("o") REFERENCES "public"."organisations"("id");'),
    'ALTER TABLE "a" ADD CONSTRAINT "f" FOREIGN KEY ("o") REFERENCES "flow"."organisations"("id");',
  );
});

test('guardSql refuses drops and renames', () => {
  assert.match(guardSql('DROP TABLE "x";').problems[0], /drops or renames/);
  assert.match(guardSql('ALTER TABLE "x" RENAME COLUMN "a" TO "b";').problems[0], /drops or renames/);
  assert.match(guardSql('ALTER TABLE "x" DROP CONSTRAINT "c";').problems[0], /drops or renames/);
  assert.deepEqual(guardSql('ALTER TABLE "x" ADD CONSTRAINT "f" FOREIGN KEY ("a") REFERENCES "y"("id") ON DELETE set null ON UPDATE no action;').problems, []);
});

test('a check grows by replacing that constraint, and the replacement runs twice', () => {
  const raw = [
    'ALTER TABLE "invoices" DROP CONSTRAINT "invoices_status_valid";',
    'ALTER TABLE "billing_obligations" DROP CONSTRAINT "billing_obligations_accounting_state_valid";',
    'ALTER TABLE "invoices" ADD CONSTRAINT "invoices_status_valid" CHECK ("invoices"."status" in (\'draft\', \'non_chargeable\'));',
    'ALTER TABLE "billing_obligations" ADD CONSTRAINT "billing_obligations_accounting_state_valid" CHECK (accounting_state in (\'not_found\', \'non_chargeable\'));',
  ].join('--> statement-breakpoint\n');
  const { sql, problems } = guardSql(raw);
  assert.deepEqual(problems, []);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS "invoices_status_valid"/);
  assert.match(sql, /'non_chargeable'/);
  assert.equal(sql.split('--> statement-breakpoint').length, 2);
  assert.equal(guardSql(sql).sql, sql);
  assert.deepEqual(guardSql(sql).problems, []);
});

async function schemaShape(pool) {
  const { rows } = await pool.query(`
    select 'c' as k, table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') as v
      from information_schema.columns where table_schema = 'flow'
    union all
    select 'k', conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
      from pg_constraint where connamespace = 'flow'::regnamespace
    union all
    select 'i', indexdef from pg_indexes where schemaname = 'flow'
    order by 1, 2`);
  return rows.map((row) => `${row.k} ${row.v}`);
}

test('Flow migrates a database whose new tables are already there', { skip: skipWithoutDatabase }, async () => {
  const handle = await freshDatabase();
  try {
    await migrateEverything(handle.db);
    const before = await schemaShape(handle.pool);
    assert.ok(before.some((line) => line.includes('xero_connections.')), 'adapter tables are created whether or not the adapter is on');
    // The schema is complete, but Flow's records say the guarded migrations
    // never ran: what production looks like after publishing added them.
    const guarded = journal.entries.filter((entry) => entry.idx >= GUARD_FROM).map((entry) => entry.when);
    assert.ok(guarded.length > 0);
    await handle.pool.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ANY($1::bigint[])', [guarded]);
    for (const adapter of adapters.filter((a) => a.schema)) {
      await handle.pool.query(`DROP TABLE drizzle."${migrationsTable(adapter)}"`);
    }
    await migrateEverything(handle.db);
    assert.deepEqual(await schemaShape(handle.pool), before);
    const { rows } = await handle.pool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    assert.equal(rows[0].n, journal.entries.length);
  } finally {
    await handle.close();
  }
});
