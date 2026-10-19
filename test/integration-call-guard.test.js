import assert from 'node:assert/strict';
import { test } from 'node:test';
import { circuitAfterFailure, circuitPauseMs, countsAsFailure, stoppedReason } from '../server/integrations/call-guard.js';
import { adapters } from '../server/integrations/adapters.js';
import { defineAdapter } from '../server/integrations/port.js';
import { callGuardContract } from './support/call-guard-contract.js';

// Every shipped adapter that calls an outside system goes through the call
// guard (docs/INTEGRATIONS.md, "Outbound calls"), and passes the same
// contract suite. An adapter that does not is listed here, with the reason.
const EXEMPT = {
  sentry: 'error reports go out through the Sentry SDK, which follows Sentry\'s own rate limits and drops reports while Sentry is down',
  seazona: 'its rate governor has the same guards (#104); it moves onto the shared guard in the second change for #111',
};

test('every shipped adapter declares a call guard, or is listed as exempt with a reason', () => {
  for (const adapter of adapters.map(defineAdapter)) {
    if (adapter.callGuard) {
      assert.equal(EXEMPT[adapter.id], undefined, `${adapter.id} has a call guard: remove it from EXEMPT`);
    } else {
      assert.ok(EXEMPT[adapter.id], `${adapter.id} calls out without a call guard: declare callGuard (docs/INTEGRATIONS.md)`);
    }
  }
});

test('a call guard must use the adapter\'s own tables', () => {
  const base = { id: 'example', name: 'Example', capabilities: { health: async () => ({ ok: true }) } };
  const schema = { migrationsFolder: '/x', tables: ['example_call_guard', 'example_calls'] };
  assert.throws(() => defineAdapter({ ...base, schema, callGuard: { integration: 'other', tables: { state: 'example_call_guard', calls: 'example_calls' } } }), /must name integration example/);
  assert.throws(() => defineAdapter({ ...base, schema, callGuard: { integration: 'example', tables: { state: 'other_guard', calls: 'example_calls' } } }), /among its own schema tables/);
  assert.ok(defineAdapter({ ...base, schema, callGuard: { integration: 'example', tables: { state: 'example_call_guard', calls: 'example_calls' } } }).callGuard);
});

test('what counts as a failed call', () => {
  assert.equal(countsAsFailure({ statusCode: 200 }), false);
  assert.equal(countsAsFailure({ statusCode: 404 }), false);
  for (const statusCode of [400, 401, 403, 409, 429, 500, 503]) assert.equal(countsAsFailure({ statusCode }), true, statusCode);
  assert.equal(countsAsFailure({ failureKind: 'timeout' }), true);
});

test('the decisions are pure, so any storage can use them', () => {
  const nowMs = Date.parse('2026-10-01T12:00:00Z');
  assert.equal(circuitPauseMs(0), 5 * 60_000);
  assert.equal(circuitPauseMs(1), 10 * 60_000);
  assert.equal(circuitPauseMs(20), 6 * 60 * 60_000);
  assert.equal(stoppedReason({}, { nowMs, failedToday: 0 }), null);
  assert.equal(stoppedReason({}, { nowMs, failedToday: 50 }).reason, 'budget_spent');
  assert.equal(stoppedReason({ haltedReason: 'auth' }, { nowMs, failedToday: 0 }).reason, 'halted');
  assert.equal(stoppedReason({ stoppedResources: { Payments: {} } }, { nowMs, failedToday: 0, resource: 'Payments' }).reason, 'resource_stopped');
  assert.equal(stoppedReason({ stoppedResources: { Payments: {} } }, { nowMs, failedToday: 0, resource: 'Invoices' }), null);
  assert.equal(circuitAfterFailure({ circuitOpens: 0 }, { nowMs, recentFailures: 4 }), null);
  assert.deepEqual(circuitAfterFailure({ circuitOpens: 0 }, { nowMs, recentFailures: 5 }), { pauseMs: 5 * 60_000 });
  assert.deepEqual(circuitAfterFailure({ circuitOpens: 2, circuitOpenUntil: new Date(nowMs - 1) }, { nowMs, recentFailures: 1 }), { pauseMs: 20 * 60_000 });
});

for (const adapter of adapters.map(defineAdapter).filter((a) => a.callGuard)) callGuardContract(adapter);
