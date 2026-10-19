import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { CALL_GUARD_COLUMNS, CallsStopped, createCallGuard } from '../../server/integrations/call-guard.js';
import { migrateAdapterSchema } from '../../server/integrations/schema.js';
import { freshDatabase, skipWithoutDatabase } from './db.js';
import { fakeClock } from './seazona.js';

// The call guard contract (docs/INTEGRATIONS.md, "Outbound calls"). Every
// adapter that declares a callGuard runs this same suite against its own
// tables and policy: a new integration gets the standard tests by declaring
// the guard. Synthetic data only.

const MINUTE = 60_000;

function countingLog() {
  const lines = { info: [], warn: [], error: [] };
  return { lines, info: (l) => lines.info.push(l), warn: (l) => lines.warn.push(l), error: (l) => lines.error.push(l) };
}

export function callGuardContract(adapter) {
  const declared = adapter.callGuard;
  describe(`${adapter.name} call guard contract`, { skip: skipWithoutDatabase }, () => {
    let handle;
    let clock;
    let log;
    let guard;
    const KEY = 'synthetic-key';

    before(async () => {
      handle = await freshDatabase();
      await migrateAdapterSchema(handle.db, adapter);
    });
    after(async () => handle?.close());
    beforeEach(async () => {
      await handle.db.execute(sql`truncate ${sql.identifier(declared.tables.state)}, ${sql.identifier(declared.tables.calls)}`);
      clock = fakeClock('2026-10-01T01:00:00.000Z');
      log = countingLog();
      guard = createCallGuard({ db: handle.db, ...declared, now: clock.now, log });
    });

    const fail = (n, call = { statusCode: 500 }, everyMs = 0) => (async () => {
      for (let i = 0; i < n; i += 1) {
        await guard.record(KEY, { resource: 'things', ...call });
        clock.advance(everyMs);
      }
    })();
    const stopsWith = async (reason, options) => assert.rejects(guard.check(KEY, options), (error) => {
      assert.ok(error instanceof CallsStopped);
      assert.equal(error.reason, reason);
      assert.equal(error.code.startsWith(`${adapter.id}_`), true, error.code);
      return true;
    });

    test('its tables have the guard columns', async () => {
      const columns = { key: 'key', at: 'at', ...declared.columns };
      for (const [part, table] of [['state', declared.tables.state], ['calls', declared.tables.calls]]) {
        const { rows } = await handle.db.execute(sql`select column_name from information_schema.columns where table_name = ${table}`);
        const have = new Set(rows.map((r) => r.column_name));
        for (const column of CALL_GUARD_COLUMNS[part]) assert.ok(have.has(columns[column] ?? column), `${table} needs ${columns[column] ?? column}`);
      }
    });

    test('a success and a 404 never stop calls', async () => {
      await fail(20, { statusCode: 404 });
      await fail(20, { statusCode: 200 });
      await guard.check(KEY);
      assert.equal((await guard.status(KEY)).failedToday, 0);
    });

    test('repeated failures open the circuit once, then a probe decides', async () => {
      await fail(4);
      await guard.check(KEY);
      await fail(1);
      await stopsWith('circuit_open');
      assert.equal(log.lines.error.length, 1);
      assert.equal((await guard.status(KEY)).circuit, 'open');
      clock.advance(5 * MINUTE);
      await guard.check(KEY); // the probe may go
      await fail(1); // and fails: twice as long
      await stopsWith('circuit_open');
      assert.equal(log.lines.error.length, 1, 'a re-opened circuit is a warning');
      assert.equal(log.lines.warn.length, 1);
      clock.advance(10 * MINUTE - 1);
      await stopsWith('circuit_open');
      clock.advance(1);
      await guard.record(KEY, { statusCode: 200 });
      assert.equal((await guard.status(KEY)).circuit, 'closed');
    });

    test('the pause doubles to at most 6 hours', async () => {
      await fail(5);
      for (let opens = 1; opens < 10; opens += 1) {
        const { circuitOpenUntil } = await guard.status(KEY);
        clock.set(circuitOpenUntil);
        await fail(1);
      }
      const { circuitOpenUntil } = await guard.status(KEY);
      assert.equal(Date.parse(circuitOpenUntil) - clock.now(), 6 * 60 * MINUTE);
    });

    test('the day\'s failed-call budget stops calls until the next UTC day, reported once', async () => {
      const { dailyFailureBudget } = await guard.status(KEY);
      // Spaced out, so the circuit never opens: only the budget stops calls.
      await fail(dailyFailureBudget, { statusCode: 500 }, 3 * MINUTE);
      await stopsWith('budget_spent');
      await fail(3, { statusCode: 500 }, 3 * MINUTE);
      assert.equal(log.lines.error.length, 1);
      clock.set('2026-10-02T00:00:00.000Z');
      await guard.check(KEY);
    });

    test('a refused credential stops calls until a person acts, reported once', async () => {
      const resourceOnly = declared.policy?.authStops === 'resource';
      await fail(3, { resource: 'things', statusCode: 403 });
      assert.equal(log.lines.error.length, 1);
      if (resourceOnly) {
        await stopsWith('resource_stopped', { resource: 'things' });
        await guard.check(KEY, { resource: 'others' });
      } else {
        await stopsWith('halted', { resource: 'others' });
      }
      clock.advance(24 * 60 * MINUTE);
      await assert.rejects(guard.check(KEY, { resource: 'things' }), CallsStopped);
      await guard.resume();
      await guard.check(KEY, { resource: 'things' });
    });

    test('halt stops every call until resume', async () => {
      assert.equal(await guard.halt(KEY, 'auth'), true);
      assert.equal(await guard.halt(KEY, 'auth'), false);
      assert.equal(log.lines.error.length, 1);
      await stopsWith('halted', { resource: 'things' });
      assert.equal((await guard.status(KEY)).circuit, 'halted');
      await guard.resume(KEY);
      await guard.check(KEY);
    });

    test('status has the same shape for every adapter', async () => {
      await fail(1, { statusCode: 503 });
      assert.deepEqual(Object.keys(await guard.status(KEY)).sort(),
        ['circuit', 'circuitOpenUntil', 'dailyFailureBudget', 'failedToday', 'haltedAt', 'haltedReason', 'stoppedResources']);
      assert.equal((await guard.status(KEY)).failedToday, 1);
    });
  });
}
