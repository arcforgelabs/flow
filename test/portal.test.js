import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { createPortalAuth } from '../server/auth/portal.js';
import { seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createContact } from '../server/core/contacts.js';
import { createOrganisation } from '../server/core/directory.js';
import { observeJob } from '../server/core/ledger.js';
import { auditEvents, portalSessions, practiceMembers } from '../server/db/schema.js';
import { PORTAL_API } from '../server/portal/routes.js';
import { savePortalSettings } from '../server/portal/settings.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

const OWNER = 'owner@example.test';
const ADA = 'ada@example.test';
const NORTH_EMAIL = 'north@example.test';
const QUIET = { info() {}, warn() {}, error() {} };

const portalDir = new URL('../server/portal/', import.meta.url);

function leaks(body, secrets) {
  const text = JSON.stringify(body ?? null);
  return secrets.filter((secret) => secret && text.includes(secret));
}

function portalApp(handle, clerk, portalAuth, limits = {}) {
  const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
  const personAuth = createPersonAuth({
    db: handle.db,
    clerk,
    ownerGoogleDomains: ['example.test'],
    ownerMfaMaxAgeMinutes: 60,
    log: QUIET,
  });
  return createApp({
    database: handle,
    auth: { settings, clerk, personAuth, portalAuth },
    log: QUIET,
    portalApiLimit: 10_000,
    portalJoinLimit: 100,
    signInRateLimitPerMinute: 10_000,
    rateLimitPerMinute: 10_000,
    ...limits,
  });
}

test('portal job reads go through the scoped helper', () => {
  const files = readdirSync(fileURLToPath(portalDir)).filter((name) => name.endsWith('.js') && name !== 'scope.js');
  assert.ok(files.includes('routes.js'));
  for (const name of files) {
    const source = readFileSync(new URL(name, portalDir), 'utf8');
    assert.equal(source.includes('billingObligations'), false, `${name} reads jobs outside scope.js`);
  }
  assert.match(readFileSync(new URL('scope.js', portalDir), 'utf8'), /billingObligations/);
});

