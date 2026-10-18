import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { deployedBuildStatus } from '../server/deployed-build.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const BUILD = { revision: COMMIT, ref: 'stable', source: 'github', checks: 'passed', release: 'v2026.10.18' };

async function get(app, path) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { res, body: await res.json() };
  } finally {
    server.close();
  }
}

test('GET /health answers ok with the running build, without exposing the framework', async () => {
  const { res, body } = await get(createApp({ build: BUILD }), '/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.deepEqual(body, { ok: true, service: 'flow', database: null, build: BUILD });
});

test('GET /health answers 503 when the database does not answer', async () => {
  const database = { pool: { query: async () => { throw new Error('down'); } } };
  const { res, body } = await get(createApp({ build: BUILD, database }), '/health');
  assert.equal(res.status, 503);
  assert.deepEqual(body, { ok: false, service: 'flow', database: false, build: BUILD });
});

test('the build is the commit, the deployed ref, its source, its CI result and the release, or null', () => {
  const unknown = { revision: null, ref: null, source: null, checks: null, release: null };
  assert.deepEqual(deployedBuildStatus({}), unknown);
  assert.deepEqual(
    deployedBuildStatus({ FLOW_REVISION: ` ${COMMIT}\n`, FLOW_DEPLOYED_REF: 'main', FLOW_DEPLOYED_FROM: 'github', FLOW_DEPLOYED_CHECKS: 'passed' }),
    { revision: COMMIT, ref: 'main', source: 'github', checks: 'passed', release: null },
  );
  assert.equal(deployedBuildStatus({ FLOW_DEPLOYED_REF: 'stable', FLOW_DEPLOYED_RELEASE: 'v2026.10.18' }).release, 'v2026.10.18');
  assert.equal(deployedBuildStatus({ FLOW_RELEASE: 'v2026.10.18-beta.2' }).release, 'v2026.10.18-beta.2');
  assert.deepEqual(deployedBuildStatus({ FLOW_REVISION: '  ' }), unknown);
});

test('GET /api/updates answers 503 while sign-in is off; the log carries the notice', async () => {
  const updates = { status: async () => assert.fail('must not check while nobody can read it') };
  const { res, body } = await get(createApp({ build: BUILD, updates }), '/api/updates');
  assert.equal(res.status, 503);
  assert.equal(body.code, 'sign_in_not_configured');
});

test('flow-server, the installed package\'s command, reports the package version as the release', () => {
  // flow-server sets FLOW_RELEASE from package.json before it starts the
  // server; stop it at the import of server/index.js, which needs a database.
  const script = `
    process.env.DATABASE_URL = '';
    await import(${JSON.stringify(join(import.meta.dirname, '../server/flow-server.js'))}).catch(() => {});
    console.log(process.env.FLOW_RELEASE ?? '');
  `;
  const run = (env) => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).trim();
  const { version } = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'));
  assert.equal(run({}), `v${version}`);
  assert.equal(run({ FLOW_RELEASE: 'v2026.1.1' }), 'v2026.1.1');
});
