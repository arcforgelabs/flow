import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { assembleUsage, appTier, formatAge } from '../server/ui/xero-usage-model.js';
import { withXeroLane } from '../server/integrations/xero/governor.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, organisationAnswer, seedLab, xeroAnswer, xeroRuntime } from './support/xero.js';

// The Xero card's numbers, from synthetic call rows. No live Xero.

const NOW = Date.parse('2026-10-21T15:30:00.000Z');

test('a day limit of 1000 is Starter and 5000 is Core', () => {
  assert.equal(appTier(1000), 'Starter');
  assert.equal(appTier(4999), 'Starter');
  assert.equal(appTier(5000), 'Core');
  assert.equal(appTier(0), null);
});

test('a copy age reads as a short chip', () => {
  assert.equal(formatAge(new Date(NOW - 2 * 60_000).toISOString(), NOW), '2 min');
  assert.equal(formatAge(new Date(NOW - 3 * 3_600_000).toISOString(), NOW), '3 h');
  assert.equal(formatAge(null, NOW), null);
});

test('usage groups synthetic calls by lane and hour, and suggests a higher tier after several warnings', () => {
  const hour = (hour, lane, n) => ({ hour: `2026-10-21T${hour}:00:00.000Z`, lane, n });
  const usage = assembleUsage({
    now: NOW,
    warningFraction: 0.7,
    governor: { dayCount: 12, dayLimit: 10, dayLimitSource: 'setting', observedDayRemaining: 0 },
    hourRows: [hour('09', 'writes', 4), hour('09', 'sync', 2), hour('14', 'reads', 3), hour('14', 'other', 1)],
    dayRows: [
      { day: '2026-10-19', n: 8 },
      { day: '2026-10-20', n: 9 },
      { day: '2026-10-21', n: 10 },
    ],
    taskRows: [{ task: 'Invoices', n: 7 }, { task: 'Payments', n: 3 }],
    limitRows: [{ at: '2026-10-21T14:05:00.000Z', problem: 'MinuteLimit', lane: 'reads', task: 'Invoices' }],
  });
  assert.equal(usage.dayLimit, 10);
  assert.equal(usage.left, 0);
  assert.equal(usage.used, 12, 'the governor count wins when it is ahead of the log');
  assert.equal(usage.tier, 'Starter');
  assert.equal(usage.warning, true);
  assert.deepEqual(usage.lanes, { writes: 4, sync: 2, reads: 3, other: 1 });
  assert.equal(usage.hours[9].writes, 4);
  assert.equal(usage.hours[9].sync, 2);
  assert.equal(usage.hours[14].reads, 3);
  assert.equal(usage.hours.length, 24);
  assert.equal(usage.days.length, 7);
  assert.equal(usage.days.at(-1).total, 10);
  assert.equal(usage.warnedDays, 3);
  assert.equal(usage.suggestTier, true);
  assert.deepEqual(usage.tasks, [{ task: 'Invoices', calls: 7 }, { task: 'Payments', calls: 3 }]);
  assert.equal(usage.limited[0].problem, 'MinuteLimit');
  assert.equal(usage.limited[0].lane, 'reads');
});

