import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { createPersonAuth } from '../server/auth/session.js';
import { fakeClerk, TEST_PUBLISHABLE_KEY } from './support/clerk.js';

// Every sign-in and auth route is rate limited per client (CodeQL alert 4,
// js/missing-rate-limiting on the sign-in page). Clients are told apart by
// X-Forwarded-For behind one trusted proxy, as on Replit.
const CLERK_PATH = '/api/__clerk';

function signInApp(limits) {
  const clerk = fakeClerk();
  const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: CLERK_PATH }, publicSignUp: false };
  const clerkProxy = { path: CLERK_PATH, handler: (_req, res) => res.json({ ok: true, from: 'clerk' }) };
  const personAuth = createPersonAuth({ db: {}, clerk, log: { info() {}, warn() {}, error() {} } });
  return createApp({ auth: { settings, clerk, personAuth, clerkProxy }, trustProxy: 1, log: { error() {} }, ...limits });
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    return await fn((path, client) => fetch(`${base}${path}`, { redirect: 'manual', headers: { 'X-Forwarded-For': client } }));
  } finally {
    server.close();
  }
}

test('the sign-in page, its redirect and its config share one limit per client', async () => {
  await withServer(signInApp({ signInRateLimitPerMinute: 3 }), async (get) => {
    const statuses = [];
    for (const path of ['/', '/sign-in', '/api/auth/config', '/sign-in']) statuses.push((await get(path, '192.0.2.10')).status);
    assert.deepEqual(statuses, [302, 200, 200, 429]);

    const limited = await get('/api/auth/config', '192.0.2.10');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0, 'a limited client is told when to retry');
    assert.deepEqual(await limited.json(), { ok: false, code: 'rate_limited', error: 'Too many requests. Wait and try again.' });

    assert.equal((await get('/sign-in', '192.0.2.20')).status, 200, 'another client keeps its own count');
  });
});

test("Clerk's proxied Frontend API has its own, higher limit", async () => {
  await withServer(signInApp({ signInRateLimitPerMinute: 1, clerkProxyRateLimitPerMinute: 3 }), async (get) => {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await get(`${CLERK_PATH}/v1/client`, '192.0.2.30')).status);
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    assert.equal((await get('/sign-in', '192.0.2.30')).status, 200, 'the proxy does not use up the sign-in limit');
  });
});

test('signed-in routes sit under the /api limit', async () => {
  await withServer(signInApp({ rateLimitPerMinute: 2 }), async (get) => {
    const statuses = [];
    for (const path of ['/api/me', '/api/people', '/api/me']) statuses.push((await get(path, '192.0.2.40')).status);
    assert.deepEqual(statuses, [401, 401, 429]);
  });
});

test('the limits are sized for a small lab by default', async () => {
  await withServer(signInApp({}), async (get) => {
    for (let i = 0; i < 30; i += 1) assert.equal((await get('/sign-in', '192.0.2.50')).status, 200);
    assert.equal((await get('/sign-in', '192.0.2.50')).status, 429);
  });
});
