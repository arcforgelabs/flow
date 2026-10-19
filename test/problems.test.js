import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { buildLabel, createErrorRecorder, errorFingerprint, recordError, redact } from '../server/core/problems.js';
import { createRegistry } from '../server/integrations/port.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Problems (docs/PROBLEMS.md): reports and the error log, kept in the
// installation's own database. Synthetic data only (CONTRIBUTING.md).
const OWNER = 'owner@example.test';
const ADMIN = 'admin@example.test';
const STAFF = 'staff@example.test';
const quiet = { info() {}, warn() {}, error() {} };
const MISSING = '00000000-0000-4000-8000-000000000000';

test('redact takes credentials out of an error message', () => {
  const text = redact('GET https://user:hunter2@example.test/x failed: Authorization Bearer abc.def; key=s3cr3t sk_live_abcdef123 '
    + 'A'.repeat(48));
  assert.doesNotMatch(text, /hunter2|abc\.def|s3cr3t|sk_live_abcdef123|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/);
  assert.match(text, /Bearer \[redacted\]/);
  assert.match(text, /key=\[redacted\]/);
});

test('errors that differ only in ids and numbers share a fingerprint', () => {
  const a = errorFingerprint('seazona', 'order 1234 failed (status 404) for 3f2c1b9a-1111-4222-8333-944445555666');
  const b = errorFingerprint('seazona', 'order 98 failed (status 404) for 0a0b0c0d-1111-4222-8333-944445555666');
  assert.equal(a, b);
  assert.notEqual(a, errorFingerprint('xero', 'order 98 failed (status 404) for 0a0b0c0d-1111-4222-8333-944445555666'));
  assert.notEqual(a, errorFingerprint('seazona', 'order 98 timed out'));
});

test('the build label is the release, else the short commit', () => {
  assert.equal(buildLabel({ release: 'v2026.10.26', revision: 'abc' }), 'v2026.10.26');
  assert.equal(buildLabel({ release: null, revision: '0123456789abcdef' }), '0123456789ab');
  assert.equal(buildLabel(null), null);
});

test('the error recorder passes every line on and stores at most its limit each minute', async () => {
  const lines = [];
  const inserted = [];
  // Just enough of drizzle's insert chain for recordError.
  const db = {
    insert: () => ({
      values: (row) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            inserted.push(row);
            return [row];
          },
        }),
      }),
    }),
  };
  let clock = 0;
  const recorder = createErrorRecorder({ db, log: { error: (line) => lines.push(line), warn() {}, info() {} }, limitPerMinute: 2, now: () => clock });
  recorder.error('[seazona] read failed');
  recorder.error('[seazona] read failed');
  recorder.error('[seazona] read failed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lines.length, 3);
  assert.equal(inserted.length, 2);
  assert.equal(inserted[0].source, 'seazona');
  clock = 61_000;
  recorder.error('no tag here');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inserted.length, 3);
  assert.equal(inserted[2].source, 'server');
});

