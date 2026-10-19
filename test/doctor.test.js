import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { diagnoseDatabase, expectedSchema, formatReport, liveMigrationCounts, publishVerdict } from '../server/db/doctor.js';
import { migrateEverything } from '../server/db/migrate-all.js';
import { adapters } from '../server/integrations/adapters.js';
import { freshDatabase, skipWithoutDatabase, testDatabaseUrl } from './support/db.js';

// Flow's doctor (server/db/doctor.js): what a database lacks against this
// build, and what Replit's publish step will offer. Synthetic databases only.

const OK = { ok: true, migrations: { core: 14, xero: 6 }, pending: [], missingTables: [], missingColumns: [], unknownTables: [] };

test('the verdict says what the publish step will offer', () => {
  assert.equal(publishVerdict({ ...OK, ok: false }, { core: 14 }).verdict, 'broken');
  assert.equal(publishVerdict(OK, null).verdict, 'unknown');
  assert.equal(publishVerdict(OK, { core: 14, xero: 6 }).verdict, 'same');
  assert.equal(publishVerdict(OK, { core: 13, xero: 6 }).verdict, 'adds');
  // An adapter that is off in production has no migrations there.
  assert.equal(publishVerdict(OK, { core: 14 }).verdict, 'adds');
  const behind = publishVerdict(OK, { core: 15, xero: 6 });
  assert.equal(behind.verdict, 'behind');
  assert.match(behind.say, /DROP/);
});

test('the build expects every core table with its columns, and every adapter table', () => {
  const { journals, tables } = expectedSchema({ adapters });
  assert.deepEqual(journals.map((j) => j.id), ['core', ...adapters.filter((a) => a.schema).map((a) => a.id)]);
  assert.ok(journals[0].tags.length >= 14);
  assert.ok(tables.get('invoices')?.has('id'));
  for (const adapter of adapters.filter((a) => a.schema)) {
    for (const table of adapter.schema.tables) assert.ok(tables.has(table), table);
  }
});

test('the live app\'s counts come from its GET /health, or are null', async () => {
  const answer = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
  assert.deepEqual(await liveMigrationCounts('https://flow.example', { fetchImpl: answer({ schema: { migrations: { core: 14 } } }) }), { core: 14 });
  assert.equal(await liveMigrationCounts('https://flow.example', { fetchImpl: answer({ ok: true }) }), null);
  assert.equal(await liveMigrationCounts('https://flow.example', { fetchImpl: answer({}, 500) }), null);
  assert.equal(await liveMigrationCounts('https://flow.example', { fetchImpl: async () => { throw new Error('offline'); } }), null);
});

describe('the doctor on PostgreSQL', { skip: skipWithoutDatabase }, () => {
  let handle;
  before(async () => { handle = await freshDatabase(); });
  after(async () => { await handle?.close(); });

  test('a database with only the core migrations lacks the adapters\' tables', async () => {
    const report = await diagnoseDatabase(handle.pool, { adapters });
    assert.equal(report.ok, false);
    assert.equal(report.pending.some((p) => p.journal === 'core'), false);
    assert.ok(report.pending.some((p) => p.journal === 'xero' && p.applied === 0));
    assert.ok(report.missingTables.length > 0);
    assert.match(formatReport(report).join('\n'), /pending/);
  });

  test('after migrate the database is at this build; a lost column, a foreign table and GET /health show', async () => {
    await migrateEverything(handle.db);
    const report = await diagnoseDatabase(handle.pool, { adapters });
    assert.deepEqual(report.pending, []);
    assert.deepEqual(report.missingTables, []);
    assert.deepEqual(report.missingColumns, []);
    assert.equal(report.ok, true);

    const { journals } = expectedSchema({ adapters });
    const app = createApp({ database: handle, schemaJournals: journals });
    const server = app.listen(0);
    try {
      const health = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
      assert.deepEqual(health.schema, { migrations: report.migrations });
      assert.equal(publishVerdict(report, health.schema.migrations).verdict, 'same');
    } finally {
      server.close();
    }

    await handle.pool.query('ALTER TABLE invoices DROP COLUMN send_error; CREATE TABLE someone_elses (id int)');
    const broken = await diagnoseDatabase(handle.pool, { adapters });
    assert.equal(broken.ok, false);
    assert.deepEqual(broken.missingColumns, ['invoices.send_error']);
    assert.deepEqual(broken.unknownTables, ['someone_elses']);
  });

  test('flow-server doctor exits 1 on a database that is not at this build, and 0 once it is', () => {
    const server = join(import.meta.dirname, '../server/flow-server.js');
    const env = { ...process.env, DATABASE_URL: testDatabaseUrl };
    assert.throws(
      () => execFileSync('node', [server, 'doctor'], { env, encoding: 'utf8' }),
      (error) => error.status === 1 && /missing columns: invoices\.send_error/.test(error.stdout) && /someone_elses/.test(error.stdout),
    );
  });

  test('flow-server migrate keeps a table it does not know; once the column is back, doctor exits 0', async () => {
    const server = join(import.meta.dirname, '../server/flow-server.js');
    const env = { ...process.env, DATABASE_URL: testDatabaseUrl };
    execFileSync('node', [server, 'migrate'], { env, encoding: 'utf8' });
    await handle.pool.query('ALTER TABLE invoices ADD COLUMN send_error jsonb');
    const json = JSON.parse(execFileSync('node', [server, 'doctor', '--json'], { env, encoding: 'utf8' }));
    assert.equal(json.ok, true);
    assert.deepEqual(json.unknownTables, ['someone_elses']);
  });
});
