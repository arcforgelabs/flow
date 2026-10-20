import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { actionCooldownMs, actionOutcome, createActionGuard } from '../server/integrations/call-guard.js';
import { INVOICING_ACTIONS } from '../server/api/invoicing.js';
import { XERO_ACTIONS } from '../server/integrations/xero/routes.js';

// A person's button press that calls Xero or Seazona must not be repeatable
// at will: each press spends the provider's rate limit. The action guard
// makes a press wait (429 with the wait), backs off after a failure, and
// keeps one budget per integration.

const ORG = '00000000-0000-4000-8000-0000000000b1';

function guardedApp(guard, { answers = [], key } = {}) {
  const app = express();
  app.use(express.json());
  let gate = null;
  app.post('/act{/:id}', guard.route('press', key ? { key } : {}), async (req, res) => {
    if (gate) await gate;
    const answer = answers.shift() ?? { status: 200 };
    if (answer.retryAfter) res.set('Retry-After', String(answer.retryAfter));
    res.status(answer.status).json({ ok: answer.status < 400 });
  });
  app.post('/other', guard.route('other'), (_req, res) => res.json({ ok: true }));
  return { app, hold: (promise) => { gate = promise; } };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    return await fn((path, body = { organisationId: ORG }) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));
  } finally {
    server.close();
  }
}

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, pass: (ms) => { t += ms; } };
};

test('a press too soon waits, and the wait is in the answer and its header', async () => {
  const time = clock();
  const guard = createActionGuard({ integration: 'example', actions: { press: { cooldownMs: 60_000 }, other: { cooldownMs: 60_000 } }, now: time.now });
  const { app } = guardedApp(guard);
  await withServer(app, async (post) => {
    const first = await post('/act');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('flow-cooldown-ms'), '60000', 'a good run says its wait');

    const again = await post('/act');
    assert.equal(again.status, 429);
    assert.equal(again.headers.get('retry-after'), '60');
    const body = await again.json();
    assert.equal(body.code, 'action_cooldown');
    assert.equal(body.retryAfterMs, 60_000);
    assert.match(body.error, /Try again in 60 seconds/);

    assert.equal((await post('/other')).status, 200, 'another action has its own wait');
    assert.equal((await post('/act', { organisationId: '00000000-0000-4000-8000-0000000000b2' })).status, 200, 'another organisation has its own wait');

    time.pass(60_000);
    assert.equal((await post('/act')).status, 200, 'after the wait, the press runs');
  });
});

test('a second press while the first runs is refused', async () => {
  const guard = createActionGuard({ integration: 'example', actions: { press: { cooldownMs: 0 }, other: {} } });
  const { app, hold } = guardedApp(guard);
  let release;
  hold(new Promise((resolve) => { release = resolve; }));
  await withServer(app, async (post) => {
    const first = post('/act');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await post('/act');
    assert.equal(second.status, 429);
    assert.equal((await second.json()).code, 'action_running');
    release();
    assert.equal((await first).status, 200);
    assert.equal((await post('/act')).status, 200, 'with no cooldown, the next press runs once the first ends');
  });
});

test('a failed run backs off, longer each time, and a good run resets it', async () => {
  const time = clock();
  const guard = createActionGuard({ integration: 'example', actions: { press: { cooldownMs: 10_000, maxCooldownMs: 60_000 }, other: {} }, now: time.now });
  const { app } = guardedApp(guard, { answers: [{ status: 502 }, { status: 502 }, { status: 503, retryAfter: 300 }, { status: 200 }] });
  await withServer(app, async (post) => {
    assert.equal((await post('/act')).status, 502);
    assert.equal((await (await post('/act')).json()).retryAfterMs, 20_000, 'one failure: twice the cooldown');
    time.pass(20_000);
    assert.equal((await post('/act')).status, 502);
    assert.equal((await (await post('/act')).json()).retryAfterMs, 40_000, 'two failures: four times');
    time.pass(40_000);
    assert.equal((await post('/act')).status, 503);
    assert.equal((await (await post('/act')).json()).retryAfterMs, 300_000, "a stopped call's own wait wins when it is longer");
    time.pass(300_000);
    assert.equal((await post('/act')).status, 200);
    assert.equal((await (await post('/act')).json()).retryAfterMs, 10_000, 'a good run resets the backoff');
  });
});

