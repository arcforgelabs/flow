import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { findPersonById, normaliseViews, seedFirstOwner, setPersonView } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { NAV_DEFAULT, NAV_LOCKED, navPinsFromViews, normaliseNavPins } from '../server/ui/nav-pins.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Synthetic people only (CONTRIBUTING.md).

test('with no pins saved, the sidebar is the one Flow ships', () => {
  assert.deepEqual(navPinsFromViews(null).pinned, [...NAV_DEFAULT]);
  assert.deepEqual(navPinsFromViews({}).pinned, [...NAV_DEFAULT]);
  assert.deepEqual(navPinsFromViews({ jobs: { group: 'stage' } }).pinned, [...NAV_DEFAULT]);
  assert.deepEqual(normaliseViews(null), {});
  assert.equal(normaliseViews({ jobs: { group: 'stage' } }).nav, undefined);
});

test('Jobs and Invoices cannot be unpinned, and unknown pages are dropped', () => {
  assert.deepEqual(normaliseNavPins({ pinned: [] }).pinned, [...NAV_LOCKED]);
  assert.deepEqual(normaliseNavPins({ pinned: ['automations'] }).pinned, ['jobs', 'invoices', 'automations']);
  assert.deepEqual(
    normaliseNavPins({ pinned: ['integrations', 'constructor', 'nope', 'rules', 'invoices'] }).pinned,
    ['jobs', 'invoices', 'integrations'],
  );
  assert.deepEqual(normaliseNavPins({ pinned: 'jobs' }).pinned, [...NAV_LOCKED]);
  assert.deepEqual(normaliseNavPins(null).pinned, [...NAV_LOCKED]);
  // A saved choice is what was saved, plus the pages that stay pinned.
  assert.deepEqual(navPinsFromViews({ nav: { pinned: ['custom-fields'] } }).pinned, ['jobs', 'invoices', 'custom-fields']);
});

describe('pin save and load follows the account', { skip: skipWithoutDatabase, concurrency: 1 }, () => {
  let handle;
  let app;
  let token;

  before(async () => {
    handle = await freshDatabase();
    const owner = await seedFirstOwner(handle.db, 'owner@example.test');
    const clerk = fakeClerk();
    const userId = clerk.addUser({ email: 'owner@example.test', google: true, password: false });
    token = clerk.signIn(userId);
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null }, publicSignUp: false, signUpDomains: [] };
    const personAuth = createPersonAuth({
      db: handle.db,
      clerk,
      publicSignUp: false,
      signUpDomains: [],
      ownerGoogleDomains: ['example.test'],
      ownerMfaMaxAgeMinutes: 60,
      log: { info() {}, warn() {}, error() {} },
    });
    app = createApp({
      database: handle,
      auth: { settings, clerk, personAuth },
      updates: { status: async () => ({ enabled: false }) },
      log: { error() {} },
    });
    assert.ok(owner.id);
  });

  after(async () => handle?.close());

  test('GET /api/me loads the default pins, and PUT /api/me/views/nav saves a choice', async () => {
    const first = await request(app, '/api/me', { token });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.views.nav.pinned, [...NAV_DEFAULT]);

    const saved = await request(app, '/api/me/views/nav', {
      token, method: 'PUT', body: { pinned: ['automations', 'custom-fields', 'nope', 'constructor'] },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.view.pinned, ['jobs', 'invoices', 'automations', 'custom-fields']);

    const loaded = await request(app, '/api/me', { token });
    assert.deepEqual(loaded.body.views.nav.pinned, ['jobs', 'invoices', 'automations', 'custom-fields']);
  });

  test('a request to unpin Jobs or Invoices is ignored, and another page\'s view stays', async () => {
    const id = (await request(app, '/api/me', { token })).body.person.id;
    await setPersonView(handle.db, { id, page: 'jobs', view: { group: 'client' } });
    const saved = await request(app, '/api/me/views/nav', {
      token, method: 'PUT', body: { pinned: ['reconcile', 'price-list'] },
    });
    assert.deepEqual(saved.body.view.pinned, ['jobs', 'invoices', 'reconcile', 'price-list']);

    const views = normaliseViews((await findPersonById(handle.db, id)).views);
    assert.equal(views.jobs.group, 'client');
    assert.deepEqual(views.nav.pinned, ['jobs', 'invoices', 'reconcile', 'price-list']);
    const loaded = await request(app, '/api/me', { token });
    assert.equal(loaded.body.views.jobs.group, 'client');
    assert.deepEqual(loaded.body.views.nav.pinned, ['jobs', 'invoices', 'reconcile', 'price-list']);

    assert.equal((await request(app, '/api/me/views/nav', { method: 'PUT', body: { pinned: [] } })).status, 401);
  });
});
