import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createContact, createOrganisation } from '../server/core/directory.js';
import { observeJob } from '../server/core/ledger.js';
import { invoicingSettings, practiceMembers } from '../server/db/schema.js';
import { removeMember } from '../server/portal/members.js';
import { PRACTICE_ROUTES } from '../server/portal/routes.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// A practice sees only its own jobs and team. A portal session cannot open a
// lab route, and a lab session cannot open a portal route (docs/PORTAL.md).
const quiet = { info() {}, warn() {}, error() {} };

function appFor(handle, clerk, { signInRateLimitPerMinute = 1000, rateLimitPerMinute = 1000 } = {}) {
  const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
  const personAuth = createPersonAuth({
    db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet,
  });
  const work = {
    id: 'bench',
    capabilities: {
      listWork: async () => ({
        statuses: ['Booked', 'In lab', 'Checked', 'Gone'].map((label) => ({ label })),
        items: [
          { sourceSystem: 'bench', sourceJobRef: 'A-1', caseRef: '9001', status: 'In lab', practitioner: 'Dr A. Example', dueOn: '2026-10-01', patient: 'Patient Secret', orderedOn: '2026-09-01' },
          { sourceSystem: 'bench', sourceJobRef: 'A-2', caseRef: '9002', status: 'Gone', practitioner: 'Dr B. Sample', dueOn: '2026-10-01', patient: 'Patient Other' },
          { sourceSystem: 'bench', sourceJobRef: 'B-1', caseRef: '8001', status: 'In lab', practitioner: 'Dr C. Other', dueOn: '2026-10-01', patient: 'Patient Harbour' },
        ],
      }),
    },
  };
  const integrations = {
    with: (cap) => (work.capabilities[cap] ? [work] : []),
    routes: () => [],
    list: () => [],
    get: () => null,
  };
  return createApp({
    database: handle,
    auth: { settings, clerk, personAuth },
    integrations,
    log: quiet,
    rateLimitPerMinute,
    signInRateLimitPerMinute,
  });
}

function leaks(body, secrets) {
  const text = JSON.stringify(body);
  return secrets.filter((secret) => secret && text.includes(secret));
}

describe('portal routes stay inside one practice', () => {
  test('a portal route does not read a table itself', () => {
    const routes = readFileSync(fileURLToPath(new URL('../server/portal/routes.js', import.meta.url)), 'utf8');
    const scope = readFileSync(fileURLToPath(new URL('../server/portal/scope.js', import.meta.url)), 'utf8');
    assert.equal(routes.includes('schema.js'), false);
    assert.equal(routes.includes('.from('), false);
    assert.match(scope, /eq\(billingObligations\.contactId, contactId\)/);
    for (const [, path] of PRACTICE_ROUTES) assert.match(routes, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(':id', '')));
  });
});

