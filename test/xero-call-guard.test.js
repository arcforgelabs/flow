import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { CallsStopped } from '../server/integrations/call-guard.js';
import { catalogueRetryMs, refreshStaleCatalogues } from '../server/integrations/xero/import.js';
import { mirrorXero } from '../server/integrations/xero/mirror.js';
import { createReplayFetch } from '../server/integrations/xero/replay.js';
import { createXeroRuntime } from '../server/integrations/xero/runtime.js';
import { resolveXeroSettings } from '../server/integrations/xero/settings.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, ORIGIN, quietLog, seedLab, TOKEN_KEY, tokenAnswer, xeroAnswer } from './support/xero.js';

// Xero calls through the call guard (issue #111). Xero is replayed with
// synthetic answers; each test counts the calls that reached "Xero".

function countedXero() {
  let replay = createReplayFetch([]);
  const clock = { at: Date.now() };
  const log = { lines: { info: [], warn: [], error: [] } };
  for (const level of ['info', 'warn', 'error']) log[level] = (line) => log.lines[level].push(String(line));
  const sent = [];
  const settings = resolveXeroSettings({ XERO_MODE: 'replay', XERO_TOKEN_KEY: TOKEN_KEY, FLOW_PUBLIC_ORIGIN: ORIGIN });
  const fetch = (url, init) => {
    sent.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
    return replay(url, init);
  };
  const runtime = createXeroRuntime({ settings, fetch, now: () => clock.at, log });
  return { runtime, log, clock, sent, script: (interactions) => { replay = createReplayFetch(interactions); } };
}