test('a failed write to the error log is not stored and does not throw', async () => {
  const warnings = [];
  const db = { insert: () => { throw new Error('database is away'); } };
  const recorder = createErrorRecorder({ db, log: { error() {}, info() {}, warn: (line) => warnings.push(line) } });
  assert.doesNotThrow(() => recorder.error('[x] one'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warnings.length, 1);
});

describe('problems API', { skip: skipWithoutDatabase }, () => {
  let handle;
  let clerk;
  let app;
  let ownerToken;
  let adminToken;
  let staffToken;
  const logged = [];

  before(async () => {
    handle = await freshDatabase();
    clerk = fakeClerk();
    const owner = await seedFirstOwner(handle.db, OWNER);
    await invitePerson(handle.db, { email: ADMIN, role: 'admin', invitedBy: owner.id });
    await invitePerson(handle.db, { email: STAFF, role: 'staff', invitedBy: owner.id });
    ownerToken = clerk.signIn(clerk.addUser({ email: OWNER, google: true, password: false }));
    adminToken = clerk.signIn(clerk.addUser({ email: ADMIN }));
    staffToken = clerk.signIn(clerk.addUser({ email: STAFF }));

    // An integration whose one route fails, to reach the app's last error handler.
    const integrations = createRegistry({ log: quiet, env: {} });
    integrations.register({
      id: 'broken',
      name: 'Broken',
      capabilities: { health: async () => ({ ok: true }) },
      routes: () => express.Router().get('/boom', () => { throw new Error('boom 42'); }),
    });
    integrations.enable('broken');
    await integrations.start(handle.db);

    const log = createErrorRecorder({ db: handle.db, log: { info() {}, warn() {}, error: (line) => logged.push(line) } });
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    app = createApp({
      database: handle, auth: { settings, clerk, personAuth }, integrations, log,
      build: { release: 'v2026.10.26', revision: 'abc' },
    });
  });

  after(async () => handle?.close());

  const call = (path, token, options = {}) => request(app, `/api/problems${path}`, { token, ...options });

  test('every route needs a signed-in person', async () => {
    assert.equal((await call('/reports', null, { method: 'POST', body: { message: 'x' } })).status, 401);
    assert.equal((await call('/reports', null)).status, 401);
  });

  test('anyone signed in reports a problem; Flow adds who, the browser and the build', async () => {
    const res = await call('/reports', staffToken, {
      method: 'POST', body: { message: 'The invoice total looks wrong.', page: '/invoices' }, headers: { 'User-Agent': 'TestBrowser/1' },
    });
    assert.equal(res.status, 201);
    const list = await call('/reports', ownerToken);
    assert.equal(list.status, 200);
    const [report] = list.body.reports;
    assert.equal(report.message, 'The invoice total looks wrong.');
    assert.equal(report.page, '/invoices');
    assert.equal(report.reporterEmail, STAFF);
    assert.equal(report.userAgent, 'TestBrowser/1');
    assert.equal(report.build, 'v2026.10.26');
    assert.equal(report.status, 'new');
    assert.equal(list.body.counts.new, 1);
  });

  test('a report needs words, and not too many', async () => {
    assert.equal((await call('/reports', staffToken, { method: 'POST', body: { message: '   ' } })).status, 400);
    assert.equal((await call('/reports', staffToken, { method: 'POST', body: { message: 'x'.repeat(4001) } })).status, 400);
  });

  test('only owners and admins read and triage', async () => {
    assert.equal((await call('/reports', staffToken)).status, 403);
    assert.equal((await call('/errors', staffToken)).status, 403);
    const { body } = await call('/reports', adminToken);
    const id = body.reports[0].id;
    assert.equal((await call(`/reports/${id}`, staffToken, { method: 'PATCH', body: { status: 'closed' } })).status, 403);
    const seen = await call(`/reports/${id}`, adminToken, { method: 'PATCH', body: { status: 'seen' } });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.report.status, 'seen');
    assert.equal((await call('/reports?status=new', adminToken)).body.reports.length, 0);
    assert.equal((await call('/reports?status=seen', adminToken)).body.reports.length, 1);
    assert.equal((await call(`/reports/${id}`, adminToken, { method: 'PATCH', body: { status: 'gone' } })).status, 400);
    assert.equal((await call(`/reports/${MISSING}`, adminToken, { method: 'PATCH', body: { status: 'seen' } })).status, 404);
    assert.equal((await call('/reports?status=gone', adminToken)).status, 400);
  });

  test('a repeat error adds to one row, and a closed error that comes back is new', async () => {
    await recordError(handle.db, { source: 'seazona', message: '[seazona] order 17 failed: 404' });
    await recordError(handle.db, { source: 'seazona', message: '[seazona] order 18 failed: 404' });
    let { body } = await call('/errors', ownerToken);
    let row = body.errors.find((e) => e.source === 'seazona');
    assert.equal(row.count, 2);
    assert.equal(row.message, '[seazona] order 18 failed: 404');
    assert.equal((await call(`/errors/${row.id}`, ownerToken, { method: 'PATCH', body: { status: 'closed' } })).body.error.status, 'closed');
    await recordError(handle.db, { source: 'seazona', message: '[seazona] order 19 failed: 404' });
    ({ body } = await call('/errors', ownerToken));
    row = body.errors.find((e) => e.source === 'seazona');
    assert.equal(row.status, 'new');
    assert.equal(row.count, 3);
  });

  test('a server fault no route answered is logged, kept in the error log and answered without detail', async () => {
    const res = await request(app, '/api/broken/boom', { token: ownerToken });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { ok: false, code: 'internal', error: 'Something went wrong.' });
    assert.ok(logged.some((line) => line === '[http] boom 42'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { body } = await call('/errors', ownerToken);
    const row = body.errors.find((e) => e.source === 'http');
    assert.equal(row.message, '[http] boom 42');
  });
});