describe('practice portal', { skip: skipWithoutDatabase }, () => {
  let handle;
  let clerk;
  let app;
  let org;
  let practiceA;
  let practiceB;
  let practiceC;
  let owner;
  let jobA;
  let jobB;
  let tokenA;
  let tokenB;
  let tokenStaff;
  let tokenLab;
  const secretsB = [];

  before(async () => {
    handle = await freshDatabase();
    org = await createOrganisation(handle.db, { name: 'Example Lab', invoicePrefix: 'FL-' });
    practiceA = await createContact(handle.db, org.id, { kind: 'customer', name: 'Bright Smile Dental' });
    practiceB = await createContact(handle.db, org.id, { kind: 'customer', name: 'Harbour Smiles' });
    practiceC = await createContact(handle.db, org.id, { kind: 'customer', name: 'Coast Dental' });
    owner = await seedFirstOwner(handle.db, 'owner@example.test');
    await invitePerson(handle.db, { email: 'staff@example.test', name: 'Lab Staff', role: 'staff', invitedBy: owner.id });
    await handle.db.insert(invoicingSettings).values({
      organisationId: org.id,
      portalEnabled: true,
      portalStatusNames: { Booked: 'Ordered', 'In lab': 'In work', Checked: 'Quality check', Gone: 'Sent' },
      updatedBy: owner.id,
    });
    const line = (description) => [{ description, unitAmountCents: 16000 }];
    jobA = await observeJob(handle.db, org.id, {
      sourceSystem: 'bench', sourceJobRef: 'A-1', caseRef: '9001', contactId: practiceA.id,
      practitioner: 'Dr A. Example', jobDate: '2026-10-01', sourceStatus: 'In lab', lines: line('Zirconia crown'),
    });
    await observeJob(handle.db, org.id, {
      sourceSystem: 'bench', sourceJobRef: 'A-2', caseRef: '9002', contactId: practiceA.id,
      practitioner: 'Dr B. Sample', jobDate: '2026-10-01', sourceStatus: 'Gone', lines: line('Night guard'),
    });
    jobB = await observeJob(handle.db, org.id, {
      sourceSystem: 'bench', sourceJobRef: 'B-1', caseRef: '8001', contactId: practiceB.id,
      practitioner: 'Dr C. Other', jobDate: '2026-10-01', sourceStatus: 'In lab', lines: line('Bridge, 3 units'),
    });
    clerk = fakeClerk();
    const userA = clerk.addUser({ email: 'ada@bright.example.test', google: true, password: false });
    const userB = clerk.addUser({ email: 'beau@harbour.example.test', google: true, password: false });
    const userBoth = clerk.addUser({ email: 'both@example.test', google: true, password: false });
    tokenA = clerk.signIn(userA);
    tokenB = clerk.signIn(userB);
    tokenStaff = clerk.signIn(clerk.addUser({ email: 'staff@example.test', google: true, password: false }));
    tokenLab = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    await handle.db.insert(practiceMembers).values([
      { organisationId: org.id, contactId: practiceA.id, email: 'ada@bright.example.test', name: 'Ada Bright', role: 'owner', status: 'active', clerkUserId: userA, practitionerName: 'Dr A. Example' },
      { organisationId: org.id, contactId: practiceB.id, email: 'beau@harbour.example.test', name: 'Beau Harbour', role: 'owner', status: 'active', clerkUserId: userB, practitionerName: 'Dr C. Other' },
      { organisationId: org.id, contactId: practiceA.id, email: 'both@example.test', name: 'Both Practices', role: 'staff', status: 'active', clerkUserId: userBoth },
      { organisationId: org.id, contactId: practiceB.id, email: 'both@example.test', name: 'Both Practices', role: 'staff', status: 'active', clerkUserId: userBoth },
    ]);
    secretsB.push(practiceB.id, jobB.id, '8001', 'beau@harbour.example.test', 'Beau Harbour', 'Patient Harbour', 'Harbour Smiles');
    app = appFor(handle, clerk);
  });

  after(async () => handle?.close());

  test('practice A sees none of practice B', async () => {
    const paths = [
      '/portal/api/config',
      '/portal/api/me',
      '/portal/api/jobs',
      `/portal/api/jobs?practice=${practiceB.id}`,
      '/portal/api/team',
    ];
    for (const path of paths) {
      const res = await request(app, path, { token: tokenA });
      assert.equal(res.status, 200, path);
      assert.deepEqual(leaks(res.body, secretsB), [], path);
    }
    const missing = await request(app, `/portal/api/jobs/${jobB.id}`, { token: tokenA });
    assert.equal(missing.status, 404);
    assert.deepEqual(leaks(missing.body, secretsB), []);
    const jobs = await request(app, '/portal/api/jobs', { token: tokenA });
    assert.deepEqual(jobs.body.jobs.map((job) => job.caseRef).sort(), ['9001', '9002']);
    assert.equal(JSON.stringify(jobs.body).includes('Patient'), false);
    assert.equal(jobs.body.jobs.find((job) => job.caseRef === '9001').status, 'In work');
    assert.equal(jobs.body.jobs.find((job) => job.caseRef === '9002').status, 'Sent');
    const mine = await request(app, '/portal/api/jobs?mine=1', { token: tokenA });
    assert.deepEqual(mine.body.jobs.map((job) => job.caseRef), ['9001']);
    const both = clerk.signIn(await clerk.findUserIdByEmail('both@example.test'));
    const onlyA = await request(app, `/portal/api/jobs?practice=${practiceA.id}`, { token: both });
    const onlyB = await request(app, `/portal/api/jobs?practice=${practiceB.id}`, { token: both });
    assert.deepEqual(onlyA.body.jobs.map((job) => job.caseRef).sort(), ['9001', '9002']);
    assert.deepEqual(onlyB.body.jobs.map((job) => job.caseRef), ['8001']);
    const joined = await request(app, '/portal/api/join', {
      token: tokenA, method: 'POST', body: { name: 'Pat Pending', email: 'pat@bright.example.test', practiceName: 'Bright Smile Dental', phone: '555' },
    });
    assert.equal(joined.status, 201);
    assert.deepEqual(leaks(joined.body, secretsB), []);
    const added = await request(app, '/portal/api/team', {
      token: tokenA, method: 'POST', body: { email: 'temp@bright.example.test', name: 'Temp', role: 'staff' },
    });
    assert.equal(added.status, 201);
    assert.deepEqual(leaks(added.body, secretsB), []);
    const changed = await request(app, `/portal/api/team/${added.body.member.id}`, {
      token: tokenA, method: 'PATCH', body: { role: 'dentist', practitionerName: 'Dr Temp' },
    });
    assert.equal(changed.status, 200);
    const removed = await request(app, `/portal/api/team/${added.body.member.id}`, { token: tokenA, method: 'DELETE' });
    assert.equal(removed.status, 200);
    const foreign = await request(app, `/portal/api/team/${jobB.id}`, { token: tokenA, method: 'DELETE' });
    assert.equal(foreign.status, 404);
  });

  test('a lab session cannot open the portal, and a portal session cannot open the lab', async () => {
    const portal = await request(app, '/portal/api/jobs', { token: tokenStaff });
    assert.equal(portal.status, 403);
    assert.equal(portal.body.code, 'not_a_member');
    const lab = await request(app, '/api/me', { token: tokenA });
    assert.equal(lab.status, 403);
    assert.equal(lab.body.code, 'not_invited');
    const preview = await request(app, `/api/portal/preview?contactId=${practiceA.id}`, { token: tokenLab });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.jobs.map((job) => job.caseRef).sort(), ['9001', '9002']);
    const previewAsPortal = await request(app, `/api/portal/preview?contactId=${practiceA.id}`, { token: tokenA });
    assert.equal(previewAsPortal.status, 403);
  });

  test('join, approve and invite stay on one practice', async () => {
    const email = 'casey@coast.example.test';
    const joined = await request(app, '/portal/api/join', {
      method: 'POST', body: { name: 'Casey Coast', email, practiceName: 'Coast Dental', phone: '021000' },
    });
    assert.equal(joined.status, 201);
    const settings = await request(app, '/api/portal/settings', { token: tokenLab });
    const requestRow = settings.body.requests.find((row) => row.email === email);
    assert.ok(requestRow);
    const approved = await request(app, `/api/portal/requests/${requestRow.id}/approve`, {
      token: tokenLab, method: 'POST', body: { contactId: practiceC.id },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.member.role, 'owner');
    assert.equal(approved.body.invite.emailed, true);
    assert.equal(clerk.calls.invited.at(-1).redirectUrl.endsWith('/portal/sign-in'), true);
    const casey = clerk.signIn(await clerk.findUserIdByEmail(email));
    const me = await request(app, '/portal/api/me', { token: casey });
    assert.equal(me.status, 200);
    assert.equal(me.body.member.role, 'owner');
    assert.equal(me.body.member.status, 'active');
    assert.deepEqual(me.body.practices.map((row) => row.contactId), [practiceC.id]);
    const second = await request(app, '/portal/api/join', {
      method: 'POST', body: { name: 'Drew Coast', email: 'drew@coast.example.test', practiceName: 'Coast Dental' },
    });
    assert.equal(second.status, 201);
    const again = await request(app, '/api/portal/settings', { token: tokenLab });
    const drew = again.body.requests.find((row) => row.email === 'drew@coast.example.test');
    const drewApproved = await request(app, `/api/portal/requests/${drew.id}/approve`, {
      token: tokenLab, method: 'POST', body: { contactId: practiceC.id },
    });
    assert.equal(drewApproved.body.member.role, 'staff');
    const declinedJoin = await request(app, '/portal/api/join', {
      method: 'POST', body: { name: 'No Coast', email: 'no@coast.example.test', practiceName: 'Somewhere Else' },
    });
    assert.equal(declinedJoin.status, 201);
    const open = await request(app, '/api/portal/settings', { token: tokenLab });
    const no = open.body.requests.find((row) => row.email === 'no@coast.example.test');
    const declined = await request(app, `/api/portal/requests/${no.id}/decline`, { token: tokenLab, method: 'POST', body: {} });
    assert.equal(declined.status, 200);
    const contact = await request(app, `/api/portal/contacts/${practiceC.id}`, { token: tokenLab });
    assert.equal(contact.body.requests.some((row) => row.email === 'no@coast.example.test'), false);
    assert.equal(contact.body.members.some((row) => row.email === email), true);
  });

  test('the last owner stays, and an admin cannot change an owner', async () => {
    const team = await request(app, '/portal/api/team', { token: clerk.signIn(await clerk.findUserIdByEmail('casey@coast.example.test')) });
    const casey = team.body.team.find((row) => row.email === 'casey@coast.example.test');
    const self = await request(app, `/portal/api/team/${casey.id}`, {
      token: clerk.signIn(await clerk.findUserIdByEmail('casey@coast.example.test')), method: 'DELETE',
    });
    assert.equal(self.status, 403);
    const invited = await request(app, '/portal/api/team', {
      token: clerk.signIn(await clerk.findUserIdByEmail('casey@coast.example.test')),
      method: 'POST', body: { email: 'admin@coast.example.test', name: 'Ari Admin', role: 'admin' },
    });
    assert.equal(invited.status, 201);
    assert.equal(clerk.calls.invited.at(-1).redirectUrl.endsWith('/portal/sign-in'), true);
    const adminToken = clerk.signIn(await clerk.findUserIdByEmail('admin@coast.example.test'));
    const asAdmin = await request(app, `/portal/api/team/${casey.id}`, { token: adminToken, method: 'DELETE' });
    assert.equal(asAdmin.status, 403);
    assert.match(asAdmin.body.error, /admin cannot change an owner/i);
    const ownerInvite = await request(app, '/portal/api/team', {
      token: adminToken, method: 'POST', body: { email: 'second-owner@coast.example.test', role: 'owner' },
    });
    assert.equal(ownerInvite.status, 403);
    const second = await request(app, '/portal/api/team', {
      token: clerk.signIn(await clerk.findUserIdByEmail('casey@coast.example.test')),
      method: 'POST', body: { email: 'ollie@coast.example.test', name: 'Ollie Owner', role: 'owner' },
    });
    assert.equal(second.status, 201);
    const ollieToken = clerk.signIn(await clerk.findUserIdByEmail('ollie@coast.example.test'));
    const removed = await request(app, `/portal/api/team/${casey.id}`, { token: ollieToken, method: 'DELETE' });
    assert.equal(removed.status, 200);
    const ollie = (await request(app, '/portal/api/team', { token: ollieToken })).body.team.find((row) => row.email === 'ollie@coast.example.test');
    await assert.rejects(
      () => removeMember(handle.db, {
        organisationId: org.id, contactId: practiceC.id, id: ollie.id,
        actor: { id: casey.id, role: 'owner', status: 'active', contactId: practiceC.id },
      }),
      /at least one active owner/,
    );
  });

  test('a removed person can be invited again', async () => {
    const ollieToken = clerk.signIn(await clerk.findUserIdByEmail('ollie@coast.example.test'));
    const again = await request(app, '/portal/api/team', {
      token: ollieToken, method: 'POST', body: { email: 'casey@coast.example.test', name: 'Casey Coast', role: 'staff' },
    });
    assert.equal(again.status, 201);
    assert.equal(again.body.member.role, 'staff');
    assert.equal(again.body.member.status, 'active');
  });

  test('the portal can be turned off, and view stays read only', async () => {
    const off = await request(app, '/api/portal/settings', { token: tokenLab, method: 'PUT', body: { enabled: false, names: {} } });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    const jobs = await request(app, '/portal/api/jobs', { token: tokenA });
    assert.equal(jobs.status, 403);
    assert.equal(jobs.body.code, 'portal_off');
    const joined = await request(app, '/portal/api/join', {
      method: 'POST', body: { name: 'Late', email: 'late@example.test', practiceName: 'Bright Smile Dental' },
    });
    assert.equal(joined.status, 403);
    assert.equal(joined.body.code, 'portal_off');
    const preview = await request(app, `/api/portal/preview?contactId=${practiceA.id}`, { token: tokenLab });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.jobs.length, 2);
    const on = await request(app, '/api/portal/settings', {
      token: tokenLab, method: 'PUT', body: { enabled: true, names: { 'In lab': 'In work', Gone: 'Sent' } },
    });
    assert.equal(on.body.enabled, true);
    const back = await request(app, '/portal/api/jobs', { token: tokenA });
    assert.equal(back.status, 200);
  });

  test('join is rate limited', async () => {
    const limited = appFor(handle, clerk, { signInRateLimitPerMinute: 2 });
    const body = { name: 'Rate', email: 'rate@example.test', practiceName: 'Bright Smile Dental' };
    assert.equal((await request(limited, '/portal/api/join', { method: 'POST', body })).status, 201);
    assert.equal((await request(limited, '/portal/api/join', { method: 'POST', body })).status, 201);
    const blocked = await request(limited, '/portal/api/join', { method: 'POST', body });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'rate_limited');
  });
});
