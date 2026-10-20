import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backgroundJobsOn, isReplitWorkspace } from '../server/core/host.js';
import { resolveSeazonaSettings } from '../server/integrations/seazona/settings.js';
import { readSentrySettings } from '../server/integrations/sentry/index.js';
import { resolveXeroSettings, writesAllowed } from '../server/integrations/xero/settings.js';

// A Replit workspace shares the published app's secrets. It must not sync,
// draft or send next to the live copy, and its errors are labelled apart.
// Synthetic values only (CONTRIBUTING.md).
const WORKSPACE = { REPL_ID: 'repl-example' };
const PUBLISHED = { REPL_ID: 'repl-example', REPLIT_DEPLOYMENT: '1' };

test('a Replit workspace is REPL_ID without REPLIT_DEPLOYMENT', () => {
  assert.equal(isReplitWorkspace(WORKSPACE), true);
  assert.equal(isReplitWorkspace(PUBLISHED), false);
  assert.equal(isReplitWorkspace({}), false);
});

test('background jobs are off in a Replit workspace and on elsewhere, unless set', () => {
  assert.equal(backgroundJobsOn(WORKSPACE), false);
  assert.equal(backgroundJobsOn(PUBLISHED), true);
  assert.equal(backgroundJobsOn({}), true);
  assert.equal(backgroundJobsOn({ ...WORKSPACE, FLOW_BACKGROUND_JOBS: 'on' }), true);
  assert.equal(backgroundJobsOn({ FLOW_BACKGROUND_JOBS: 'off' }), false);
  assert.throws(() => backgroundJobsOn({ FLOW_BACKGROUND_JOBS: 'maybe' }), /FLOW_BACKGROUND_JOBS must be/);
});

test('in a Replit workspace the Seazona timer does not start', () => {
  const seazona = { SEAZONA_MODE: 'live', SEAZONA_API_BASE_URL: 'https://api.example.test', SEAZONA_API_CLIENT_ID: 'id-example', SEAZONA_API_CLIENT_SECRET: 'secret-example' };
  assert.equal(resolveSeazonaSettings({ ...seazona, ...PUBLISHED }).scheduled, true);
  assert.equal(resolveSeazonaSettings({ ...seazona, ...WORKSPACE }).scheduled, false);
});

test('in a Replit workspace Xero is read-only, whatever XERO_ALLOW_LIVE_WRITES says', () => {
  const xero = { XERO_MODE: 'live', XERO_CLIENT_ID: 'synthetic-id', XERO_CLIENT_SECRET: 'synthetic-secret', XERO_TOKEN_KEY: 'a'.repeat(64), XERO_TENANT_NAME: 'Example Lab', XERO_ALLOW_LIVE_WRITES: 'on' };
  assert.equal(writesAllowed(resolveXeroSettings({ ...xero, ...PUBLISHED })), true);
  const workspace = resolveXeroSettings({ ...xero, ...WORKSPACE });
  assert.equal(workspace.backgroundJobs, false);
  assert.equal(writesAllowed(workspace), false);
});

test('a Replit workspace reports to Sentry as "workspace", not "production"', () => {
  const dsn = 'https://0123456789abcdef0123456789abcdef@o1.ingest.example.test/42';
  assert.equal(readSentrySettings({ SENTRY_DSN: dsn, ...WORKSPACE }).environment, 'workspace');
  assert.equal(readSentrySettings({ SENTRY_DSN: dsn, ...PUBLISHED }).environment, 'production');
  assert.equal(readSentrySettings({ SENTRY_DSN: dsn, ...WORKSPACE, SENTRY_ENVIRONMENT: 'staging' }).environment, 'staging');
});
