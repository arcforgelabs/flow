import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner, updatePerson } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { resolveAgentKey } from '../server/auth/settings.js';
import { createOrganisation } from '../server/core/directory.js';
import { openReview } from '../server/core/review.js';
import { createRegistry } from '../server/integrations/port.js';
import { SeazonaApiError } from '../server/integrations/seazona/client.js';
import { createSeazonaRouter } from '../server/integrations/seazona/routes.js';
import { createXeroRouter } from '../server/integrations/xero/routes.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { skipWithoutDatabase } from './support/db.js';
import { freshSeazonaDatabase } from './support/seazona.js';

const quiet = { info() {}, warn() {}, error() {} };
const KEY = 'agent-key-for-tests-0123456789abcdef';
const DIGEST = createHash('sha256').update(KEY).digest('hex');

test('the agent key needs both settings, a SHA-256 digest and a plain email', () => {
  assert.equal(resolveAgentKey({}), null);
  assert.deepEqual(resolveAgentKey({ FLOW_AGENT_KEY_SHA256: DIGEST.toUpperCase(), FLOW_AGENT_EMAIL: 'Assistant@Example.test' }), { digest: DIGEST, email: 'assistant@example.test' });
  assert.throws(() => resolveAgentKey({ FLOW_AGENT_KEY_SHA256: DIGEST }), /set together/);
  assert.throws(() => resolveAgentKey({ FLOW_AGENT_EMAIL: 'assistant@example.test' }), /set together/);
  assert.throws(() => resolveAgentKey({ FLOW_AGENT_KEY_SHA256: KEY, FLOW_AGENT_EMAIL: 'assistant@example.test' }), /64 hex/);
});

