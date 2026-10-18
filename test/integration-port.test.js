import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, defineAdapter } from '../server/integrations/port.js';

const health = async () => ({ ok: true });

test('an adapter must declare health and only known capabilities', () => {
  assert.throws(() => defineAdapter({ id: 'xero', name: 'Xero', capabilities: {} }), /must declare health/);
  assert.throws(
    () => defineAdapter({ id: 'xero', name: 'Xero', capabilities: { health, sendEmail: health } }),
    /unknown capability sendEmail/,
  );
  assert.throws(() => defineAdapter({ id: 'Bad Id', name: 'x', capabilities: { health } }), /id must match/);
});

test('the core reaches only enabled adapters that declare the capability', () => {
  const registry = createRegistry();
  registry.register({ id: 'seazona', name: 'Seazona', bundled: true, capabilities: { health, pullWorkItems: health } });
  registry.register({ id: 'xero', name: 'Xero', capabilities: { health, pushInvoice: health, pullPayments: health } });

  assert.deepEqual(registry.with('pushInvoice'), []);

  registry.enable('seazona');
  registry.enable('xero');
  assert.deepEqual(registry.with('pullWorkItems').map((a) => a.id), ['seazona']);
  assert.deepEqual(registry.with('pushInvoice').map((a) => a.id), ['xero']);

  registry.disable('seazona');
  assert.deepEqual(registry.with('pullWorkItems'), []);
  assert.equal(registry.list().find((a) => a.id === 'seazona').bundled, true);
});

test('an adapter id registers once', () => {
  const registry = createRegistry();
  registry.register({ id: 'xero', name: 'Xero', capabilities: { health } });
  assert.throws(() => registry.register({ id: 'xero', name: 'Xero', capabilities: { health } }), /already registered/);
});

test('start runs each enabled adapter after its tables are ready, and stop ends them newest first', async () => {
  const calls = [];
  const hooks = (id) => ({
    start: async ({ db }) => calls.push(`start ${id} ${db}`),
    stop: async () => calls.push(`stop ${id}`),
  });
  const registry = createRegistry();
  registry.register({ id: 'first', name: 'First', capabilities: { health }, ...hooks('first') });
  registry.register({ id: 'second', name: 'Second', capabilities: { health }, ...hooks('second') });
  registry.register({ id: 'off', name: 'Off', capabilities: { health }, ...hooks('off') });
  registry.enable('first');
  registry.enable('second');

  await registry.start('db');
  assert.deepEqual(calls, ['start first db', 'start second db']);
  await registry.stop();
  assert.deepEqual(calls.slice(2), ['stop second', 'stop first']);
  assert.throws(() => defineAdapter({ id: 'bad', name: 'Bad', capabilities: { health }, start: 'now' }), /start must be a function/);
});