describe('Xero call guard', { skip: skipWithoutDatabase }, () => {
  let handle;
  let lab;
  let xero;

  before(async () => {
    handle = await freshDatabase();
    const booted = await bootFlow(handle, { runtime: countedXero().runtime, log: quietLog() });
    lab = await seedLab(handle, booted.clerk);
    await booted.integrations.stop?.();
  });
  after(async () => handle?.close());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate xero_call_guard, xero_calls, xero_sync_runs, xero_mirror_cursors`);
    xero = countedXero();
    await connectDirectly(handle, xero.runtime, lab.organisation.id);
  });

  const client = async () => (await xero.runtime.clientFor(handle.db, lab.organisation.id)).client;

  test('a refused token refresh makes one call, then none until a person connects again', async () => {
    xero.runtime.forget(lab.organisation.id);
    xero.script([tokenAnswer(1, { status: 400, body: { error: 'invalid_grant' } })]);
    const c = await client();
    await assert.rejects(c.listItems(), { code: 'xero_reconnect_needed' });
    assert.equal(xero.sent.length, 1);
    assert.equal(xero.log.lines.error.length, 1);
    for (let i = 0; i < 3; i += 1) await assert.rejects(c.listItems(), (error) => error instanceof CallsStopped && error.reason === 'halted');
    assert.equal(xero.sent.length, 1, 'no call reached Xero while halted');
    assert.equal(xero.log.lines.error.length, 1, 'reported once');
    await xero.runtime.guardFor(handle.db).resume();
    xero.script([tokenAnswer(2), xeroAnswer('Items', { Items: [] })]);
    assert.deepEqual(await c.listItems(), []);
  });

  test('a wrong client secret halts calls too', async () => {
    xero.runtime.forget(lab.organisation.id);
    xero.script([tokenAnswer(1, { status: 400, body: { error: 'invalid_client' } })]);
    const c = await client();
    await assert.rejects(c.listItems(), { code: 'xero_token_failed' });
    await assert.rejects(c.listItems(), (error) => error.reason === 'halted');
    assert.equal(xero.sent.length, 1);
  });

  test('a 401 that a fresh token does not clear stops that resource only', async () => {
    const refused = { status: 401, body: { Title: 'Unauthorized', Detail: 'AuthorizationUnsuccessful' } };
    xero.script([
      xeroAnswer('Payments', refused.body, { status: 401, repeat: true }),
      tokenAnswer(1),
      xeroAnswer('Items', { Items: [] }, { repeat: true }),
    ]);
    const c = await client();
    await assert.rejects(c.listPaymentsSince(new Date('2026-09-01T00:00:00Z')), { code: 'xero_unauthorized' });
    assert.deepEqual(xero.sent.filter((s) => s.includes('Payments')).length, 2, 'one try, one with a fresh token');
    const before = xero.sent.length;
    await assert.rejects(c.listPaymentsSince(new Date('2026-09-01T00:00:00Z')), (error) => error.reason === 'resource_stopped' && error.resource === 'Payments');
    assert.equal(xero.sent.length, before);
    assert.deepEqual(await c.listItems(), []);
    const status = await xero.runtime.guardFor(handle.db).status((await xero.runtime.clientFor(handle.db, lab.organisation.id)).connection.tenantId);
    assert.deepEqual(status.stoppedResources.map((r) => r.resource), ['Payments']);
    assert.equal(xero.log.lines.error.length, 1);
  });

  test('a stopped resource is probed again by itself, and a good probe starts it again', async () => {
    const refused = { Title: 'Unauthorized', Detail: 'AuthorizationUnsuccessful' };
    const since = new Date('2026-09-01T00:00:00Z');
    const paymentsSent = () => xero.sent.filter((s) => s.includes('Payments')).length;
    const hours = (n) => n * 60 * 60_000;
    xero.script([xeroAnswer('Payments', refused, { status: 401, repeat: true }), { ...tokenAnswer(1), repeat: true }]);
    const c = await client();
    await assert.rejects(c.listPaymentsSince(since), { code: 'xero_unauthorized' });
    assert.equal(paymentsSent(), 2);
    // Before the wait ends: no call.
    xero.clock.at += hours(5);
    await assert.rejects(c.listPaymentsSince(since), (error) => error.reason === 'resource_stopped' && error.retryAfterMs === hours(1));
    assert.equal(paymentsSent(), 2);
    // After 6 hours one probe goes; refused again, the next wait is 12 hours.
    xero.clock.at += hours(1);
    await assert.rejects(c.listPaymentsSince(since), { code: 'xero_unauthorized' });
    assert.equal(paymentsSent(), 4, 'one probe, one with a fresh token');
    assert.equal(xero.log.lines.error.length, 1, 'a refused probe is a warning, not a second report');
    assert.equal(xero.log.lines.warn.length, 1);
    xero.clock.at += hours(11);
    await assert.rejects(c.listPaymentsSince(since), (error) => error.reason === 'resource_stopped');
    assert.equal(paymentsSent(), 4);
    // A person connected again with the scope: the next probe succeeds.
    xero.script([xeroAnswer('Payments', { Payments: [] }, { repeat: true }), { ...tokenAnswer(2), repeat: true }]);
    xero.clock.at += hours(1);
    assert.deepEqual(await c.listPaymentsSince(since), []);
    const tenantId = (await xero.runtime.clientFor(handle.db, lab.organisation.id)).connection.tenantId;
    assert.deepEqual((await xero.runtime.guardFor(handle.db).status(tenantId)).stoppedResources, []);
    assert.deepEqual(await c.listPaymentsSince(since), []);
  });

  test('when every call fails, at most 5 go before the circuit opens', async () => {
    xero.script([xeroAnswer('Items', { Message: 'Down' }, { status: 503, repeat: true })]);
    const c = await client();
    for (let i = 0; i < 20; i += 1) await assert.rejects(c.listItems());
    assert.equal(xero.sent.length, 5);
    assert.equal(xero.log.lines.error.length, 1);
  });

  test('the history import skips a refused resource and reads the rest', async () => {
    xero.script([
      xeroAnswer('Invoices', { Invoices: [] }, { repeat: true }),
      xeroAnswer('CreditNotes', { CreditNotes: [] }, { repeat: true }),
      xeroAnswer('Payments', { Detail: 'AuthorizationUnsuccessful' }, { status: 401, repeat: true }),
      tokenAnswer(1),
    ]);
    // The first pass meets the refusal; the next skips payments with no call.
    await assert.rejects(mirrorXero(handle.db, xero.runtime, lab.organisation.id), { code: 'xero_unauthorized' });
    const sentBefore = xero.sent.filter((s) => s.includes('Payments')).length;
    const results = await mirrorXero(handle.db, xero.runtime, lab.organisation.id);
    assert.deepEqual(results.map((r) => [r.resource, r.stopped]), [['invoices', 'done'], ['credit_notes', 'done'], ['payments', 'refused']]);
    assert.equal(xero.sent.filter((s) => s.includes('Payments')).length, sentBefore);
  });

  test('a failing contacts and items read waits longer each time and is reported once', async () => {
    xero.script([
      xeroAnswer('Contacts', { Message: 'Bad request' }, { status: 400, query: { page: 1 }, repeat: true }),
      { ...tokenAnswer(1), repeat: true }, // the access token expires as the hours pass
    ]);
    // Flow stamps a run with the database clock: move each new run to this
    // test's clock.
    const tick = async () => {
      await refreshStaleCatalogues(handle.db, xero.runtime, { now: () => xero.clock.at, log: xero.log });
      await handle.db.execute(sql`update xero_sync_runs set started_at = ${new Date(xero.clock.at)}, finished_at = ${new Date(xero.clock.at)}
        where started_at > now() - interval '1 minute' and started_at <= now()`);
    };
    const wait = (failures) => { xero.clock.at += catalogueRetryMs(failures); };
    const contactCalls = () => xero.sent.filter((s) => s.endsWith('/Contacts')).length;
    await tick();
    assert.equal(contactCalls(), 1);
    await tick(); // within the hour: no call
    assert.equal(contactCalls(), 1);
    wait(1);
    await tick();
    assert.equal(contactCalls(), 2);
    wait(1);
    await tick(); // the second failure waits two hours
    assert.equal(contactCalls(), 2);
    wait(1);
    await tick();
    assert.equal(contactCalls(), 3);
    assert.equal(xero.log.lines.error.length, 1, 'the same failure again is a warning');
    assert.equal(xero.log.lines.warn.length, 2);
    assert.equal(catalogueRetryMs(10), 24 * 60 * 60_000);
  });
});
