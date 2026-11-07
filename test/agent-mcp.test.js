import assert from 'node:assert/strict';
import { test, describe, before, after, mock } from 'node:test';
import express from 'express';
import inject from 'light-my-request';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createClerkClient } from '@clerk/backend';
import { createApp } from '../server/app.js';
import { createMcpVerifier } from '../server/agents/auth.js';
import { readOnly } from '../server/agents/gate.js';
import { resolveMcpSettings } from '../server/agents/settings.js';
import { createPersonAuth } from '../server/auth/session.js';
import { removePerson } from '../server/auth/people.js';
import { createOrganisation } from '../server/core/directory.js';
import { fakeClerk, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

const resource = 'https://flow.example.test/mcp';
const quiet = { info() {}, warn() {}, error() {} };
const rpc = (name = 'flow_connection', args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
// In-process HTTP preserves the real Express and SDK transport. It makes no
// network request and does not change the host's protected egress proxy.
const apps = new Map();
async function listen(app) {
  const url = 'https://fixture-' + apps.size + '.example.test';
  apps.set(url, app);
  return { server: url, url };
}
async function close(origin) { apps.delete(origin); }
async function fetch(input, init) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const app = apps.get(url.origin);
  if (!app) throw new Error('No synthetic HTTP fixture for this origin');
  const response = await inject(app, {
    method: request.method, url: url.pathname + url.search,
    headers: Object.fromEntries(request.headers),
    ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { payload: await request.text() }),
  });
  return new Response([204, 304].includes(response.statusCode) ? null : response.rawPayload, { status: response.statusCode, headers: response.headers });
}

test('MCP deployment is off by default and rejects an untrusted resource identity', () => {
  assert.equal(resolveMcpSettings({}), null);
  assert.equal(resolveMcpSettings({ FLOW_MCP: 'off' }), null);
  for (const origin of ['http://flow.example.test', 'https://flow.example.test/other', 'https://a:b@flow.example.test', 'https://flow.example.test?x=1']) {
    assert.throws(() => resolveMcpSettings({ FLOW_MCP: 'on', FLOW_PUBLIC_ORIGIN: origin }));
  }
  assert.equal(resolveMcpSettings({ FLOW_MCP: 'on', FLOW_PUBLIC_ORIGIN: 'https://flow.example.test' }).resource, resource);
});

