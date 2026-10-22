import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import {
  PERMISSIONS, ROLE_DEFAULTS, can, permissionsFor, resolvePermission, setPersonPermission, setRolePermission,
} from '../server/auth/permissions.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createOrganisation } from '../server/core/directory.js';
import { permissionEvents } from '../server/db/schema.js';
import { createIntegrations } from '../server/integrations/index.js';
import { createSeazonaAdapter } from '../server/integrations/seazona/index.js';
import { createXeroAdapter } from '../server/integrations/xero/index.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { ORIGIN, TOKEN_KEY, xeroRuntime } from './support/xero.js';

// Today's gates, written down before the rows exist. Owner and admin do the
// manager actions. Staff do none. Only an owner connects an integration or
// manages people. A later change to ROLE_DEFAULTS has to change this list.
const KEYS = [
  'invoices.send', 'invoices.approve', 'invoices.void', 'invoices.draft',
  'priceList.edit', 'rules.edit', 'customFields.edit', 'integrations.run',
  'integrations.connect', 'people.manage',
];
const OWNER_ONLY = new Set(['integrations.connect', 'people.manage']);

test('a fresh install keeps today\'s access: owner and admin do the manager actions, staff do none', () => {
  assert.deepEqual(PERMISSIONS.map((permission) => permission.key), KEYS);
  for (const key of KEYS) {
    const manager = !OWNER_ONLY.has(key);
    assert.equal(resolvePermission({ role: 'owner' }, key), true, key);
    assert.equal(resolvePermission({ role: 'admin' }, key), manager, key);
    assert.equal(resolvePermission({ role: 'staff' }, key), false, key);
    assert.equal(ROLE_DEFAULTS.owner[key], true, key);
    assert.equal(ROLE_DEFAULTS.admin[key], manager, key);
    assert.equal(ROLE_DEFAULTS.staff[key], false, key);
  }
});

test('a person deny beats a role allow, and a person allow beats a role deny', () => {
  assert.equal(resolvePermission({ role: 'admin' }, 'invoices.send', { roleAllowed: true, personEffect: 'deny' }), false);
  assert.equal(resolvePermission({ role: 'staff' }, 'invoices.send', { roleAllowed: false, personEffect: 'allow' }), true);
  assert.equal(resolvePermission({ role: 'owner' }, 'invoices.send', { personEffect: 'deny' }), false, 'a person deny beats the owner column');
  assert.equal(resolvePermission({ role: 'staff' }, 'integrations.connect', { personEffect: 'allow' }), true);
});

test('the owner column and people.manage cannot be turned off', () => {
  assert.equal(resolvePermission({ role: 'owner' }, 'invoices.send', { roleAllowed: false }), true);
  assert.equal(resolvePermission({ role: 'admin' }, 'people.manage', { personEffect: 'allow' }), false);
  assert.equal(resolvePermission({ role: 'owner' }, 'people.manage', { personEffect: 'deny', roleAllowed: false }), true);
  assert.equal(resolvePermission({ role: 'staff' }, 'no.such'), false);
});

