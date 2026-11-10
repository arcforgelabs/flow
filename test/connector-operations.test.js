import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import express from 'express';
import inject from 'light-my-request';
import { createConnectorApi } from '../server/api/connector.js';
import { canonicalRequest } from '../server/core/connector-auth.js';
import { FLOW_VERSION, decideOperation, operationRevision, roleAllowed } from '../server/core/operations.js';
import { createFlowClient, registerFlowPlugin } from '../plugins/flow/client.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const person = { id: '00000000-0000-4000-8000-000000000001', role: 'staff', status: 'active' };
const owner = { ...person, role: 'owner' };
const keys = [{ id: 'gateway', publicKey, personId: person.id }];

function appFor(findPerson = async () => person, execute = async (id, actor, input) => ({ id, role: actor.role, input })) {
  const app = express();
  app.use('/api/flow/v1', createConnectorApi({ keys, findPerson, execute, now: () => 1_700_000_000_000 }));
  return app;
}

async function send(app, { method = 'POST', path = '/api/flow/v1/operations/invoices.updateDraft', body = { reference: 'A' }, key = privateKey, keyId = 'gateway', timestamp = 1_700_000_000 } = {}) {
  const raw = method === 'GET' ? '' : JSON.stringify(body);
  const signature = sign(null, Buffer.from(canonicalRequest({ method, path, timestamp, body: raw })), key).toString('base64');
  return inject(app, {
    method,
    url: path,
    headers: {
      'content-type': 'application/json',
      'x-flow-key-id': keyId,
      'x-flow-timestamp': String(timestamp),
      'x-flow-signature': signature,
    },
    payload: raw,
  });
}

test('a bad connector key is still refused', async () => {
  const other = generateKeyPairSync('ed25519');
  const response = await send(appFor(), { key: other.privateKey });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, 'connector_signature_required');
});

test('a valid connector key can edit a draft the person can already edit', async () => {
  const response = await send(appFor());
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().result.role, 'staff');
  assert.equal(response.json().flowVersion, FLOW_VERSION);
});

test('the connector refuses financial send for an owner', async () => {
  const response = await send(appFor(async () => owner), { path: '/api/flow/v1/operations/invoices.send', body: {} });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, 'operation_not_in_slice');
});

test('the operation layer is the role check for the web app and the connector', () => {
  assert.equal(roleAllowed({ role: 'staff', status: 'active' }, ['owner', 'admin']), false);
  assert.equal(decideOperation({ role: 'staff', status: 'active' }, 'invoices.send', { surface: 'web' }).code, 'role_required');
  assert.equal(decideOperation(owner, 'invoices.updateDraft', { surface: 'connector' }).ok, true);
  assert.equal(decideOperation({ role: 'staff', status: 'disabled' }, 'jobs.list', { surface: 'connector' }).code, 'access_disabled');
});

test('the plugin page and tools refuse a Flow operation mismatch', async () => {
  const calls = [];
  const fetch = async () => ({ ok: true, json: async () => ({ ok: true, flowVersion: 'other', operationRevision: operationRevision() }) });
  const client = createFlowClient({
    baseUrl: 'https://flow.example.test',
    keyId: 'gateway',
    privateKey,
    flowVersion: FLOW_VERSION,
    fetch,
    now: () => 1_700_000_000_000,
  });
  const api = { registerTool(tool) { calls.push(tool.name); } };
  registerFlowPlugin(api, client);
  assert.equal(calls.length, 5);
  await assert.rejects(() => client.status(), /does not match/);
});

test('no connector key still refuses every request', async () => {
  const app = express();
  app.use('/api/flow/v1', createConnectorApi({ keys: [] }));
  const response = await inject(app, { method: 'GET', url: '/api/flow/v1' });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, 'connector_signature_required');
});