test('practice pages send no-store and a strict content security policy', async () => {
  const app = createApp();
  const page = await request(app, '/portal/sign-in');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('cache-control'), /no-store/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('strict-transport-security'), null);

  const secure = await request(app, '/portal/api/auth/config', { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(secure.body.mode, 'off');
  assert.match(secure.headers.get('cache-control'), /no-store/);
  assert.match(secure.headers.get('strict-transport-security'), /max-age=31536000/);
});

test('self-hosting documents health data', () => {
  const hosting = readFileSync(new URL('../docs/SELF_HOSTING.md', import.meta.url), 'utf8');
  assert.match(hosting, /^## Health data/m);
  assert.match(hosting, /encryption at rest/i);
  assert.match(hosting, /12 hours/);
  assert.match(hosting, /multi-factor/i);
});

describe('practice portal', { skip: skipWithoutDatabase }, () => {
  let handle;
  let clerk;
  let app;
  let nowMs;
  let org;
  let ownerToken;
  let adaToken;
  let south;
  let north;
  let southJob;
  let northJob;
  let adaMember;
  const secrets = [];

  before(async () => {
    nowMs = Date.now();
    const now = () => nowMs;
    handle = await freshDatabase();
    org = await createOrganisation(handle.db, { name: 'Example Lab' });
    await seedFirstOwner(handle.db, OWNER);
    south = await createContact(handle.db, org.id, { kind: 'customer', name: 'South Dental' });
    north = await createContact(handle.db, org.id, { kind: 'customer', name: 'North Dental' });
    await savePortalSettings(handle.db, org.id, { statusNames: { Booked: 'Received', Making: 'In work' } });
    const job = (contact, ref, status) => observeJob(handle.db, org.id, {
      sourceSystem: 'worksystem',
      sourceJobRef: ref,
      caseRef: ref,
      contactId: contact.id,
      practitioner: contact.id === south.id ? 'Ada' : 'Ned',
      sourceStatus: status,
      jobDate: '2026-10-01',
      lines: [{ description: 'Crown', quantity: 1, unitAmountCents: 12000 }],
    });
    southJob = await job(south, 'CASE-SOUTH', 'Booked');
    northJob = await job(north, 'CASE-NORTH', 'Making');
    clerk = fakeClerk({ now });
    const adaId = clerk.addUser({ email: ADA });
    const northId = clerk.addUser({ email: NORTH_EMAIL });
    const ownerId = clerk.addUser({ email: OWNER, google: true, password: false });
    adaToken = clerk.signIn(adaId);
    clerk.signIn(northId);
    ownerToken = clerk.signIn(ownerId);
    await handle.db.insert(practiceMembers).values([
      {
        organisationId: org.id,
        contactId: south.id,
        email: ADA,
        name: 'Ada Owner',
        role: 'owner',
        status: 'active',
        clerkUserId: adaId,
        practitionerName: 'Ada',
        linkedAt: new Date(),
      },
      {
        organisationId: org.id,
        contactId: north.id,
        email: NORTH_EMAIL,
        name: 'Ned Owner',
        role: 'owner',
        status: 'active',
        clerkUserId: northId,
        practitionerName: 'Ned',
        linkedAt: new Date(),
      },
    ]);
    [adaMember] = await handle.db.select().from(practiceMembers).where(eq(practiceMembers.email, ADA));
    secrets.push(north.id, northJob.id, NORTH_EMAIL, 'CASE-NORTH', 'North Dental', 'Ned Owner');
    const portalAuth = createPortalAuth({ db: handle.db, clerk, now, log: QUIET });
    app = portalApp(handle, clerk, portalAuth);
  });

  after(async () => handle?.close());

  test('practice A sees none of practice B on any portal route', async () => {
    const seen = [];
    const call = async (method, pattern, { id = southJob.id, body, token = adaToken } = {}) => {
      const path = `/portal/api${pattern.replace(':id', id)}`;
      const res = await request(app, path, { method, token, body });
      const found = leaks(res.body, secrets);
      if (found.length) seen.push(`${method} ${pattern} leaked ${found.join(', ')}`);
      return res;
    };

    const config = await call('GET', '/auth/config');
    assert.equal(config.status, 200);
    const me = await call('GET', '/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.practiceId, south.id);
    assert.deepEqual(me.body.practices.map((row) => row.contactId), [south.id]);

    const jobs = await call('GET', '/jobs');
    assert.equal(jobs.status, 200);
    assert.deepEqual(jobs.body.jobs.map((row) => row.id), [southJob.id]);
    assert.equal(jobs.body.jobs[0].caseRef, 'CASE-SOUTH');
    assert.equal(jobs.body.jobs[0].status, 'Received');
    assert.equal(jobs.body.jobs[0].late, true);
    assert.equal(jobs.body.jobs[0].patient, undefined);

    const own = await call('GET', '/jobs/:id');
    assert.equal(own.status, 200);
    assert.equal(own.body.job.id, southJob.id);
    const otherJob = await call('GET', '/jobs/:id', { id: northJob.id });
    assert.equal(otherJob.status, 404);
    assert.equal(otherJob.body.code, 'not_found');

    const switched = await request(app, `/portal/api/jobs?practice=${north.id}`, { token: adaToken });
    assert.equal(switched.status, 403);
    assert.equal(switched.body.code, 'practice_required');
    seen.push(...leaks(switched.body, secrets).map((secret) => `practice switch leaked ${secret}`));

    const team = await call('GET', '/team');
    assert.equal(team.status, 200);
    assert.deepEqual(team.body.members.map((row) => row.email), [ADA]);

    const invited = await call('POST', '/team', {
      body: { name: 'Sam Staff', email: 'sam.staff@example.test', role: 'staff', practitionerName: 'Sam' },
    });
    assert.equal(invited.status, 201);
    assert.equal(invited.body.invite.emailed, true);
    assert.match(clerk.calls.invited.at(-1).redirectUrl, /\/portal\/sign-in$/);

    const patched = await call('PATCH', '/team/:id', {
      id: invited.body.member.id,
      body: { practitionerName: 'Sam Dentist' },
    });
    assert.equal(patched.status, 200);
    const otherMember = secrets.length;
    const [northMember] = await handle.db.select().from(practiceMembers).where(eq(practiceMembers.email, NORTH_EMAIL));
    const northMemberId = northMember.id;
    secrets.push(northMemberId);
    const patchOther = await call('PATCH', '/team/:id', { id: northMemberId, body: { role: 'staff' } });
    assert.equal(patchOther.status, 404);
    const deleteOther = await call('DELETE', '/team/:id', { id: northMemberId });
    assert.equal(deleteOther.status, 404);
    secrets.splice(otherMember);

    const join = await call('POST', '/join', {
      token: null,
      body: { name: 'Joiner', email: 'joiner-scope@example.test', practiceName: 'Joiner Practice', phone: '555' },
    });
    assert.equal(join.status, 201);
    assert.deepEqual(join.body, { ok: true });

    const called = new Set(['GET /auth/config', 'POST /join', 'GET /me', 'GET /jobs', 'GET /jobs/:id', 'GET /team', 'POST /team', 'PATCH /team/:id', 'DELETE /team/:id']);
    for (const [method, pattern] of PORTAL_API) assert.ok(called.has(`${method} ${pattern}`), `${method} ${pattern} was not called`);
    assert.deepEqual(seen, []);
  });

  test('a portal session is refused on a staff route, and a staff session on a portal route', async () => {
    const portalOnStaff = await request(app, '/api/me', { token: adaToken });
    assert.equal(portalOnStaff.status, 403);
    assert.equal(portalOnStaff.body.code, 'not_invited');
    const portalOnLab = await request(app, '/api/portal/settings', { token: adaToken });
    assert.equal(portalOnLab.status, 403);
    assert.equal(portalOnLab.body.code, 'not_invited');

    const staffOnPortal = await request(app, '/portal/api/jobs', { token: ownerToken });
    assert.equal(staffOnPortal.status, 403);
    assert.equal(staffOnPortal.body.code, 'staff_session');
    assert.deepEqual(leaks(staffOnPortal.body, [southJob.id, 'CASE-SOUTH', northJob.id, 'CASE-NORTH']), []);
  });

  test('join, approve and invite, and the lab can read that practice only when it asks', async () => {
    const waitingEmail = 'waiting.owner@example.test';
    assert.equal((await request(app, '/portal/api/join', {
      method: 'POST',
      body: { name: 'Waiting Owner', email: waitingEmail, practiceName: 'Waiting Dental' },
    })).status, 201);
    const waiting = clerk.signIn(clerk.addUser({ email: waitingEmail }));
    const pending = await request(app, '/portal/api/me', { token: waiting });
    assert.equal(pending.status, 403);
    assert.equal(pending.body.code, 'access_pending');
    assert.match(pending.body.error, /Waiting for the lab/);

    const email = 'new.owner@example.test';
    const joined = await request(app, '/portal/api/join', {
      method: 'POST',
      body: { name: 'New Owner', email, practiceName: 'East Dental', phone: '555' },
    });
    assert.equal(joined.status, 201);

    const listed = await request(app, '/api/portal/requests?status=open', { token: ownerToken });
    assert.equal(listed.status, 200);
    const row = listed.body.requests.find((item) => item.email === email);
    assert.ok(row);
    const east = await createContact(handle.db, org.id, { kind: 'customer', name: 'East Dental' });
    const approved = await request(app, `/api/portal/requests/${row.id}/approve`, {
      token: ownerToken,
      method: 'POST',
      body: { contactId: east.id },
    });
    assert.equal(approved.status, 201);
    assert.equal(approved.body.member.role, 'owner');
    assert.equal(approved.body.member.status, 'invited');
    assert.equal(approved.body.invite.emailed, true);
    assert.match(clerk.calls.invited.at(-1).redirectUrl, /\/portal\/sign-in$/);

    nowMs += 5000;
    const token = clerk.signIn(await clerk.findUserIdByEmail(email));
    const me = await request(app, '/portal/api/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.body.member.role, 'owner');
    assert.equal(me.body.practiceId, east.id);

    const asLab = await request(app, `/api/portal/contacts/${east.id}/jobs`, { token: ownerToken });
    assert.equal(asLab.status, 200);
    assert.deepEqual(asLab.body.jobs, []);
    const southAsLab = await request(app, `/api/portal/contacts/${south.id}/jobs`, { token: ownerToken });
    assert.deepEqual(southAsLab.body.jobs.map((item) => item.caseRef), ['CASE-SOUTH']);
  });

  test('the practice keeps one owner, and an admin cannot change an owner', async () => {
    const adminEmail = 'ada.admin@example.test';
    const invited = await request(app, '/portal/api/team', {
      token: adaToken,
      method: 'POST',
      body: { name: 'Ada Admin', email: adminEmail, role: 'admin' },
    });
    assert.equal(invited.status, 201);
    nowMs += 5000;
    const adminToken = clerk.signIn(await clerk.findUserIdByEmail(adminEmail));
    const adminMe = await request(app, '/portal/api/me', { token: adminToken });
    assert.equal(adminMe.status, 200);
    assert.equal(adminMe.body.member.role, 'admin');

    const demote = await request(app, `/portal/api/team/${adaMember.id}`, {
      token: adminToken,
      method: 'PATCH',
      body: { role: 'staff' },
    });
    assert.equal(demote.status, 403);
    const remove = await request(app, `/portal/api/team/${adaMember.id}`, { token: adminToken, method: 'DELETE' });
    assert.equal(remove.status, 403);

    const self = await request(app, `/portal/api/team/${adaMember.id}`, {
      token: adaToken,
      method: 'PATCH',
      body: { role: 'staff' },
    });
    assert.equal(self.status, 409);
    assert.match(self.body.error, /at least one owner/);
    const selfRemove = await request(app, `/portal/api/team/${adaMember.id}`, { token: adaToken, method: 'DELETE' });
    assert.equal(selfRemove.status, 409);
  });

  test('a portal job read and a member change each write an audit event', async () => {
    const read = await request(app, `/portal/api/jobs/${southJob.id}`, { token: adaToken });
    assert.equal(read.status, 200);
    const [jobEvent] = await handle.db.select().from(auditEvents).where(eq(auditEvents.recordId, southJob.id));
    assert.equal(jobEvent.action, 'read');
    assert.equal(jobEvent.recordType, 'job');
    assert.equal(jobEvent.actorKind, 'member');
    assert.equal(jobEvent.actorId, adaMember.id);
    assert.equal(jobEvent.practiceContactId, south.id);

    const staffEmail = 'audit.staff@example.test';
    const created = await request(app, '/portal/api/team', {
      token: adaToken,
      method: 'POST',
      body: { name: 'Audit Staff', email: staffEmail, role: 'staff' },
    });
    assert.equal(created.status, 201);
    const changed = await request(app, `/portal/api/team/${created.body.member.id}`, {
      token: adaToken,
      method: 'PATCH',
      body: { role: 'dentist' },
    });
    assert.equal(changed.status, 200);
    const [memberEvent] = await handle.db.select().from(auditEvents).where(eq(auditEvents.recordId, created.body.member.id));
    assert.ok(memberEvent);
    const events = await handle.db.select().from(auditEvents).where(eq(auditEvents.recordId, created.body.member.id));
    assert.ok(events.some((event) => event.action === 'create' && event.recordType === 'member'));
    assert.ok(events.some((event) => event.action === 'change' && event.recordType === 'member'));

    const page = await request(app, `/api/portal/contacts/${south.id}`, { token: ownerToken });
    assert.equal(page.status, 200);
    assert.ok(page.body.events.some((event) => event.recordId === southJob.id && event.action === 'read'));

    await assert.rejects(() => handle.db.update(auditEvents).set({ action: 'delete' }).where(eq(auditEvents.id, jobEvent.id)));
    await assert.rejects(() => handle.db.delete(auditEvents).where(eq(auditEvents.id, jobEvent.id)));
    const [still] = await handle.db.select().from(auditEvents).where(eq(auditEvents.id, jobEvent.id));
    assert.equal(still.action, 'read');
  });

  test('a portal session ends after 12 hours idle, and the lab can sign a member out', async () => {
    const email = 'idle.dentist@example.test';
    const invited = await request(app, '/portal/api/team', {
      token: adaToken,
      method: 'POST',
      body: { name: 'Idle Dentist', email, role: 'dentist' },
    });
    assert.equal(invited.status, 201);
    nowMs = Date.now();
    const token = clerk.signIn(await clerk.findUserIdByEmail(email));
    assert.equal((await request(app, '/portal/api/me', { token })).status, 200);
    await handle.db.update(portalSessions).set({ lastSeenAt: new Date(nowMs - (13 * 60 * 60 * 1000)) }).where(eq(portalSessions.sessionId, token));
    const idle = await request(app, '/portal/api/me', { token });
    assert.equal(idle.status, 401);
    assert.equal(idle.body.code, 'session_expired');

    nowMs = Date.now();
    const again = clerk.signIn(await clerk.findUserIdByEmail(email));
    const back = await request(app, '/portal/api/me', { token: again });
    assert.equal(back.status, 200);
    const signedOut = await request(app, `/api/portal/contacts/${south.id}/members/${back.body.member.id}/sign-out`, {
      token: ownerToken,
      method: 'POST',
    });
    assert.equal(signedOut.status, 200);
    const refused = await request(app, '/portal/api/me', { token: again });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, 'session_revoked');
    nowMs = Date.now() + 10_000;
    const fresh = clerk.signIn(await clerk.findUserIdByEmail(email));
    assert.equal((await request(app, '/portal/api/me', { token: fresh })).status, 200);
  });

  test('join and the sign-in page are rate limited', async () => {
    const limited = portalApp(handle, clerk, createPortalAuth({ db: handle.db, clerk, now: () => nowMs, log: QUIET }), {
      portalJoinLimit: 2,
      signInRateLimitPerMinute: 2,
      portalApiLimit: 100,
    });
    const body = { name: 'Rate', email: 'rate.limit@example.test', practiceName: 'Rate Practice' };
    assert.equal((await request(limited, '/portal/api/join', { method: 'POST', body })).status, 201);
    assert.equal((await request(limited, '/portal/api/join', { method: 'POST', body })).status, 201);
    const blocked = await request(limited, '/portal/api/join', { method: 'POST', body });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'rate_limited');

    assert.equal((await request(limited, '/portal/sign-in')).status, 200);
    assert.equal((await request(limited, '/portal/sign-in')).status, 200);
    assert.equal((await request(limited, '/portal/sign-in')).status, 429);
  });
});