test('the manager role list is gone from the gated routers, and the migration names every key', () => {
  const root = new URL('..', import.meta.url);
  for (const file of [
    'server/api/invoicing.js', 'server/api/custom-fields.js',
    'server/integrations/xero/routes.js', 'server/integrations/seazona/routes.js', 'server/integrations/setup.js',
  ]) {
    assert.doesNotMatch(readFileSync(new URL(file, root), 'utf8'), /requireRole\(\s*'owner'\s*,\s*'admin'\s*\)/, file);
  }
  const sql = readFileSync(new URL('server/db/migrations/0021_permissions.sql', root), 'utf8');
  for (const key of KEYS) assert.match(sql, new RegExp(`'${key.replace('.', '\\.')}'`));
  const css = readFileSync(new URL('server/ui/flow.css', root), 'utf8');
  assert.match(css, /@media \(max-width: 639px\) \{\s*\.fx-perm__desk \{ display: none; \}/);
});

const ID = '00000000-0000-4000-8000-000000000001';
const ROUTES = {
  'invoices.send': [
    ['POST', '/api/invoicing/invoices/send-ready'],
    ['POST', '/api/invoicing/invoices/send-again'],
    ['POST', '/api/xero/invoices/push'],
  ],
  'invoices.approve': [
    ['POST', `/api/invoicing/invoices/${ID}/issue`],
    ['POST', `/api/invoicing/invoices/${ID}/revise`],
  ],
  'invoices.void': [['POST', `/api/invoicing/invoices/${ID}/void`]],
  'invoices.draft': [
    ['POST', `/api/invoicing/jobs/${ID}/draft`],
    ['POST', `/api/invoicing/jobs/${ID}/use-new-lines`],
    ['POST', `/api/invoicing/jobs/${ID}/no-invoice`],
    ['POST', `/api/invoicing/jobs/${ID}/link`],
  ],
  'priceList.edit': [
    ['POST', '/api/invoicing/price-list/check'],
    ['POST', '/api/invoicing/price-items'],
    ['PUT', `/api/invoicing/price-items/${ID}`],
    ['POST', `/api/invoicing/price-items/${ID}/archive`],
    ['POST', `/api/invoicing/price-items/${ID}/links`],
    ['POST', '/api/invoicing/price-links'],
    ['POST', `/api/invoicing/price-items/${ID}/resolve`],
    ['DELETE', `/api/invoicing/price-links/${ID}`],
  ],
  'rules.edit': [
    ['PUT', '/api/invoicing/automations/draft'],
    ['POST', '/api/invoicing/rules'],
    ['PUT', `/api/invoicing/rules/${ID}`],
    ['DELETE', `/api/invoicing/rules/${ID}`],
    ['POST', '/api/invoicing/line-mappings'],
    ['PUT', `/api/invoicing/line-mappings/${ID}`],
    ['DELETE', `/api/invoicing/line-mappings/${ID}`],
    ['PUT', '/api/invoicing/settings'],
    ['PUT', `/api/invoicing/contacts/${ID}/billing`],
  ],
  'customFields.edit': [
    ['POST', '/api/custom-fields'],
    ['PUT', '/api/custom-fields/order'],
    ['PUT', '/api/custom-fields/groups/invoice'],
    ['PUT', `/api/custom-fields/${ID}`],
    ['POST', `/api/custom-fields/${ID}/archive`],
    ['DELETE', `/api/custom-fields/${ID}`],
  ],
  'integrations.run': [
    ['POST', '/api/xero/sync'],
    ['POST', '/api/xero/mirror'],
    ['POST', '/api/xero/payments/sync'],
    ['POST', `/api/xero/invoices/${ID}/recheck`],
    ['POST', `/api/xero/obligations/${ID}/check`],
    ['POST', '/api/xero/import/match'],
    ['PUT', '/api/xero/import/settings'],
    ['POST', `/api/xero/import/${ID}/link`],
    ['POST', `/api/xero/import/${ID}/make`],
    ['POST', '/api/seazona/history/batches'],
    ['POST', `/api/seazona/history/batches/${ID}/reconcile`],
    ['POST', `/api/seazona/history/batches/${ID}/decisions`],
    ['POST', `/api/seazona/history/batches/${ID}/apply`],
    ['POST', `/api/seazona/history/batches/${ID}/cancel`],
    ['POST', '/api/seazona/history/backfill'],
    ['POST', '/api/seazona/history/backfill/stop'],
    ['POST', `/api/seazona/history/ledger/${ID}/release`],
  ],
  'integrations.connect': [
    ['POST', '/api/xero/connect'],
    ['POST', '/api/xero/disconnect'],
    ['GET', '/api/integrations'],
  ],
  'people.manage': [
    ['GET', '/api/people'],
    ['POST', '/api/people'],
  ],
};

describe('permission rows and gates', { skip: skipWithoutDatabase }, () => {
  const quiet = { info() {}, warn() {}, error() {} };
  let handle;
  let registry;
  let app;
  let owner;
  let admin;
  let staff;
  let ownerToken;
  let adminToken;
  let staffToken;

  before(async () => {
    handle = await freshDatabase();
    const env = {
      FLOW_INTEGRATIONS: 'xero,seazona',
      SEAZONA_MODE: 'replay',
      SEAZONA_REPLAY_FILE: fileURLToPath(new URL('./fixtures/seazona/billing.json', import.meta.url)),
    };
    const replay = xeroRuntime([]);
    registry = createIntegrations({
      env,
      adapters: [createXeroAdapter({ runtime: replay.runtime }), createSeazonaAdapter({ env })],
      log: quiet,
    });
    await registry.start(handle.db);
    await createOrganisation(handle.db, { name: 'Example Lab' });
    const clerk = fakeClerk();
    owner = await seedFirstOwner(handle.db, 'owner@example.test');
    admin = await invitePerson(handle.db, { email: 'admin@example.test', role: 'admin', invitedBy: owner.id });
    staff = await invitePerson(handle.db, { email: 'staff@example.test', role: 'staff', invitedBy: owner.id });
    ownerToken = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    adminToken = clerk.signIn(clerk.addUser({ email: 'admin@example.test', google: true, password: false }));
    staffToken = clerk.signIn(clerk.addUser({ email: 'staff@example.test' }));
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    app = createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations: registry, log: quiet, buttonCooldowns: false });
  });

  after(async () => {
    await registry?.stop?.();
    await handle?.close();
  });

  const call = (path, options = {}) => request(app, path, options);

  test('a fresh install answers the same as the role gates', async () => {
    const ownerMap = await permissionsFor(handle.db, owner);
    const adminMap = await permissionsFor(handle.db, admin);
    const staffMap = await permissionsFor(handle.db, staff);
    assert.deepEqual(ownerMap, ROLE_DEFAULTS.owner);
    assert.deepEqual(adminMap, ROLE_DEFAULTS.admin);
    assert.deepEqual(staffMap, ROLE_DEFAULTS.staff);
    const me = await call('/api/me', { token: staffToken });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.permissions, ROLE_DEFAULTS.staff);
    assert.equal((await call('/api/me', { token: adminToken })).body.permissions['integrations.connect'], false);
    assert.equal((await call('/api/me', { token: ownerToken })).body.permissions['people.manage'], true);
  });

  test('a person deny beats a role allow, and a person allow beats a role deny, and each change is audited', async () => {
    const opened = await setRolePermission(handle.db, { role: 'staff', key: 'invoices.send', allowed: true, actorId: owner.id });
    assert.equal(opened.changed, true);
    assert.equal(await can(handle.db, staff, 'invoices.send'), true);
    const denied = await setPersonPermission(handle.db, { personId: staff.id, key: 'invoices.send', effect: 'deny', actorId: owner.id });
    assert.equal(denied.changed, true);
    assert.equal(await can(handle.db, staff, 'invoices.send'), false, 'the person deny wins');

    await setRolePermission(handle.db, { role: 'admin', key: 'invoices.draft', allowed: false, actorId: owner.id });
    assert.equal(await can(handle.db, admin, 'invoices.draft'), false);
    await setPersonPermission(handle.db, { personId: admin.id, key: 'invoices.draft', effect: 'allow', actorId: owner.id });
    assert.equal(await can(handle.db, admin, 'invoices.draft'), true, 'the person allow wins');

    const events = await handle.db.select().from(permissionEvents).where(eq(permissionEvents.actorId, owner.id));
    const send = events.filter((event) => event.key === 'invoices.send');
    assert.deepEqual(send.map((event) => [event.targetRole, event.targetPersonId, event.fromValue, event.toValue]), [
      ['staff', null, 'deny', 'allow'],
      [null, staff.id, 'inherit', 'deny'],
    ]);

    await setPersonPermission(handle.db, { personId: staff.id, key: 'invoices.send', effect: 'inherit', actorId: owner.id });
    await setRolePermission(handle.db, { role: 'staff', key: 'invoices.send', allowed: false, actorId: owner.id });
    await setPersonPermission(handle.db, { personId: admin.id, key: 'invoices.draft', effect: 'inherit', actorId: owner.id });
    await setRolePermission(handle.db, { role: 'admin', key: 'invoices.draft', allowed: true, actorId: owner.id });
    assert.equal(await can(handle.db, staff, 'invoices.send'), false);
    assert.equal(await can(handle.db, admin, 'invoices.draft'), true);
  });

  test('the owner column and people.manage stay on', async () => {
    await assert.rejects(
      () => setRolePermission(handle.db, { role: 'owner', key: 'invoices.send', allowed: false, actorId: owner.id }),
      (error) => error.code === 'forbidden',
    );
    await assert.rejects(
      () => setRolePermission(handle.db, { role: 'staff', key: 'people.manage', allowed: true, actorId: owner.id }),
      (error) => error.code === 'forbidden',
    );
    await assert.rejects(
      () => setPersonPermission(handle.db, { personId: staff.id, key: 'people.manage', effect: 'allow', actorId: owner.id }),
      (error) => error.code === 'forbidden',
    );
    const off = await call('/api/permissions/roles/owner', { token: ownerToken, method: 'PUT', body: { key: 'invoices.send', allowed: false } });
    assert.equal(off.status, 403);
    assert.equal(off.body.code, 'forbidden');
    const people = await call('/api/permissions/roles/staff', { token: ownerToken, method: 'PUT', body: { key: 'people.manage', allowed: true } });
    assert.equal(people.status, 403);
    assert.equal(await can(handle.db, owner, 'invoices.send'), true);
    assert.equal(await can(handle.db, staff, 'people.manage'), false);
    const grid = await call('/api/permissions', { token: ownerToken });
    assert.equal(grid.status, 200);
    assert.equal(grid.body.grants.owner['invoices.send'], true);
    assert.equal(grid.body.ownerLocked, true);
    assert.equal(grid.body.grants.staff['people.manage'], undefined, 'people.manage is not on the grid');
    assert.equal((await call('/api/permissions', { token: staffToken })).status, 403);
  });

  test('each gated route is 403 permission_required without the key and passes the gate with it', async () => {
    for (const [key, routes] of Object.entries(ROUTES)) {
      for (const [method, path] of routes) {
        const denied = await call(path, { token: staffToken, method, ...(method === 'GET' ? {} : { body: {} }) });
        assert.equal(denied.status, 403, `${method} ${path}`);
        assert.equal(denied.body.code, 'permission_required', `${method} ${path} ${JSON.stringify(denied.body)}`);
      }
      if (key === 'people.manage') {
        for (const [method, path] of routes) {
          const passed = await call(path, { token: ownerToken, method, ...(method === 'GET' ? {} : { body: { email: 'extra@example.test', role: 'staff' } }) });
          assert.notEqual(passed.body?.code, 'permission_required', `${method} ${path}`);
        }
        continue;
      }
      await setPersonPermission(handle.db, { personId: staff.id, key, effect: 'allow', actorId: owner.id });
      for (const [method, path] of routes) {
        const passed = await call(path, { token: staffToken, method, ...(method === 'GET' ? {} : { body: {} }) });
        assert.notEqual(passed.body?.code, 'permission_required', `${method} ${path} ${passed.status} ${JSON.stringify(passed.body)}`);
        if (key === 'integrations.connect' && path.startsWith('/api/xero/')) {
          assert.equal(passed.body.code, 'owner_verification_required', `${method} ${path}`);
        }
      }
      await setPersonPermission(handle.db, { personId: staff.id, key, effect: 'inherit', actorId: owner.id });
    }
  });
});
