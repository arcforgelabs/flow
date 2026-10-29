import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { clerkFrontendApiProxy } from '@clerk/backend/proxy';
import { createApp } from '../server/app.js';
import { createClerkProxy } from '../server/auth/clerk.js';
import { resolveTrustProxy } from '../server/core/host.js';
import { TEST_PUBLISHABLE_KEY } from './support/clerk.js';

const PROXY_PATH = '/api/__clerk';

async function listen(server, t) {
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

// Synthetic addresses and a local receiver: no Clerk account or external calls.
test('Clerk receives only the client address within the trusted proxy hops', async (t) => {
  const upstream = await listen(createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ip: req.headers['x-forwarded-for'], timezone: new URLSearchParams(body).get('timezone') }));
  }), t);
  const cases = [
    { name: 'direct install ignores client headers', env: {}, expected: '127.0.0.1' },
    { name: 'one proxy outside Replit', env: { FLOW_TRUST_PROXY_HOPS: '1' }, expected: '192.0.2.10' },
    { name: 'two proxies outside Replit', env: { FLOW_TRUST_PROXY_HOPS: '2' }, xff: '198.51.100.99, 192.0.2.10, 203.0.113.20', expected: '192.0.2.10' },
    { name: 'Replit workspace keeps one trusted hop', env: { REPL_ID: 'synthetic' }, expected: '192.0.2.10' },
    { name: 'Replit deployment keeps one trusted hop', env: { REPLIT_DEPLOYMENT: '1' }, expected: '192.0.2.10' },
    { name: 'explicit zero overrides Replit', env: { REPL_ID: 'synthetic', FLOW_TRUST_PROXY_HOPS: '0' }, expected: '127.0.0.1' },
    { name: 'alternate headers cannot override Express', env: { REPL_ID: 'synthetic' }, expected: '192.0.2.10', extra: { 'CF-Connecting-IP': '198.51.100.98', 'X-Real-IP': '198.51.100.97' } },
    { name: 'X-Real-IP alone cannot override Express', env: { REPL_ID: 'synthetic' }, expected: '192.0.2.10', extra: { 'X-Real-IP': '198.51.100.97' } },
  ];
  for (const { name, env, expected, xff = '198.51.100.99, 192.0.2.10', extra = {} } of cases) {
    await t.test(name, async (t) => {
      const handler = createClerkProxy({
        proxyPath: PROXY_PATH,
        publishableKey: TEST_PUBLISHABLE_KEY,
        secretKey: 'sk_test_synthetic',
        proxy: (request, options) => clerkFrontendApiProxy(request, { ...options, fapiUrl: upstream }),
      });
      const app = createApp({
        trustProxy: resolveTrustProxy(env),
        auth: { settings: { mode: 'off' }, clerkProxy: { path: PROXY_PATH, handler } },
      });
      const base = await listen(createServer(app), t);
      const response = await fetch(`${base}${PROXY_PATH}/v1/client/sign_ins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(xff ? { 'X-Forwarded-For': xff } : {}), ...extra },
        body: new URLSearchParams({ timezone: 'Australia/Adelaide' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ip: expected, timezone: 'Australia/Adelaide' });
    });
  }
});

test('invalid proxy hop settings stop startup without exposing their value', () => {
  for (const value of ['true', '-1', '1.5', '1e2', '9007199254740992', 'invalid-sensitive-value']) {
    assert.throws(() => resolveTrustProxy({ FLOW_TRUST_PROXY_HOPS: value }), {
      message: 'FLOW_TRUST_PROXY_HOPS must be a non-negative safe integer',
    });
  }
});
