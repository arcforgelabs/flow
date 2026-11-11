import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import pg from 'pg';
import { createTracing, traceQueries } from '../server/core/tracing.js';
import { skipWithoutDatabase, testDatabaseUrl } from './support/db.js';

// Synthetic data only. Trace receipts stay in this process.
test('spans follow tracer changes and send work only to the first active tracer', async () => {
  const receipts = [];
  const adapter = (id) => ({ capabilities: {
    traceSpan: (_span, work) => { receipts.push(id); return work(); },
  } });
  const first = adapter('first');
  const second = adapter('second');
  let active = [];
  const tracing = createTracing({ tracers: () => active });
  let runs = 0;
  const result = { ok: true };
  for (const tracers of [[], [first, second], [second, first], []]) {
    active = tracers;
    const pending = Promise.resolve(result);
    assert.equal(await tracing.span('synthetic work', 'task', () => { runs++; return pending; }), result);
  }
  assert.equal(runs, 4);
  assert.deepEqual(receipts, ['first', 'second']);
});

test('tracing preserves thrown errors and rejected work with tracing on or off', async () => {
  const adapter = { capabilities: { traceSpan: (_span, work) => work() } };
  for (const active of [[], [adapter]]) {
    const tracing = createTracing({ tracers: () => active });
    const failure = new Error('synthetic failure');
    let runs = 0;
    assert.throws(() => tracing.span('throw', 'task', () => { runs++; throw failure; }), (error) => error === failure);
    await assert.rejects(tracing.span('reject', 'task', async () => { runs++; throw failure; }), (error) => error === failure);
    assert.equal(runs, 2);
  }
});

test('a request keeps its starting tracer until the response finishes', { timeout: 5000 }, async (t) => {
  const names = [];
  const adapter = (id) => ({ capabilities: {
    traceRequest: () => (name) => names.push([id, name]),
  } });
  const first = adapter('first');
  const second = adapter('second');
  let active = [];
  let entered;
  let finish;
  const app = express();
  const tracing = createTracing({ tracers: () => active });
  app.use(tracing.requests());
  app.get('/jobs/:id', async (_req, res) => {
    entered.resolve();
    await finish.promise;
    res.send('done');
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/jobs/123?q=synthetic`;
  const request = async (changeBeforeFinish) => {
    entered = Promise.withResolvers();
    finish = Promise.withResolvers();
    const response = fetch(url);
    await entered.promise;
    try {
      changeBeforeFinish();
    } finally {
      finish.resolve();
    }
    assert.equal(await (await response).text(), 'done');
  };

  // Enabling tracing cannot attach a trace to a request that already started.
  await request(() => { active = [first, second]; });
  assert.deepEqual(names, []);
  await request(() => {
    assert.deepEqual(names, [], 'the route name waits for the response to finish');
    active = [second, first];
  });
  assert.deepEqual(names, [['first', 'GET /jobs/:id']]);
  await request(() => { active = []; });
  assert.deepEqual(names, [['first', 'GET /jobs/:id'], ['second', 'GET /jobs/:id']]);
  await request(() => {});
  assert.equal(names.length, 2);
});

test('query tracing preserves PostgreSQL results, callbacks and transaction recovery', { skip: skipWithoutDatabase, timeout: 10000 }, async (t) => {
  const spans = [];
  const tracing = createTracing({ tracers: () => [{ capabilities: {
    traceSpan: (span, work) => { spans.push(span); return work(); },
  } }] });
  const pool = traceQueries(new pg.Pool({ connectionString: testDatabaseUrl, max: 1 }), tracing);
  t.after(() => pool.end());

  // Use the real pool: its internal callback query must not add a second span.
  const result = await pool.query({
    text: "SELECT $1::text AS label, 'synthetic ''quote'''::text AS literal, 42::int AS amount",
    values: ['synthetic parameter'],
    rowMode: 'array',
  });
  assert.deepEqual(result.rows, [['synthetic parameter', "synthetic 'quote'", 42]]);
  assert.equal(spans.length, 1);

  const callbackResult = await new Promise((resolve, reject) => {
    pool.query('SELECT $1::int AS amount', [7], (error, rows) => error ? reject(error) : resolve(rows));
  });
  assert.deepEqual(callbackResult.rows, [{ amount: 7 }]);
  assert.equal(spans.length, 1, 'callback queries keep the driver contract without another span');
  await assert.rejects(pool.query('SELECT 1 / 0'), { code: '22012' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(client.query('SELECT 1 / 0'), { code: '22012' });
    await assert.rejects(client.query('SELECT 1'), { code: '25P02' });
    await client.query('ROLLBACK');
    const recovered = await client.query({ text: 'SELECT $1::int AS amount', values: [9] });
    assert.deepEqual(recovered.rows, [{ amount: 9 }]);
  } finally {
    client.release();
  }
  assert.deepEqual(spans.map(({ name }) => name), [
    'SELECT $1::text AS label, ?::text AS literal, ?::int AS amount',
    'SELECT ? / ?', 'BEGIN', 'SELECT ? / ?', 'SELECT ?', 'ROLLBACK', 'SELECT $1::int AS amount',
  ]);
});