describe('MCP OAuth and grant boundary with synthetic PostgreSQL', { skip: skipWithoutDatabase }, () => {
  let database, upstream, flow, off, clerk, owner, other, lab, grant, browserToken, mcpConfig, browserAuth;
  const tokens = new Map();
  const nodeEnv = process.env.NODE_ENV;
  async function post(body = rpc(), token = 'oat_valid') {
    return fetch(flow.url + '/mcp', { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    }, body: JSON.stringify(body) });
  }
  async function settle() {
    // Audit cleanup runs on response close. Wait for its checked-out client.
    for (let n = 0; n < 100 && database.pool.idleCount !== database.pool.totalCount; n++) await new Promise((r) => setTimeout(r, 5));
  }
  before(async () => {
    database = await freshDatabase();
    lab = await createOrganisation(database.db, { name: 'Synthetic lab' });
    const people = await database.pool.query("INSERT INTO people (email,role,status,clerk_user_id) VALUES ('owner@example.test','owner','active','user_owner'), ('other@example.test','staff','active','user_other') RETURNING *");
    [owner, other] = people.rows;
    const grants = await database.pool.query('INSERT INTO agent_grants (person_id,client_id,app_name,resource,organisation_id) VALUES ($1,$2,$3,$4,$5) RETURNING *', [owner.id, 'client_test', 'Synthetic client', resource, lab.id]);
    grant = grants.rows[0];
    const base = { object: 'clerk_idp_oauth_access_token', type: 'oauth_token', id: 'oat_test', client_id: 'client_test', subject: 'user_owner', scopes: [], revoked: false, expired: false, expiration: Math.floor(Date.now() / 1000) + 600, created_at: 1, updated_at: 1, aud: [resource] };
    tokens.set('oat_valid', base);
    tokens.set('oat_wrong_audience', { ...base, aud: ['https://other.example.test/mcp'] });
    tokens.set('oat_no_audience', { ...base, aud: undefined });
    tokens.set('oat_expired', { ...base, expired: true, expiration: 1 });
    tokens.set('oat_unbounded', { ...base, expiration: null });
    tokens.set('oat_other_person', { ...base, subject: 'user_other' });
    tokens.set('oat_other_client', { ...base, client_id: 'another_client' });
    const api = express();
    api.use(express.json());
    api.post('/oauth_applications/access_tokens/verify', (req, res) => {
      const value = tokens.get(req.body.access_token);
      if (!value) return res.status(401).json({ errors: [{ code: 'invalid_token', message: 'Synthetic invalid token' }] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    });
    upstream = await listen(api);
    process.env.NODE_ENV = 'test';
    mock.method(globalThis, 'fetch', fetch);
    const client = createClerkClient({ publishableKey: TEST_PUBLISHABLE_KEY, secretKey: 'sk_test_synthetic_only', apiUrl: upstream.url, telemetry: { disabled: true } });
    const verify = createMcpVerifier({ keys: {}, resource, client });
    clerk = fakeClerk();
    const id = clerk.addUser({ id: 'user_owner', email: owner.email });
    browserToken = clerk.signIn(id, { secondFactorAge: 0 });
    const personAuth = createPersonAuth({ db: database.db, clerk, log: quiet });
    browserAuth = { settings: { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY } }, clerk, personAuth };
    mcpConfig = { resource, verify, publishableKey: TEST_PUBLISHABLE_KEY };
    flow = await listen(createApp({ database, auth: browserAuth, mcp: mcpConfig, log: quiet }));
    off = await listen(createApp({ database, auth: browserAuth, log: quiet }));
  });
  after(async () => {
    await close(flow.server); await close(off.server); await close(upstream.server);
    await settle(); await database.close();
    mock.restoreAll();
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  });
  test('off means no MCP or resource discovery route', async () => {
    assert.equal((await fetch(off.url + '/mcp', { method: 'POST' })).status, 404);
    assert.equal((await fetch(off.url + '/.well-known/oauth-protected-resource/mcp')).status, 404);
  });
  test('no token, invalid, browser, wrong audience, no audience and expired tokens fail', async () => {
    for (const token of [null, 'oat_bad', browserToken, 'oat_wrong_audience', 'oat_no_audience', 'oat_expired', 'oat_unbounded']) {
      const res = await post(rpc(), token);
      assert.equal(res.status, 401, token);
      assert.equal(res.headers.get('www-authenticate'), 'Bearer resource_metadata="https://flow.example.test/.well-known/oauth-protected-resource/mcp"');
      assert.equal((await res.json()).code, 'invalid_token');
    }
    assert.equal((await database.pool.query('SELECT failure_count FROM agent_grants WHERE id=$1', [grant.id])).rows[0].failure_count, 0);
  });
  test('discovery fixes the resource to deployment identity, not a Host header', async () => {
    const res = await fetch(flow.url + '/.well-known/oauth-protected-resource/mcp', { headers: { Host: 'attacker.example.test' } });
    const body = await res.json();
    assert.equal(body.resource, resource);
    assert.deepEqual(body.authorization_servers, ['https://clerk.example.test']);
  });
  test('real SDK initializes, lists exactly four read tools, and calls a bounded read-only result', async () => {
    const client = new Client({ name: 'synthetic-proof', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(flow.url + '/mcp'), { fetch, requestInit: { headers: { Authorization: 'Bearer oat_valid' } } }));
    const list = await client.listTools();
    assert.deepEqual(list.tools.map((t) => t.name), ['flow_connection','flow_invoice_diagnosis','flow_job_read','flow_health_read']);
    assert.ok(Buffer.byteLength(JSON.stringify(list)) < 32768);
    assert.ok(list.tools.every(t=>t.annotations.readOnlyHint===true));
    const result = await client.callTool({ name: 'flow_connection', arguments: {} });
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.data.grantId, grant.id);
    assert.equal(result.structuredContent.data.organisationId, lab.id);

    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
    await assert.rejects(()=>client.callTool({ name:'flow_connection', arguments:{organisationId:'elsewhere',server:'https://elsewhere.example.test'} }), /invalid_arguments/);
    await client.close(); await settle();
    const audits = await database.pool.query("SELECT * FROM agent_audit WHERE tool='flow_connection'");
    assert.ok(audits.rows.some(r=>r.status===200&&r.row_count===1));
    assert.ok(audits.rows.some(r=>r.status===400));
  });
  test('a grant never follows another person, client or instance', async () => {
    for (const token of ['oat_other_person', 'oat_other_client']) assert.equal((await post(rpc(), token)).status, 401);
    await database.pool.query('UPDATE agent_grants SET resource=$2 WHERE id=$1', [grant.id, 'https://another.example.test/mcp']);
    assert.equal((await post()).status, 401);
    await database.pool.query('UPDATE agent_grants SET resource=$2 WHERE id=$1', [grant.id, resource]);
  });
  test('pending, disabled and unlinked people lose access without profile writes', async () => {
    for (const status of ['pending', 'disabled']) {
      await database.pool.query('UPDATE people SET status=$2 WHERE id=$1', [owner.id, status]);
      assert.equal((await post()).status, 401);
    }
    await database.pool.query("UPDATE people SET status='active', clerk_user_id=NULL WHERE id=$1", [owner.id]);
    assert.equal((await post()).status, 401);
    assert.equal((await database.pool.query('SELECT name FROM people WHERE id=$1', [owner.id])).rows[0].name, null);
    await database.pool.query("UPDATE people SET clerk_user_id='user_owner' WHERE id=$1", [owner.id]);
  });
  test('unapproved tools are blocked, including job, invoice, source and financial operations', async () => {
    for (const name of ['flow_status', 'flow_job_get', 'flow_invoice_get', 'flow_sync_run', 'flow_invoice_send', 'flow_invoice_issue', 'flow_invoice_void', 'flow_invoice_approve', 'flow_mark_paid', 'flow_people_set', 'flow_settings_set']) {
      const res = await post(rpc(name));
      assert.equal(res.status, 404, name);
      await settle();
    }
    assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM invoices')).rows[0].n, 0);
    assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n, 0);
    assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM background_jobs')).rows[0].n, 0);
  });
  test('every registered tool also sheds for the worker queue', async () => {
    await database.pool.query("INSERT INTO background_jobs (organisation_id,kind,dedupe_key) SELECT $1,'agent-fixture',n::text FROM generate_series(1,101) AS n", [lab.id]);
    for (const [name,args] of [['flow_connection',{}],['flow_health_read',{}],['flow_invoice_diagnosis',{invoiceId:'00000000-0000-4000-8000-000000000000'}],['flow_job_read',{jobId:'00000000-0000-4000-8000-000000000000'}]]) {
      const response=await post(rpc(name,args));assert.equal(response.status,503,name);
      assert.equal((await response.json()).code,'worker_busy');
      assert.ok(Number(response.headers.get('retry-after'))>0);await settle();
    }
    await settle();
    await database.pool.query("DELETE FROM background_jobs WHERE kind='agent-fixture'");
  });
  test('PostgreSQL itself rejects writes inside the domain transaction', async () => {
    const client = await database.pool.connect();
    try {
      await assert.rejects(readOnly(client, (db) => db.query("INSERT INTO organisations (name) VALUES ('Must not exist')")), { code: '25006' });
      assert.equal((await client.query("SELECT count(*)::int AS n FROM organisations WHERE name='Must not exist'")).rows[0].n, 0);
      await assert.rejects(readOnly(client, (db) => db.query('SELECT pg_sleep(6)')), { code: '57014' });
      assert.equal((await client.query('SELECT 1 AS n')).rows[0].n, 1);
    } finally { client.release(); }
  });
  test('oversized bodies and reflected identifiers have finite fixed errors', async () => {
    const reflected=await post({...rpc(),id:'PRIVATE'.repeat(2000)});
    assert.equal(reflected.status,400);assert.ok((await reflected.text()).length<300);
    await settle();
    assert.equal((await post({ huge: 'x'.repeat(102401) })).status, 413);
  });
  test('a person cannot list or revoke another grant, or provision a grant without owner verification', async () => {
    const otherToken = clerk.signIn(clerk.addUser({ id: 'user_other', email: other.email }));
    const headers = { Authorization: 'Bearer ' + otherToken, 'Content-Type': 'application/json' };
    const list = await fetch(flow.url + '/api/agent-grants', { headers });
    assert.deepEqual((await list.json()).grants, []);
    assert.equal((await fetch(flow.url + '/api/agent-grants/' + grant.id + '/revoke', { method: 'POST', headers })).status, 404);
    assert.equal((await fetch(flow.url + '/api/agent-grants', { method: 'POST', headers, body: JSON.stringify({ clientId: 'x', appName: 'x', organisationId: lab.id }) })).status, 403);
  });
  test('grant and person removal deny access without erasing their read audits', async () => {
    const provision = () => database.pool.query('INSERT INTO agent_grants (person_id,client_id,app_name,resource,organisation_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [other.id, 'client_test', 'Deleted person test', resource, lab.id]);
    const first = (await provision()).rows[0];
    assert.equal((await post(rpc(), 'oat_other_person')).status, 200);
    await settle();
    const history = () => database.pool.query('SELECT id,grant_id,person_id,tool,status,row_count,duration_ms,created_at FROM agent_audit WHERE person_id=$1 ORDER BY created_at,id', [other.id]);
    const beforeGrant = (await history()).rows;
    assert.ok(beforeGrant.some(row => row.grant_id === first.id && row.tool === 'flow_connection' && row.status === 200));
    await database.pool.query('DELETE FROM agent_grants WHERE id=$1', [first.id]);
    assert.deepEqual((await history()).rows, beforeGrant);
    assert.equal((await post(rpc(), 'oat_other_person')).status, 401);
    await provision();
    assert.equal((await post(rpc(), 'oat_other_person')).status, 200);
    await settle();
    const beforePerson = (await history()).rows;
    assert.ok(beforePerson.length > beforeGrant.length);
    await removePerson(database.db, { id: other.id, actorId: owner.id });
    assert.deepEqual((await history()).rows, beforePerson);
    assert.equal((await database.pool.query('SELECT id FROM agent_grants WHERE person_id=$1', [other.id])).rowCount, 0);
    assert.equal((await post(rpc(), 'oat_other_person')).status, 401);
  });
  test('exact-ID diagnosis and job reads return bounded source evidence, safe existing links, and no patient or source text', async () => {
    await database.pool.query('UPDATE agent_grants SET failure_count=0,failure_day=NULL,paused_at=NULL WHERE id=$1',[grant.id]);
    const contact = (await database.pool.query("INSERT INTO contacts(organisation_id,kind,name) VALUES ($1,'customer','PRIVATE PATIENT') RETURNING id",[lab.id])).rows[0];
    const invoice = (await database.pool.query("INSERT INTO invoices(organisation_id,contact_id,reference,send_state,send_error,subtotal_cents,tax_cents,total_cents) VALUES ($1,$2,'PRIVATE PATIENT','failed',$3,10000,0,10000) RETURNING id",[lab.id,contact.id,JSON.stringify({code:'not_ready',message:'PRIVATE TOKEN / PATIENT',raw:{secret:'PRIVATE RAW'}})])).rows[0];
    const job = (await database.pool.query("INSERT INTO billing_obligations(organisation_id,source_system,source_job_ref,line_fingerprint,subtotal_cents,tax_cents,total_cents,mapping_complete,source_seen_at,invoice_id,hold_state,hold_reason,lines) VALUES ($1,'synthetic','PRIVATE SOURCE','fixture',10000,0,10000,false,'2026-11-01T00:00:00Z',$2,'review','PRIVATE HOLD',$3) RETURNING id",[lab.id,invoice.id,JSON.stringify([{description:'PRIVATE PATIENT',quantity:1,unitAmountCents:10000,taxCode:null}])])).rows[0];
    const evidence={sourceTotals:{subtotalCents:10000,taxCents:0,totalCents:10000},reconstructed:{subtotalCents:10000,taxCents:1000,totalCents:11000},unknownTaxLines:Array.from({length:105},(_,i)=>i+1),reasons:['PRIVATE NOTE'],raw:'PRIVATE RAW'};
    await database.pool.query("INSERT INTO review_items(organisation_id,kind,entity,flow_id,evidence) VALUES ($1,'job.source_totals','obligation',$2,$3)",[lab.id,job.id,JSON.stringify(evidence)]);
    const sdk=new Client({name:'synthetic-evidence',version:'1'});
    await sdk.connect(new StreamableHTTPClientTransport(new URL(flow.url+'/mcp'),{fetch,requestInit:{headers:{Authorization:'Bearer oat_valid'}}}));
    const before = await database.pool.query("SELECT (SELECT count(*) FROM obligation_events) events,(SELECT count(*) FROM outbox) outbox,(SELECT count(*) FROM background_jobs) jobs,(SELECT count(*) FROM invoice_versions) versions");
    const diagnosis=await sdk.callTool({name:'flow_invoice_diagnosis',arguments:{invoiceId:invoice.id}});
    assert.equal(diagnosis.structuredContent.ok,true);
    const d=diagnosis.structuredContent.data;
    assert.equal(d.refusalCode,'not_ready');assert.ok(d.reasons.includes('source_totals_review'));
    assert.equal(d.invoiceUrl,'https://flow.example.test/invoices/'+invoice.id);
    assert.equal(d.job.reconcileUrl,'https://flow.example.test/reconcile/'+job.id);
    assert.deepEqual(d.job.sourceReview.source,{subtotalCents:10000,taxCents:0,totalCents:10000});
    assert.equal(d.job.sourceReview.reconstructed.totalCents,11000);
    assert.equal(d.job.sourceReview.unknownTaxLines.length,100);assert.equal(diagnosis.structuredContent.truncated,true);
    assert.equal(d.job.sourceObservedAt,'2026-11-01T00:00:00.000Z');
    assert.ok(!JSON.stringify(diagnosis).includes('PRIVATE'));
    const oneJob=await sdk.callTool({name:'flow_job_read',arguments:{jobId:job.id}});assert.equal(oneJob.structuredContent.data.id,job.id);assert.equal(oneJob.structuredContent.data.invoiceUrl,d.invoiceUrl);
    const otherLab=await createOrganisation(database.db,{name:'Other synthetic'});
    await database.pool.query('UPDATE agent_grants SET organisation_id=$2 WHERE id=$1',[grant.id,otherLab.id]);
    for(const [name,args] of [['flow_invoice_diagnosis',{invoiceId:invoice.id}],['flow_job_read',{jobId:job.id}]]){
      const hidden=await sdk.callTool({name,arguments:args});assert.equal(hidden.structuredContent.code,'record_unavailable');
      const missing=await sdk.callTool({name,arguments:name==='flow_job_read'?{jobId:'00000000-0000-4000-8000-000000000000'}:{invoiceId:'00000000-0000-4000-8000-000000000000'}});assert.equal(missing.structuredContent.code,hidden.structuredContent.code);
    }
    await database.pool.query('UPDATE agent_grants SET organisation_id=$2 WHERE id=$1',[grant.id,lab.id]);
    const health=await sdk.callTool({name:'flow_health_read',arguments:{}});assert.equal(health.structuredContent.data.database,'reachable');
    const after=await database.pool.query("SELECT (SELECT count(*) FROM obligation_events) events,(SELECT count(*) FROM outbox) outbox,(SELECT count(*) FROM background_jobs) jobs,(SELECT count(*) FROM invoice_versions) versions");assert.deepEqual(after.rows,before.rows);
    await sdk.close();await settle();
    // Every tool must refuse the same disabled current person at its real HTTP boundary.
    await database.pool.query("UPDATE people SET status='disabled' WHERE id=$1",[owner.id]);
    for(const [name,args] of [['flow_connection',{}],['flow_health_read',{}],['flow_invoice_diagnosis',{invoiceId:invoice.id}],['flow_job_read',{jobId:job.id}]])assert.equal((await post(rpc(name,args))).status,401);
    await database.pool.query("UPDATE people SET status='active' WHERE id=$1",[owner.id]);
  });
  test('rate refusal pauses durably, a new gate stays paused, and a person must resume it', async () => {
    let limited = false, paused = false;
    for (let n = 0; n < 100; n++) {
      const response = await post();
      await settle();
      if (response.status === 429) { limited = true; assert.ok(Number(response.headers.get('retry-after')) > 0); }
      if (response.status === 403) { assert.equal((await response.json()).code, 'grant_paused'); paused = true; break; }
    }
    assert.equal(limited, true); assert.equal(paused, true);
    const old = flow;
    flow = await listen(createApp({ database, auth: browserAuth, mcp: mcpConfig, log: quiet }));
    assert.equal((await post()).status, 403);
    const headers = { Authorization: 'Bearer ' + browserToken };
    assert.equal((await fetch(flow.url + '/api/agent-grants/' + grant.id + '/resume', { method: 'POST', headers })).status, 200);
    assert.equal((await post()).status, 200);
    await settle(); await close(old.server);
  });
  test('owners provision only a fixed own read grant; revoke is immediate and resume cannot undo revocation', async () => {
    const headers = { Authorization: 'Bearer ' + browserToken, 'Content-Type': 'application/json' };
    const created = await fetch(flow.url + '/api/agent-grants', { method: 'POST', headers, body: JSON.stringify({ clientId: 'new_client', appName: 'Pilot', organisationId: lab.id }) });
    assert.equal(created.status, 201);
    const { grant: next } = await created.json();
    assert.equal(next.person_id, owner.id);
    assert.equal(next.access_level, 'read');
    assert.equal((await fetch(flow.url + '/api/agent-grants/' + grant.id + '/revoke', { method: 'POST', headers })).status, 200);
    assert.equal((await post()).status, 401);
    assert.equal((await fetch(flow.url + '/api/agent-grants/' + grant.id + '/resume', { method: 'POST', headers })).status, 200);
    assert.equal((await post()).status, 401);
    await settle();
    const history = (await database.pool.query('SELECT * FROM agent_audit WHERE grant_id=$1 ORDER BY created_at,id', [grant.id])).rows;
    assert.ok(history.length > 0);
    const input = { clientId: 'client_test', appName: 'Reconnected pilot', organisationId: lab.id };
    const provision = (body=input, token=browserToken) => fetch(flow.url + '/api/agent-grants', { method: 'POST', headers: { ...headers, Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    const weak = clerk.signIn('user_owner', { secondFactorAge: 999 });
    assert.equal((await provision(input, weak)).status, 403);
    assert.equal((await post()).status, 401);
    const elsewhere = await createOrganisation(database.db, { name: 'Other reconnect scope' });
    assert.equal((await provision({ ...input, organisationId: elsewhere.id })).status, 409);
    assert.equal((await provision({ ...input, personId: other.id })).status, 400);
    assert.equal((await provision({ ...input, resource: 'https://other.example.test/mcp' })).status, 400);
    assert.equal((await post()).status, 401);
    const restored = await provision();
    assert.equal(restored.status, 201, 'explicit verified-owner provisioning must reconnect the revoked grant');
    const { grant: again } = await restored.json();
    assert.equal(again.id, grant.id);
    assert.equal(again.person_id, owner.id);
    assert.equal(again.client_id, 'client_test');
    assert.equal(again.resource, resource);
    assert.equal(again.organisation_id, lab.id);
    assert.equal(again.access_level, 'read');
    assert.equal(again.revoked_at, null);
    assert.equal(again.paused_at, null);
    assert.deepEqual((await database.pool.query('SELECT * FROM agent_audit WHERE grant_id=$1 ORDER BY created_at,id', [grant.id])).rows, history);
    assert.equal((await provision()).status, 409, 'active duplicates remain refused');
    const sdk = new Client({ name: 'reconnect-proof', version: '1' });
    try {
      await sdk.connect(new StreamableHTTPClientTransport(new URL(flow.url + '/mcp'), { fetch, requestInit: { headers: { Authorization: 'Bearer oat_valid' } } }));
      const result = await sdk.callTool({ name: 'flow_connection', arguments: {} });
      assert.equal(result.structuredContent.data.organisationId, lab.id);
    } finally { await sdk.close(); }
    assert.equal((await post(rpc(), 'oat_other_client')).status, 401);
    assert.equal((await post(rpc(), 'oat_other_person')).status, 401);
    await settle();
    await database.pool.query('UPDATE agent_grants SET paused_at=now(),failure_count=20 WHERE id=$1', [grant.id]);
    assert.equal((await provision()).status, 409, 'provisioning must not bypass a live pause');
    assert.equal((await post()).status, 403);
    assert.equal((await fetch(flow.url + '/api/agent-grants/' + grant.id + '/resume', { method: 'POST', headers })).status, 200);
    assert.equal((await post()).status, 200);
  });
});
