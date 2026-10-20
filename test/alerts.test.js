import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { alertsFor, dismissAlert, integrationAlertsSource, priceDifferencesSource } from '../server/core/alerts.js';
import { createContact, createOrganisation } from '../server/core/directory.js';
import { createDraftInvoice } from '../server/core/invoices.js';
import { openReview, resolveReviewFor } from '../server/core/review.js';
import { guardAlerts } from '../server/integrations/call-guard.js';
import { createRegistry } from '../server/integrations/port.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Quiet alerts (issue 117, docs/ALERTS.md). Every lab, person and price here
// is made up.
const quiet = { info() {}, warn() {}, error() {} };

test('a guard makes an alert only for a stop that a person must clear', () => {
  assert.deepEqual(guardAlerts('Books', { circuit: 'open', haltedReason: null, stoppedResources: [] }), []);
  assert.deepEqual(guardAlerts('Books', { circuit: 'closed', failedToday: 50, dailyFailureBudget: 50, stoppedResources: [] }), []);
  const halted = guardAlerts('Books', { haltedReason: 'auth', haltedAt: '2026-10-01T00:00:00.000Z', stoppedResources: [] });
  assert.equal(halted.length, 1);
  assert.equal(halted[0].tone, 'danger');
  assert.match(halted[0].title, /^Books refused Flow\. Flow stopped all Books calls\. Check the connection, then connect again\.$/);
  const stopped = guardAlerts('Books', { stoppedResources: [{ resource: 'Payments', at: 't1' }] }, { fix: 'Save the settings.' });
  assert.deepEqual(stopped.map((a) => [a.id, a.members]), [['resources-stopped', ['Payments:t1']]]);
  assert.match(stopped[0].title, /for Payments\. Flow stopped those calls\. Save the settings\.$/);
});

