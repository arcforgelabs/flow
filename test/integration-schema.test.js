import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createIntegrations, resolveEnabledIntegrations } from '../server/integrations/index.js';
import { createRegistry, defineAdapter } from '../server/integrations/port.js';
import { removeAdapterTables } from '../server/integrations/schema.js';
import { SAMPLE_TABLES, sampleAdapter } from './fixtures/sample-adapter/index.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// An adapter's tables exist only once it has been enabled at a start
// (issue #13). Synthetic adapter and data only.
const quiet = { error() {}, info() {}, warn() {} };
const health = async () => ({ ok: true });

async function tablesPresent(db) {
  const { rows } = await db.execute(sql`select table_name from information_schema.tables where table_schema = 'flow' and table_name like 'sample\\_%' order by table_name`);
  return rows.map((r) => r.table_name);
}

// One server start: register the adapter, enable it if `on`, start.
async function boot(db, { on }) {
  const registry = createIntegrations({
    env: { FLOW_INTEGRATIONS: on ? 'sample' : '' },
    adapters: [sampleAdapter(db)],
    log: quiet,
  });
  await registry.start(db);
  return registry;
}

test('an adapter schema lists tables that start with its id', () => {
  const folder = '/nowhere';
  assert.throws(() => defineAdapter({ id: 'sample', name: 'S', schema: { migrationsFolder: folder, tables: ['invoices'] }, capabilities: { health } }), /must be a lower-case name that starts with sample_/);
  assert.throws(() => defineAdapter({ id: 'sample', name: 'S', schema: { migrationsFolder: folder, tables: [] }, capabilities: { health } }), /must list its tables/);
  assert.throws(() => defineAdapter({ id: 'sample', name: 'S', schema: { tables: ['sample_a'] }, capabilities: { health } }), /needs a migrationsFolder/);
  const dashed = defineAdapter({ id: 'my-lab', name: 'S', schema: { migrationsFolder: folder, tables: ['my_lab_cases'] }, capabilities: { health } });
  assert.deepEqual(dashed.schema.tables, ['my_lab_cases']);
});

test('FLOW_INTEGRATIONS turns adapters on, and an unknown id stops boot', () => {
  const adapters = [{ id: 'sample' }, { id: 'other' }];
  assert.deepEqual(resolveEnabledIntegrations({}, adapters), []);
  assert.deepEqual(resolveEnabledIntegrations({ FLOW_INTEGRATIONS: ' Sample, other,sample ' }, adapters), ['sample', 'other']);
  assert.throws(() => resolveEnabledIntegrations({ FLOW_INTEGRATIONS: 'sampel' }, adapters), /unknown integration: sampel/);
});

test('an adapter turned on after start answers turned off until the next start', async () => {
  const registry = createRegistry({ log: quiet });
  registry.register({ id: 'sample', name: 'Sample', schema: { migrationsFolder: '/nowhere', tables: ['sample_items'] }, capabilities: { health, pullWorkItems: health } });
  await registry.start(null);
  registry.enable('sample');
  assert.deepEqual(registry.with('pullWorkItems'), []);
  const answer = await registry.whenEnabled('sample', () => assert.fail('must not run'));
  assert.equal(answer.code, 'integration_off');
  assert.equal(answer.reason, 'restart_needed');
});

describe('adapter tables in PostgreSQL', { skip: skipWithoutDatabase }, () => {
  let handle;

  before(async () => {
    handle = await freshDatabase();
  });
  beforeEach(async () => {
    await handle.pool.query('DROP TABLE IF EXISTS sample_cursor, sample_items; DROP TABLE IF EXISTS drizzle.__drizzle_migrations_sample;');
  });
  after(async () => handle?.close());

  test('a start with the adapter off creates none of its tables, and reads get the turned-off answer', async () => {
    const registry = await boot(handle.db, { on: false });
    assert.deepEqual(await tablesPresent(handle.db), []);
    assert.deepEqual(registry.with('pullWorkItems'), []);
    const answer = await registry.whenEnabled('sample', (a) => a.capabilities.pullWorkItems());
    assert.deepEqual(answer, { ok: false, code: 'integration_off', integration: 'sample', reason: 'disabled', error: 'Sample is turned off on this installation.' });
    assert.equal(registry.list()[0].state, 'disabled');
  });

  test('a start with the adapter on creates all of its tables', async () => {
    const registry = await boot(handle.db, { on: true });
    assert.deepEqual(await tablesPresent(handle.db), [...SAMPLE_TABLES].sort());
    assert.deepEqual(registry.with('pullWorkItems').map((a) => a.id), ['sample']);
    assert.deepEqual(await registry.whenEnabled('sample', (a) => a.capabilities.pullWorkItems()), []);
    // A second start finds the migration applied and changes nothing.
    await boot(handle.db, { on: true });
    assert.deepEqual(await tablesPresent(handle.db), [...SAMPLE_TABLES].sort());
  });

  test('turning an adapter on later creates its tables at the next start, and turning it off keeps them and their rows', async () => {
    await boot(handle.db, { on: false });
    assert.deepEqual(await tablesPresent(handle.db), []);

    await boot(handle.db, { on: true });
    assert.deepEqual(await tablesPresent(handle.db), [...SAMPLE_TABLES].sort());
    await handle.db.execute(sql`insert into sample_items (reference) values ('CASE-0001')`);

    const off = await boot(handle.db, { on: false });
    assert.deepEqual(await tablesPresent(handle.db), [...SAMPLE_TABLES].sort());
    assert.equal((await off.whenEnabled('sample', () => assert.fail('must not run'))).reason, 'disabled');

    const on = await boot(handle.db, { on: true });
    assert.deepEqual(await on.whenEnabled('sample', (a) => a.capabilities.pullWorkItems()), [{ id: 1, reference: 'CASE-0001' }]);
  });

  test('a table removed by hand gives the turned-off answer, not a crash', async () => {
    const registry = await boot(handle.db, { on: true });
    await handle.pool.query('DROP TABLE sample_cursor, sample_items');
    const answer = await registry.whenEnabled('sample', (a) => a.capabilities.pullWorkItems());
    assert.equal(answer.code, 'integration_off');
    assert.equal(answer.reason, 'tables_missing');
  });

  test('removing tables is a separate step that refuses while the adapter is on or holds rows', async () => {
    await boot(handle.db, { on: true });
    const adapter = defineAdapter(sampleAdapter(handle.db));
    await assert.rejects(removeAdapterTables(handle.db, adapter, { enabled: true }), /Turn Sample off/);

    await handle.db.execute(sql`insert into sample_items (reference) values ('CASE-0002')`);
    await assert.rejects(removeAdapterTables(handle.db, adapter, { enabled: false }), /still hold rows: sample_items/);
    assert.deepEqual(await tablesPresent(handle.db), [...SAMPLE_TABLES].sort());

    await handle.db.execute(sql`delete from sample_items`);
    assert.deepEqual((await removeAdapterTables(handle.db, adapter, { enabled: false })).removed.sort(), [...SAMPLE_TABLES].sort());
    assert.deepEqual(await tablesPresent(handle.db), []);

    // Turned on again, the next start creates them afresh.
    await boot(handle.db, { on: true });
    assert.deepEqual(await tablesPresent(handle.db), [...SAMPLE_TABLES].sort());
  });
});