describe('GET /api/xero/status usage', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let lab;
  let runtime;
  let replay;

  before(async () => {
    handle = await freshDatabase();
    replay = xeroRuntime([
      organisationAnswer(),
      xeroAnswer('Invoices', { Invoices: [] }, {
        status: 429,
        repeat: true,
        headers: { 'x-rate-limit-problem': 'MinuteLimit', 'retry-after': '0' },
      }),
    ], { XERO_DAY_LIMIT: '10', XERO_USAGE_WARNING_FRACTION: '0.7' });
    runtime = replay.runtime;
    const booted = await bootFlow(handle, { runtime, log: replay.log });
    app = booted.app;
    lab = await seedLab(handle, booted.clerk);
    await connectDirectly(handle, runtime, lab.organisation.id);
  });
  after(async () => handle?.close());

  test('a real call stores its lane, and a 429 stores the problem, without another kind of Xero write', async () => {
    const before = replay.fetch.calls.length;
    await withXeroLane('writes', async () => {
      const { client } = await runtime.clientFor(handle.db, lab.organisation.id);
      await client.getOrganisation();
    });
    await assert.rejects(
      withXeroLane('reads', async () => {
        const { client } = await runtime.clientFor(handle.db, lab.organisation.id);
        await client.listInvoicesByIds(['00000000-0000-4000-8000-0000000000b1']);
      }),
      (error) => error.code === 'xero_rate_limited',
    );
    const { rows } = await handle.db.execute(sql`select resource, lane, status_code, rate_limit_problem from xero_calls order by id`);
    assert.equal(rows[0].lane, 'writes');
    assert.equal(rows[0].resource, 'Organisation');
    assert.ok(rows.some((row) => row.status_code === 429 && row.lane === 'reads' && row.rate_limit_problem === 'MinuteLimit'));
    assert.equal(replay.fetch.calls.length, before + 1 + 2, 'the organisation read, then the 429 and its one retry');
  });

  test('status returns lanes by hour, the limit and what is left, and the last webhook, poll and nightly read', async () => {
    const org = lab.organisation.id;
    const tenant = '00000000-0000-4000-8000-0000000000a1';
    const midnight = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    // An hour that is not the current one, so the live calls above stay out of it.
    const quiet = (new Date().getUTCHours() + 5) % 24;
    const at = (offset, hour) => new Date(midnight + offset * 86_400_000 + hour * 3_600_000);
    const insert = (lane, resource, status, atTime, problem = null) => handle.db.execute(sql`
      insert into xero_calls (key, at, resource, request_path, status_code, lane, rate_limit_problem)
      values (${tenant}, ${atTime}, ${resource}, ${`/${resource}`}, ${status}, ${lane}, ${problem})`);
    await insert('writes', 'Invoices', 200, at(0, quiet));
    await insert('writes', 'Invoices', 200, at(0, quiet));
    await insert('sync', 'Invoices', 200, at(0, (quiet + 1) % 24));
    await insert('reads', 'Payments', 200, at(0, (quiet + 2) % 24));
    await insert('other', 'Contacts', 200, at(0, (quiet + 2) % 24));
    await insert('sync', 'Invoices', 429, at(0, (quiet + 3) % 24), 'DayLimit');
    // Eight calls on each of two earlier days, against a limit of 10: both pass 70%.
    for (const offset of [-1, -2]) {
      for (let i = 0; i < 8; i += 1) await insert('sync', 'Invoices', 200, at(offset, 12));
    }
    const webhookAt = at(0, quiet);
    const pollAt = new Date(webhookAt.getTime() - 60_000);
    const nightlyAt = at(-1, 2);
    const refreshedAt = at(0, 1);
    await handle.db.execute(sql`insert into xero_webhook_events (organisation_id, resource, resource_id, source, received_at, read_at)
      values (${org}, 'invoices', 'inv-1', 'webhook', ${webhookAt}, ${webhookAt})`);
    await handle.db.execute(sql`insert into xero_mirror_cursors (organisation_id, resource, last_read_at)
      values (${org}, 'invoices', ${pollAt})`);
    await handle.db.execute(sql`insert into xero_daily_checks (organisation_id, last_finished_at)
      values (${org}, ${nightlyAt})`);
    await handle.db.execute(sql`update xero_connections set refreshed_at = ${refreshedAt} where organisation_id = ${org}`);

    const callsBefore = replay.fetch.calls.length;
    const res = await request(app, `/api/xero/status?organisationId=${org}`, { token: lab.staffToken });
    assert.equal(res.status, 200, res.text);
    assert.equal(replay.fetch.calls.length, callsBefore, 'status makes no Xero call');
    const { usage, freshness } = res.body;
    assert.equal(usage.dayLimit, 10);
    assert.equal(usage.tier, 'Starter');
    assert.equal(typeof usage.left, 'number');
    assert.ok(usage.left >= 0);
    const bucket = usage.hours.find((hour) => hour.hour.startsWith(at(0, quiet).toISOString().slice(0, 13)));
    assert.equal(bucket.writes, 2);
    assert.ok(usage.lanes.sync >= 1);
    assert.equal(usage.suggestTier, true);
    assert.ok(usage.limited.some((row) => row.problem === 'DayLimit' && row.lane === 'sync'));
    assert.ok(usage.limited.some((row) => row.problem === 'MinuteLimit' && row.lane === 'reads'));
    assert.ok(usage.tasks.some((task) => task.task === 'Invoices' && task.calls >= 2));
    assert.equal(freshness.webhookAt, webhookAt.toISOString());
    assert.equal(freshness.pollAt, pollAt.toISOString());
    assert.equal(freshness.nightlyAt, nightlyAt.toISOString());
    assert.equal(freshness.tokenRefreshedAt, refreshedAt.toISOString());
    assert.equal(freshness.copyAt, webhookAt.toISOString());
    assert.doesNotMatch(res.text, /synthetic-/);
  });
});
