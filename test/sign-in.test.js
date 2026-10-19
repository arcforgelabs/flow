import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { findPersonByEmail, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { people } from '../server/db/schema.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Clerk sign-in against PostgreSQL, with Clerk faked (no keys, no network).
// Synthetic people only (CONTRIBUTING.md).
const OWNER = 'owner@example.test';
// A stand-in for server/update-check.js: no network.
const UPDATE_STATUS = { enabled: true, channel: 'stable', current: 'v2026.10.18', latest: 'v2026.10.19', updateAvailable: true };
const updates = { status: async () => UPDATE_STATUS };

function signInApp(handle, clerk, { publicSignUp = false, signUpDomains = [] } = {}) {
  const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null }, publicSignUp, signUpDomains };
  const personAuth = createPersonAuth({
    db: handle.db,
    clerk,
    publicSignUp,
    signUpDomains,
    ownerGoogleDomains: ['example.test'],
    ownerMfaMaxAgeMinutes: 60,
    log: { info() {}, warn() {}, error() {} },
  });
  return createApp({ database: handle, auth: { settings, clerk, personAuth }, updates, log: { error() {} } });
}

describe('Clerk sign-in', { skip: skipWithoutDatabase }, () => {
  let handle;
  let clerk;
  let app;
  let ownerToken;

  before(async () => {
    handle = await freshDatabase();
    await seedFirstOwner(handle.db, OWNER);
    clerk = fakeClerk();
    app = signInApp(handle, clerk);
    ownerToken = clerk.signIn(clerk.addUser({ email: OWNER, google: true, password: false }));
  });

  after(async () => handle?.close());

  test('the first owner is seeded once, and only while there is no owner', async () => {
    assert.equal(await seedFirstOwner(handle.db, 'second@example.test'), null);
    assert.equal(await findPersonByEmail(handle.db, 'second@example.test'), null);
  });

  test('a mapped user gets their Flow role, linked by verified email', async () => {
    const res = await request(app, '/api/me', { token: ownerToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.person.email, OWNER);
    assert.equal(res.body.person.role, 'owner');
    assert.equal(res.body.person.invited, false);
    assert.deepEqual(res.body.ownerActions, { allowed: true, by: 'google_workspace' });
  });

  test('an unmapped user gets no access, and Flow records nothing about them', async () => {
    const token = clerk.signIn(clerk.addUser({ email: 'stranger@example.test' }));
    const res = await request(app, '/api/me', { token });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'not_invited');
    assert.equal(await findPersonByEmail(handle.db, 'stranger@example.test'), null);
  });

  test('an unverified email links nothing', async () => {
    await handle.db.insert(people).values({ email: 'unverified@example.test', role: 'staff' });
    const token = clerk.signIn(clerk.addUser({ email: 'unverified@example.test', verified: false }));
    const res = await request(app, '/api/me', { token });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'email_unverified');
    assert.equal((await findPersonByEmail(handle.db, 'unverified@example.test')).clerkUserId, null);
  });

  test('an expired, unknown or missing session is refused', async () => {
    const owner = clerk.addUser({ email: 'owner-expired@example.test' });
    const expired = await request(app, '/api/me', { token: clerk.signIn(owner, { expiresIn: -1 }) });
    assert.equal(expired.status, 401);
    assert.equal(expired.body.code, 'session_expired');

    const signedOut = clerk.signIn(owner);
    clerk.signOut(signedOut);
    assert.equal((await request(app, '/api/me', { token: signedOut })).body.code, 'signed_out');
    assert.equal((await request(app, '/api/me')).status, 401);
  });

  test('with public sign-up off, the sign-in page creates no account', async () => {
    const config = await request(app, '/api/auth/config');
    assert.equal(config.body.publicSignUp, false);
  });

  test('with public sign-up on, a stranger waits as pending until an owner approves them', async () => {
    const open = signInApp(handle, clerk, { publicSignUp: true });
    const token = clerk.signIn(clerk.addUser({ email: 'applicant@example.test' }));
    const first = await request(open, '/api/me', { token });
    assert.equal(first.status, 403);
    assert.equal(first.body.code, 'access_pending');
    const pending = await findPersonByEmail(handle.db, 'applicant@example.test');
    assert.equal(pending.status, 'pending');
    assert.equal(pending.role, 'staff');

    const approve = await request(open, `/api/people/${pending.id}`, { token: ownerToken, method: 'PATCH', body: { status: 'active' } });
    assert.equal(approve.status, 200);
    const after = await request(open, '/api/me', { token });
    assert.equal(after.status, 200);
    assert.equal(after.body.person.role, 'staff');
  });

  test('with sign-up domains, only those domains may ask for access; others still need an invitation', async () => {
    const domains = signInApp(handle, clerk, { signUpDomains: ['lab.example.test'] });
    assert.equal((await request(domains, '/api/auth/config')).body.publicSignUp, true);

    const outsider = clerk.signIn(clerk.addUser({ email: 'outsider@elsewhere.example.test' }));
    const refused = await request(domains, '/api/me', { token: outsider });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'not_invited');
    assert.equal(await findPersonByEmail(handle.db, 'outsider@elsewhere.example.test'), null);

    // A sub-domain is not the listed domain.
    const lookalike = clerk.signIn(clerk.addUser({ email: 'someone@x.lab.example.test' }));
    assert.equal((await request(domains, '/api/me', { token: lookalike })).body.code, 'not_invited');

    const colleague = clerk.signIn(clerk.addUser({ email: 'colleague@lab.example.test' }));
    const first = await request(domains, '/api/me', { token: colleague });
    assert.equal(first.status, 403);
    assert.equal(first.body.code, 'access_pending');
    assert.equal((await findPersonByEmail(handle.db, 'colleague@lab.example.test')).status, 'pending');
  });

  test('an owner invites a user, who gets in with that role', async () => {
    const invite = await request(app, '/api/people', { token: ownerToken, method: 'POST', body: { email: 'Staff@Example.test', role: 'staff' } });
    assert.equal(invite.status, 201);
    assert.equal(invite.body.person.email, 'staff@example.test');
    assert.equal(invite.body.person.invited, true);
    assert.deepEqual(clerk.calls.created, ['staff@example.test'], 'Flow prepares the invitee a Clerk account');

    const again = await request(app, '/api/people', { token: ownerToken, method: 'POST', body: { email: 'staff@example.test', role: 'admin' } });
    assert.equal(again.status, 409);

    const staffId = await clerk.findUserIdByEmail('staff@example.test');
    const staffToken = clerk.signIn(staffId);
    const me = await request(app, '/api/me', { token: staffToken });
    assert.equal(me.status, 200);
    assert.equal(me.body.person.role, 'staff');
    assert.equal(me.body.person.invited, false);
    assert.equal(me.body.ownerActions, undefined);

    const list = await request(app, '/api/people', { token: ownerToken });
    assert.ok(list.body.people.some((person) => person.email === 'staff@example.test' && !person.invited));
  });

  test('only an owner manages people', async () => {
    await request(app, '/api/people', { token: ownerToken, method: 'POST', body: { email: 'admin@example.test', role: 'admin' } });
    const adminToken = clerk.signIn(await clerk.findUserIdByEmail('admin@example.test'));
    const res = await request(app, '/api/people', { token: adminToken, method: 'POST', body: { email: 'x@example.test', role: 'owner' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'owner_required');
    assert.equal((await request(app, '/api/people', { token: adminToken })).status, 403);
  });

  test('only an owner sees whether a newer release is out', async () => {
    const owner = await request(app, '/api/updates', { token: ownerToken });
    assert.equal(owner.status, 200);
    assert.deepEqual(owner.body, { ok: true, ...UPDATE_STATUS });

    await request(app, '/api/people', { token: ownerToken, method: 'POST', body: { email: 'updates-staff@example.test', role: 'staff' } });
    const staffToken = clerk.signIn(await clerk.findUserIdByEmail('updates-staff@example.test'));
    const staff = await request(app, '/api/updates', { token: staffToken });
    assert.equal(staff.status, 403);
    assert.equal(staff.body.code, 'role_required');
    assert.equal((await request(app, '/api/updates')).status, 401);
  });

  test('owner actions need a verified owner sign-in', async () => {
    const invite = await request(app, '/api/people', { token: ownerToken, method: 'POST', body: { email: 'owner2@example.test', role: 'owner' } });
    assert.equal(invite.status, 201);
    // The second owner signs in with a password instead of Google.
    const clerkId = await clerk.findUserIdByEmail('owner2@example.test');
    clerk.users.get(clerkId).passwordEnabled = true;
    const weak = await request(app, '/api/people', { token: clerk.signIn(clerkId) });
    assert.equal(weak.status, 403);
    assert.equal(weak.body.code, 'owner_verification_required');
    const strong = await request(app, '/api/people', { token: clerk.signIn(clerkId, { secondFactorAge: 5 }) });
    assert.equal(strong.status, 200);
  });

  test('Flow keeps an owner, and nobody changes or removes themself', async () => {
    const me = (await request(app, '/api/me', { token: ownerToken })).body.person;
    const self = await request(app, `/api/people/${me.id}`, { token: ownerToken, method: 'DELETE' });
    assert.equal(self.status, 403);
    const list = (await request(app, '/api/people', { token: ownerToken })).body.people;
    const other = list.find((person) => person.email === 'owner2@example.test');
    assert.equal((await request(app, `/api/people/${other.id}`, { token: ownerToken, method: 'PATCH', body: { role: 'staff' } })).status, 200);
    assert.equal((await request(app, `/api/people/${other.id}`, { token: ownerToken, method: 'PATCH', body: { role: 'boss' } })).status, 400);
    assert.equal((await request(app, '/api/people/not-a-uuid', { token: ownerToken, method: 'DELETE' })).status, 404);
  });

  test('a person whose access is turned off is refused at once', async () => {
    const list = (await request(app, '/api/people', { token: ownerToken })).body.people;
    const staff = list.find((person) => person.email === 'staff@example.test');
    const staffToken = clerk.signIn(await clerk.findUserIdByEmail('staff@example.test'));
    assert.equal((await request(app, `/api/people/${staff.id}`, { token: ownerToken, method: 'PATCH', body: { status: 'disabled' } })).status, 200);
    const res = await request(app, '/api/me', { token: staffToken });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'access_disabled');
  });

  test('the Flow API is separate: a Clerk session never opens it', async () => {
    const before = clerk.calls.authenticate;
    const res = await request(app, '/api/flow/v1/system.version', { token: ownerToken, method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'connector_signature_required');
    assert.equal(clerk.calls.authenticate, before, 'Clerk is never asked about an API request');

    // And a connector-style credential never opens a person route.
    const person = await request(app, '/api/me', { headers: { Authorization: 'FlowConnector conn_1:signature' } });
    assert.equal(person.status, 401);
    assert.equal(person.body.code, 'signed_out');
    assert.equal(clerk.calls.authenticate, before);
  });
});