describe('quiet alerts against PostgreSQL', { skip: skipWithoutDatabase }, () => {
  let handle;
  let lab;
  let practice;
  let owner;
  let staff;
  let app;
  let ownerToken;
  let staffToken;
  // What the fake accounting integration says only a person can clear.
  let booksAlerts = [];
  const books = {
    id: 'books', name: 'Books',
    capabilities: { health: async () => ({ ok: true }), alerts: async () => booksAlerts },
  };
  const call = (path, token, options = {}) => request(app, `/api/alerts${path}`, { token, ...options });

  before(async () => {
    handle = await freshDatabase();
    lab = await createOrganisation(handle.db, { name: 'Example Lab' });
    practice = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Example Practice' });
    const integrations = createRegistry({ log: quiet, env: {} });
    integrations.register(books);
    integrations.enable('books');
    await integrations.start(handle.db);
    const clerk = fakeClerk();
    owner = await seedFirstOwner(handle.db, 'owner@example.test');
    staff = await invitePerson(handle.db, { email: 'staff@example.test', role: 'staff', invitedBy: owner.id });
    ownerToken = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    staffToken = clerk.signIn(clerk.addUser({ email: 'staff@example.test' }));
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    app = createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations, log: quiet });
  });
  after(async () => handle?.close());

  test('nothing shows when nothing needs a person', async () => {
    for (const page of ['invoices', 'price-list', 'integrations']) {
      const res = await call(`?page=${page}`, ownerToken);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.alerts, [], page);
    }
    assert.equal((await call('?page=feed', ownerToken)).status, 400);
    assert.equal((await call('?page=invoices')).status, 401);
  });

  test('invoices with a problem make one alert; a dismiss hides it until a new one joins', async () => {
    const first = await createDraftInvoice(handle.db, lab.id, { contactId: practice.id, lines: [] });
    let res = await call('?page=invoices', ownerToken);
    assert.deepEqual(res.body.alerts, [{
      key: 'invoices:problems', tone: 'warn', title: '1 invoice has a problem.',
      action: { label: 'Open Problem', tab: 'problem' }, moneyAtRiskCents: first.totalCents, count: 1,
    }]);

    // Dismissed: hidden for the owner only.
    const dismissed = await call('/dismiss', ownerToken, { method: 'POST', body: { key: 'invoices:problems' } });
    assert.deepEqual(dismissed.body, { ok: true, dismissed: true });
    assert.deepEqual((await call('?page=invoices', ownerToken)).body.alerts, []);
    assert.equal((await call('?page=invoices', staffToken)).body.alerts.length, 1);

    // A second problem is new, so the alert shows again, about both.
    await createDraftInvoice(handle.db, lab.id, { contactId: practice.id, lines: [] });
    res = await call('?page=invoices', ownerToken);
    assert.equal(res.body.alerts[0].title, '2 invoices have a problem.');
    assert.equal(res.body.alerts[0].count, 2);
    assert.equal(res.body.alerts[0].members, undefined, 'members never leave the server');

    // An alert that is gone dismisses quietly; a key that names no page is refused.
    assert.deepEqual((await call('/dismiss', ownerToken, { method: 'POST', body: { key: 'price-list:differences' } })).body, { ok: true, dismissed: false });
    assert.equal((await call('/dismiss', ownerToken, { method: 'POST', body: { key: 'nowhere' } })).status, 400);
  });

  test('a price difference is an alert until its review item closes, and new evidence brings it back', async () => {
    const flowId = '00000000-0000-4000-8000-000000000117';
    const review = { kind: 'price_check', entity: 'price_item', flowId, systems: ['books'], evidence: { code: 'CRN', signature: 'a' }, moneyAtRiskCents: 2000 };
    await openReview(handle.db, lab.id, review);
    const sources = { 'price-list': [priceDifferencesSource(handle.db)] };
    const ownerPerson = { id: owner.id, role: 'owner' };
    let alerts = await alertsFor(handle.db, lab.id, ownerPerson, { page: 'price-list', sources });
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].title, /^1 code differs from a connected system\./);
    assert.equal(alerts[0].moneyAtRiskCents, 2000);

    await dismissAlert(handle.db, lab.id, ownerPerson, { key: 'price-list:differences', sources });
    // The same finding again does not bring it back.
    await openReview(handle.db, lab.id, review);
    assert.deepEqual(await alertsFor(handle.db, lab.id, ownerPerson, { page: 'price-list', sources }), []);
    // A changed finding does.
    await openReview(handle.db, lab.id, { ...review, evidence: { code: 'CRN', signature: 'b' } });
    alerts = await alertsFor(handle.db, lab.id, ownerPerson, { page: 'price-list', sources });
    assert.equal(alerts.length, 1);

    // Fixed at the source: gone for everyone.
    await resolveReviewFor(handle.db, lab.id, { kind: 'price_check', entity: 'price_item', flowId, resolution: 'agree', actor: 'test' });
    assert.deepEqual(await alertsFor(handle.db, lab.id, { id: staff.id, role: 'staff' }, { page: 'price-list', sources }), []);
  });

  test('an integration stop shows to owners and admins only, danger first', async () => {
    booksAlerts = [
      { id: 'calls-stopped', tone: 'danger', title: 'Books refused Flow.', members: ['halted:t1'] },
      { id: 'other', tone: 'warn', title: 'Books needs a look.', members: ['x'] },
    ];
    const res = await call('?page=integrations', ownerToken);
    assert.deepEqual(res.body.alerts.map((a) => [a.key, a.tone]), [['integrations:books:calls-stopped', 'danger'], ['integrations:books:other', 'warn']]);
    assert.deepEqual(res.body.alerts[0].action, { label: 'Open Books', href: '/integrations/books' });
    assert.deepEqual((await call('?page=integrations', staffToken)).body.alerts, []);
    // Staff cannot dismiss what they cannot see.
    assert.deepEqual((await call('/dismiss', staffToken, { method: 'POST', body: { key: 'integrations:books:calls-stopped' } })).body.dismissed, false);
    booksAlerts = [];
  });

  test('a source must say its page, tone and members', async () => {
    const bad = { integrations: [async () => [{ key: 'invoices:wrong', page: 'integrations', tone: 'warn', title: 'x', members: ['a'] }]] };
    await assert.rejects(alertsFor(handle.db, lab.id, { id: owner.id, role: 'owner' }, { page: 'integrations', sources: bad }), /must start with its page/);
    const noMembers = { integrations: [integrationAlertsSource(() => [{ id: 'books', name: 'Books', capabilities: { alerts: async () => [{ id: 'a', title: 'x', members: [] }] } }])] };
    await assert.rejects(alertsFor(handle.db, lab.id, { id: owner.id, role: 'owner' }, { page: 'integrations', sources: noMembers }), /needs members/);
  });
});