test('a refused request costs nothing', async () => {
  const guard = createActionGuard({ integration: 'example', actions: { press: { cooldownMs: 60_000 }, other: {} }, policy: { budget: 1 } });
  const { app } = guardedApp(guard, { answers: [{ status: 400 }, { status: 200 }] });
  await withServer(app, async (post) => {
    assert.equal((await post('/act')).status, 400);
    assert.equal((await post('/act')).status, 200, 'no wait, and the budget is not spent');
  });
});

test('one budget covers every action of an integration', async () => {
  const time = clock();
  const guard = createActionGuard({ integration: 'example', actions: { press: { cooldownMs: 0 }, other: { cooldownMs: 0 } }, policy: { budget: 3, budgetMs: 60_000 }, now: time.now });
  const { app } = guardedApp(guard, { key: (req) => req.params.id });
  await withServer(app, async (post) => {
    assert.equal((await post('/act/a')).status, 200);
    time.pass(1_000);
    assert.equal((await post('/act/b')).status, 200);
    assert.equal((await post('/other')).status, 200);
    const spent = await post('/act/c');
    assert.equal(spent.status, 429);
    const body = await spent.json();
    assert.equal(body.code, 'action_budget');
    assert.equal(body.retryAfterMs, 59_000, 'the wait ends when the oldest run leaves the window');
    time.pass(59_000);
    assert.equal((await post('/act/c')).status, 200);
  });
});

test('a key gives each record its own wait', async () => {
  const guard = createActionGuard({ integration: 'example', actions: { press: { cooldownMs: 60_000 }, other: {} } });
  const { app } = guardedApp(guard, { key: (req) => req.params.id });
  await withServer(app, async (post) => {
    assert.equal((await post('/act/one')).status, 200);
    assert.equal((await post('/act/two')).status, 200);
    assert.equal((await post('/act/one')).status, 429);
  });
});

test('off lets every press through; an undeclared action is a mistake', () => {
  const guard = createActionGuard({ integration: 'example', actions: { press: {} }, off: true });
  let passed = false;
  guard.route('press')({}, {}, () => { passed = true; });
  assert.equal(passed, true);
  assert.throws(() => guard.route('missing'), /not a declared action/);
  assert.throws(() => createActionGuard({ integration: 'Bad Name' }), /adapter id/);
});

test('the rules', () => {
  assert.equal(actionOutcome(200), 'ok');
  assert.equal(actionOutcome(404), 'refused');
  assert.equal(actionOutcome(429), 'failed');
  assert.equal(actionOutcome(503), 'failed');
  assert.equal(actionCooldownMs(0, { cooldownMs: 0, maxCooldownMs: 60_000 }), 0);
  assert.equal(actionCooldownMs(1, { cooldownMs: 0, maxCooldownMs: 60_000 }), 10_000, 'an action with no cooldown still backs off after a failure');
  assert.equal(actionCooldownMs(20, { cooldownMs: 30_000, maxCooldownMs: 60_000 }), 60_000);
});

test('every button that calls Xero, and Check prices, has a wait', () => {
  assert.deepEqual(Object.keys(XERO_ACTIONS).sort(), ['mirror', 'obligationCheck', 'paymentsSync', 'push', 'recheck', 'sync']);
  assert.ok(XERO_ACTIONS.sync.cooldownMs >= 60_000, 'a full copy of contacts and items waits minutes');
  assert.ok(INVOICING_ACTIONS.priceCheck.cooldownMs > 0);
  for (const name of ['sendReady', 'sendAgain', 'draftJob']) assert.equal(INVOICING_ACTIONS[name].budget, false, `${name} works one record at a time`);
});