describe('the agent key against PostgreSQL', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let owner;
  let agent;
  let personAuth;
  let organisationId;
  const asAgent = (path, options = {}) => request(app, path, { token: KEY, ...options });

  before(async () => {
    handle = await freshSeazonaDatabase();
    ({ id: organisationId } = await createOrganisation(handle.db, { name: 'Example Lab' }));
    owner = await seedFirstOwner(handle.db, 'owner@example.test');
    agent = await invitePerson(handle.db, { email: 'assistant@example.test', role: 'admin', invitedBy: owner.id });
    const clerk = fakeClerk();
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    personAuth = createPersonAuth({
      db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet,
      agentKey: { digest: DIGEST, email: 'assistant@example.test' },
    });
    app = createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations: createRegistry({ log: quiet, env: {} }), log: quiet });
  });

  after(async () => handle?.close());

  test('the key acts as its Flow person, inside that role', async () => {
    const me = await asAgent('/api/me');
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.person.email, 'assistant@example.test');
    const created = await asAgent('/api/invoicing/contacts', { method: 'POST', body: { kind: 'customer', name: 'Harbour Dental' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const rules = await asAgent('/api/invoicing/rules');
    assert.equal(rules.status, 200, JSON.stringify(rules.body));
  });

  test('the key runs the skill price steps: read, change a code, give a line its code', async () => {
    const made = await asAgent('/api/invoicing/price-items', { method: 'POST', body: { code: 'SET12', name: 'Set up 1-2 Teeth', unitAmountCents: 13000, taxCode: 'GST' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const changed = await asAgent(`/api/invoicing/price-items/${made.body.item.id}`, { method: 'PUT', body: { unitAmountCents: 13500 } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const list = await asAgent('/api/invoicing/price-list');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.items.find((i) => i.code === 'SET12').unitAmountCents, 13500);
    assert.equal((await asAgent('/api/invoicing/line-labels')).status, 200);
    const mapping = await asAgent('/api/invoicing/line-mappings', { method: 'POST', body: { kind: 'saved', label: 'Set up 1-2 Teeth', unitAmountCents: 13500, itemCode: 'SET12' } });
    assert.equal(mapping.status, 201, JSON.stringify(mapping.body));
  });

  test('the key reaches the Xero matching routes, but never connects or disconnects Xero', async () => {
    const xero = express().use('/api/xero', createXeroRouter({ db: handle.db, personAuth, runtime: { settings: { mode: 'demo' } }, log: quiet, buttonCooldowns: false }));
    // Past sign-in and role: the route itself answers (here, that the id is bad).
    const imported = await request(xero, '/api/xero/import?organisationId=not-an-id', { token: KEY });
    assert.equal(imported.status, 400, JSON.stringify(imported.body));
    assert.equal(imported.body.code, 'invalid');
    await updatePerson(handle.db, { id: agent.id, actorId: owner.id, role: 'owner' });
    const connect = await request(xero, '/api/xero/connect', { token: KEY, method: 'POST', body: { organisationId } });
    assert.equal(connect.status, 403, JSON.stringify(connect.body));
    await updatePerson(handle.db, { id: agent.id, actorId: owner.id, role: 'admin' });
  });

  test('the key opens only invoicing, Xero, the Seazona read and history, and /api/me', async () => {
    const fields = await asAgent('/api/custom-fields');
    assert.equal(fields.status, 403);
    assert.equal(fields.body.code, 'role_required');
  });

  test('the key reads the open review queue', async () => {
    const jobId = '00000000-0000-4000-8000-000000000001';
    await openReview(handle.db, organisationId, { kind: 'reconcile.day', entity: 'day', flowId: jobId, evidence: { day: '2026-11-10' }, moneyAtRiskCents: 4150 });
    const open = await asAgent('/api/invoicing/review');
    assert.equal(open.status, 200, JSON.stringify(open.body));
    assert.deepEqual(open.body.items.map((i) => [i.kind, i.evidence.day, i.moneyAtRiskCents]), [['reconcile.day', '2026-11-10', 4150]]);
    const other = await asAgent('/api/invoicing/review?kind=job.changed');
    assert.deepEqual(other.body.items, []);
    const bad = await asAgent('/api/invoicing/review?state=everything');
    assert.equal(bad.status, 400);
  });

  test('the key works the Seazona history import inside its role', async () => {
    const seazona = express().use('/api/seazona', createSeazonaRouter({ db: handle.db, personAuth, settings: { sync: { orderLookbackDays: 7 } }, log: quiet }));
    const history = await request(seazona, '/api/seazona/history', { token: KEY });
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.ok(Array.isArray(history.body.batches));
    const ledger = await request(seazona, '/api/seazona/history/ledger?state=needs_person', { token: KEY });
    assert.equal(ledger.status, 200, JSON.stringify(ledger.body));
    // A manager action: past sign-in and role, the route itself checks the day.
    const backfill = await request(seazona, '/api/seazona/history/backfill', { token: KEY, method: 'POST', body: { from: 'last year' } });
    assert.equal(backfill.status, 400, JSON.stringify(backfill.body));
    assert.match(backfill.body.error, /yyyy-mm-dd/);
  });

  test('a wrong key is an ordinary failed sign-in', async () => {
    const wrong = await request(app, '/api/me', { token: `${KEY}x` });
    assert.equal(wrong.status, 401);
  });

  test('owner actions stay with people', async () => {
    await updatePerson(handle.db, { id: agent.id, actorId: owner.id, role: 'owner' });
    const me = await asAgent('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.ownerActions.allowed, false);
    const people = await asAgent('/api/people');
    assert.equal(people.status, 403);
    await updatePerson(handle.db, { id: agent.id, actorId: owner.id, role: 'admin' });
  });

  test('the key reads Seazona through Flow, and only reads; patient fields go only when hidden', async () => {
    const calls = [];
    const read = async (path, query) => {
      calls.push([path, query]);
      if (path === 'orders/missing') throw new SeazonaApiError('Seazona GET /v1/orders/missing failed with HTTP 404', { statusCode: 404 });
      return { path, Patient: 'Ada Example', notes: 'shade A2', lines: [{ code: 'ZR', PatientName: 'Ada Example', qty: 1 }] };
    };
    let hide = false;
    const seazona = express().use('/api/seazona', createSeazonaRouter({ db: handle.db, personAuth, read, hidePatientFields: () => hide, log: quiet }));
    const full = await request(seazona, '/api/seazona/api/orders/?ordered=2026-11-10T00:00:00', { token: KEY });
    assert.equal(full.body.data.Patient, 'Ada Example');
    hide = true;
    const list = await request(seazona, '/api/seazona/api/orders/?ordered=2026-11-11T00:00:00&page=1&bad-key=x', { token: KEY });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.data, { path: 'orders/', lines: [{ code: 'ZR', qty: 1 }] });
    assert.doesNotMatch(JSON.stringify(list.body), /Ada Example|shade/);
    assert.deepEqual(calls[1], ['orders/', { ordered: '2026-11-11T00:00:00', page: '1' }]);
    const bare = await request(seazona, '/api/seazona/api/orders/?page=1&pageSize=5', { token: KEY });
    assert.equal(bare.status, 400);
    assert.match(bare.body.error, /ordered=/);
    const users = await request(seazona, '/api/seazona/api/users/', { token: KEY });
    assert.equal(users.status, 200);
    const one = await request(seazona, '/api/seazona/api/clients/1234', { token: KEY });
    assert.equal(one.body.data.path, 'clients/1234');
    const missing = await request(seazona, '/api/seazona/api/orders/missing', { token: KEY });
    assert.equal(missing.status, 404);
    const other = await request(seazona, '/api/seazona/api/secrets/', { token: KEY });
    assert.equal(other.status, 404);
    const write = await request(seazona, '/api/seazona/api/orders/', { token: KEY, method: 'POST', body: {} });
    assert.equal(write.status, 404);
    assert.equal(calls.length, 5);
  });

  test('the key gets its skill from this Flow, and only the skill files', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const file of ['SKILL.md', 'flow.sh']) {
      const served = await asAgent(`/api/agent-skill/flow/${file}`);
      assert.equal(served.status, 200, served.text);
      assert.equal(served.text, await readFile(new URL(`../skills/flow/${file}`, import.meta.url), 'utf8'));
    }
    assert.equal((await asAgent('/api/agent-skill/flow/..%2F..%2Fpackage.json')).status, 404);
    assert.equal((await asAgent('/api/agent-skill/flow/README.md')).status, 404);
    assert.equal((await request(app, '/api/agent-skill/flow/SKILL.md')).status, 401);
  });

  test('turning the person off stops the key on the next request', async () => {
    await updatePerson(handle.db, { id: agent.id, actorId: owner.id, status: 'disabled' });
    const off = await asAgent('/api/invoicing/rules');
    assert.equal(off.status, 403);
    assert.equal(off.body.code, 'access_disabled');
  });
});
