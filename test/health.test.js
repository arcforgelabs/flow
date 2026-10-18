import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

test('GET /health answers ok without exposing the framework', async () => {
  const server = createApp({ revision: 'abc123' }).listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.deepEqual(await res.json(), { ok: true, service: 'flow', revision: 'abc123' });
  } finally {
    server.close();
  }
});
