import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { googleWorkspaceOwner, resolveClerkProxyPath, secondFactorVerified } from '../server/auth/clerk.js';
import { clerkScriptUrl } from '../server/auth/routes.js';
import { createPersonAuth } from '../server/auth/session.js';
import { resolveSignInSettings } from '../server/auth/settings.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';

// Sign-in pieces that need no database. Clerk is faked; no real keys.
const SECRET = 'sk_test_not-a-real-key';

describe('sign-in settings', () => {
  test('sign-in is off until FLOW_AUTH=clerk, and a typo stops boot', () => {
    assert.deepEqual(resolveSignInSettings({}), { mode: 'off' });
    assert.throws(() => resolveSignInSettings({ FLOW_AUTH: 'clerck' }), /FLOW_AUTH must be "clerk" or unset/);
  });

  test('public sign-up is off by default', () => {
    const settings = resolveSignInSettings({ FLOW_AUTH: 'clerk', CLERK_SECRET_KEY: SECRET, CLERK_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY });
    assert.equal(settings.publicSignUp, false);
    assert.equal(resolveSignInSettings({ FLOW_AUTH: 'clerk', CLERK_SECRET_KEY: SECRET, CLERK_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY, FLOW_PUBLIC_SIGN_UP: 'on' }).publicSignUp, true);
    assert.throws(() => resolveSignInSettings({ FLOW_AUTH: 'clerk', CLERK_SECRET_KEY: SECRET, CLERK_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY, FLOW_PUBLIC_SIGN_UP: 'yes' }), /FLOW_PUBLIC_SIGN_UP/);
  });

  test('a missing or malformed key names the variable, never the value', () => {
    assert.throws(() => resolveSignInSettings({ FLOW_AUTH: 'clerk' }), /needs CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY/);
    assert.throws(
      () => resolveSignInSettings({ FLOW_AUTH: 'clerk', CLERK_SECRET_KEY: 'leaked-value', CLERK_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY }),
      (error) => /CLERK_SECRET_KEY is not a Clerk secret key/.test(error.message) && !error.message.includes('leaked-value'),
    );
  });

  test('owner settings: Google domains, second-factor age, first owner', () => {
    const settings = resolveSignInSettings({
      FLOW_AUTH: 'clerk',
      CLERK_SECRET_KEY: SECRET,
      VITE_CLERK_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY,
      FLOW_OWNER_GOOGLE_DOMAINS: 'Example.test, example.test',
      FLOW_OWNER_MFA_MAX_AGE: '90m',
      FLOW_FIRST_OWNER_EMAIL: 'Owner@Example.test',
      FLOW_PUBLIC_ORIGIN: 'https://flow.example.test/path',
    });
    assert.deepEqual(settings.ownerGoogleDomains, ['example.test']);
    assert.equal(settings.ownerMfaMaxAgeMinutes, 90);
    assert.equal(settings.firstOwnerEmail, 'owner@example.test');
    assert.deepEqual(settings.authorizedParties, ['https://flow.example.test']);
    assert.equal(settings.keys.publishableSource, 'VITE_CLERK_PUBLISHABLE_KEY');
    assert.throws(() => resolveSignInSettings({ FLOW_AUTH: 'clerk', CLERK_SECRET_KEY: SECRET, CLERK_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY, FLOW_FIRST_OWNER_EMAIL: 'ówner@example.test' }), /plain/);
  });
});

describe('owner verification', () => {
  const googleOwner = {
    passwordEnabled: false,
    externalAccounts: [{ provider: 'oauth_google', emailAddress: 'owner@example.test', verification: { status: 'verified' } }],
  };

  test('Google Workspace on an allowed domain with no password', () => {
    assert.equal(googleWorkspaceOwner(googleOwner, 'owner@example.test', ['example.test']), true);
    assert.equal(googleWorkspaceOwner(googleOwner, 'owner@example.test', []), false);
    assert.equal(googleWorkspaceOwner(googleOwner, 'owner@example.test', ['other.test']), false);
    assert.equal(googleWorkspaceOwner({ ...googleOwner, passwordEnabled: true }, 'owner@example.test', ['example.test']), false);
    assert.equal(googleWorkspaceOwner(googleOwner, 'someone@example.test', ['example.test']), false);
  });

  test('a second factor counts only while recent', () => {
    assert.equal(secondFactorVerified({ factorVerificationAge: [3, 3] }, 60), true);
    assert.equal(secondFactorVerified({ factorVerificationAge: [3, -1] }, 60), false);
    assert.equal(secondFactorVerified({ factorVerificationAge: [90, 90] }, 60), false);
    assert.equal(secondFactorVerified({}, 60), false);
  });
});

describe('sign-in routes without a database', () => {
  test('the sign-in page loads Clerk from the Frontend API or the proxy', () => {
    assert.equal(clerkScriptUrl({ publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null }), 'https://clerk.example.test/npm/@clerk/clerk-js@6/dist/clerk.browser.js');
    assert.equal(clerkScriptUrl({ publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: '/api/__clerk/' }), '/api/__clerk/npm/@clerk/clerk-js@6/dist/clerk.browser.js');
    assert.equal(resolveClerkProxyPath('https://flow.example.test/api/__clerk/'), '/api/__clerk');
    assert.equal(resolveClerkProxyPath(''), null);
  });

  test('with sign-in off, person routes answer 503 and nothing is open', async () => {
    const app = createApp();
    assert.deepEqual((await request(app, '/api/auth/config')).body, { ok: true, mode: 'off' });
    const me = await request(app, '/api/me', { token: 'anything' });
    assert.equal(me.status, 503);
    assert.equal(me.body.code, 'sign_in_not_configured');
    assert.equal((await request(app, '/api/people', { method: 'POST', body: { email: 'a@example.test', role: 'owner' } })).status, 503);
  });

  test('config tells the sign-in page that public sign-up is off', async () => {
    const clerk = fakeClerk();
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null }, publicSignUp: false };
    const app = createApp({ auth: { settings, clerk, personAuth: createPersonAuth({ db: {}, clerk }) } });
    const config = await request(app, '/api/auth/config');
    assert.equal(config.body.mode, 'clerk');
    assert.equal(config.body.publicSignUp, false);
    assert.equal(config.body.clerk.publishableKey, TEST_PUBLISHABLE_KEY);
    assert.ok(!config.text.includes('sk_'), 'the secret key is never served');
    const page = await request(app, '/sign-in');
    assert.equal(page.status, 200);
    assert.match(page.text, /transferable: config\.publicSignUp/);
  });

  test('requests are rate limited per client', async () => {
    const app = createApp({ rateLimitPerMinute: 2 });
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/auth/config`;
      const statuses = [];
      for (let i = 0; i < 3; i += 1) statuses.push((await fetch(url)).status);
      assert.deepEqual(statuses, [200, 200, 429]);
    } finally {
      server.close();
    }
  });
});
