import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

async function getHealth(app) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return { res, body: await res.json() };
  } finally {
    server.close();
  }
}

test('GET /health answers ok without exposing the framework', async () => {
  const { res, body } = await getHealth(createApp({ revision: 'abc123' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.deepEqual(body, { ok: true, service: 'flow', revision: 'abc123', database: null });
});

test('GET /health answers 503 when the database does not answer', async () => {
  const database = { pool: { query: async () => { throw new Error('down'); } } };
  const { res, body } = await getHealth(createApp({ revision: 'abc123', database }));
  assert.equal(res.status, 503);
  assert.deepEqual(body, { ok: false, service: 'flow', revision: 'abc123', database: false });
});
