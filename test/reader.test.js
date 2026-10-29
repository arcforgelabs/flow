import { saveSettings } from '../server/integrations/setup.js';
import { CAPTURE_SETTINGS } from '../server/core/capture-settings.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { callCostMicros, createAiPort, resolveReader } from '../server/core/ai.js';
import { createBedrockClient } from '../server/core/ai-bedrock.js';
import { typeProposal, uploadCapture } from '../server/core/captures.js';
import { createField } from '../server/core/custom-fields.js';
import { createOrganisation } from '../server/core/directory.js';
import { CAPTURE_READ_KIND, createCaptureReader } from '../server/core/reader.js';
import { runNextJob } from '../server/core/queue.js';
import { createLocalObjectStorage } from '../server/core/storage.js';
import { createRegistry } from '../server/integrations/port.js';
import { fakeClerk, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// A 1x1 PNG, drawn here. Not a lab form. Markers below are synthetic.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PATIENT = 'SHOULD-NOT-STORE';
const LEAK = 'PATIENT-MARKER';
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const HAIKU = 'au.anthropic.claude-haiku-5-5';
const SONNET = 'au.anthropic.claude-sonnet-5-5';

const READER_ENV = {
  FLOW_READER: 'on',
  FLOW_READER_REGION: 'ap-southeast-2',
  FLOW_READER_MODEL: HAIKU,
  FLOW_READER_MODEL_LARGE: SONNET,
  FLOW_READER_ACCESS_KEY_ID: AWS_KEY,
  FLOW_READER_SECRET_ACCESS_KEY: AWS_SECRET,
};

function answered(rows, { inputTokens = 1000, outputTokens = 80 } = {}) {
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return Buffer.from(JSON.stringify({
        output: {
          message: {
            role: 'assistant',
            content: [
              { reasoningContent: { reasoningText: { text: PATIENT } } },
              { text: JSON.stringify({ fields: rows }) },
            ],
          },
        },
        stopReason: 'end_turn',
        usage: { inputTokens, outputTokens },
      }));
    },
  };
}

const LOW = [
  { key: 'case_number', value: '48Z1', seen: '48Z1', sure: 0.2 },
  { key: 'practice', value: 'North Dental', seen: 'North Dental', sure: 0.95 },
  { key: 'work', value: 'crown', seen: 'crown', sure: 0.95 },
  { key: 'patient', value: PATIENT, seen: PATIENT, sure: 0.99 },
];
const HIGH = [
  { key: 'case_number', value: '4821', seen: '4821', sure: 0.96 },
  { key: 'practice', value: 'North Dental', seen: 'North Dental', sure: 0.95 },
  { key: 'work', value: 'crown', seen: 'crown', sure: 0.95 },
  { key: 'patient', value: PATIENT, seen: PATIENT, sure: 0.99 },
];
const SURE = [
  { key: 'case_number', value: '', seen: '', sure: 0.97 },
  { key: 'practice', value: 'North Dental', seen: 'North Dental', sure: 0.95 },
  { key: 'work', value: 'crown', seen: 'crown', sure: 0.95 },
];

test('the reader stays in Australia and prices the known profiles', () => {
  assert.equal(resolveReader({ env: {} }).on, false);
  assert.equal(resolveReader({ env: { FLOW_READER: 'off' } }).reason, 'off');
  assert.equal(resolveReader({ env: { ...READER_ENV, FLOW_READER_ACCESS_KEY_ID: '' } }).on, false);
  assert.throws(() => resolveReader({ env: { ...READER_ENV, FLOW_READER_REGION: 'us-east-1' } }), /ap-southeast-2/);
  assert.throws(() => resolveReader({ env: { ...READER_ENV, FLOW_READER_MODEL: 'global.anthropic.claude-haiku-5-5' } }), /au\./);
  assert.throws(() => resolveReader({ env: { ...READER_ENV, FLOW_READER_MODEL_LARGE: 'us.anthropic.claude-sonnet-5-5' } }), /au\./);
  const on = resolveReader({ env: READER_ENV });
  assert.equal(on.region, 'ap-southeast-2');
  assert.equal(callCostMicros({ inputTokens: 1000, outputTokens: 80, price: on.prices.small }), 154);
  assert.equal(callCostMicros({ inputTokens: 1000, outputTokens: 90, price: on.prices.large }), 3190);
  assert.equal(callCostMicros({ inputTokens: 100_001, outputTokens: 1, price: on.prices.small }), 55003);
  assert.equal(callCostMicros({ inputTokens: 10, outputTokens: 10, price: null }), null);
});

test('a recorded Bedrock response is parsed, and a refusal does not leak', async () => {
  const seen = [];
  const client = createBedrockClient({
    region: 'ap-southeast-4',
    accessKeyId: AWS_KEY,
    secretAccessKey: AWS_SECRET,
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), authorization: options.headers.authorization, body: options.body });
      return answered([{ key: 'case_number', value: '4821', seen: '4821', sure: 0.9 }], { outputTokens: 40 });
    },
  });
  const result = await createAiPort(client).readImage({
    model: HAIKU, mediaType: 'image/png', bytes: PNG, instruction: 'Read the form.', schema: { type: 'object' },
  });
  assert.equal(result.text.includes(PATIENT), false);
  assert.equal(result.text.includes('4821'), true);
  assert.equal(result.inputTokens, 1000);
  assert.equal(result.outputTokens, 40);
  assert.match(seen[0].url, /^https:\/\/bedrock-runtime\.ap-southeast-4\.amazonaws\.com\/model\/au\.anthropic\.claude-haiku-5-5\/converse$/);
  assert.match(seen[0].authorization, /\/ap-southeast-4\/bedrock\/aws4_request/);
  assert.equal(seen[0].body.includes(PNG.toString('base64')), true);
  assert.equal(seen[0].url.includes('us-east-1'), false);
  assert.equal(seen[0].url.includes('global.'), false);

  let calls = 0;
  const leaking = createAiPort(createBedrockClient({
    region: 'ap-southeast-2',
    accessKeyId: AWS_KEY,
    secretAccessKey: AWS_SECRET,
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 500, arrayBuffer: async () => Buffer.from(LEAK) };
    },
  }));
  await assert.rejects(
    () => leaking.readImage({ model: HAIKU, mediaType: 'image/png', bytes: PNG, instruction: 'Read', schema: {} }),
    (error) => error.code === 'reader_unavailable' && !String(error.message).includes(LEAK) && error.retry === true,
  );
  await assert.rejects(
    () => leaking.readImage({ model: 'us.anthropic.claude-haiku-5-5', mediaType: 'image/png', bytes: PNG, instruction: 'Read', schema: {} }),
    (error) => error.retry === false && calls === 1,
  );
  assert.throws(
    () => createBedrockClient({ region: 'us-east-1', accessKeyId: AWS_KEY, secretAccessKey: AWS_SECRET }),
    /Sydney or Melbourne/,
  );
});

describe('the reader against PostgreSQL', { skip: skipWithoutDatabase }, () => {
  let handle;
  let storage;
  let organisationId;
  let ownerToken;
  let app;
  let reader;
  let trayId;
  let seen;
  let queue;
  let reported;
  const log = { info() {}, warn() {}, error(...args) { reported.push(args.map(String).join(' ')); } };

  function scripted(url, options) {
    seen.push({ url: String(url), body: String(options?.body ?? '') });
    const next = queue.shift();
    if (!next) throw new Error('the reader called Bedrock with nothing left to answer');
    return next;
  }

  function client() {
    const settings = resolveReader({ env: READER_ENV });
    return {
      settings,
      port: createAiPort(createBedrockClient({
        region: settings.region,
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
        fetchImpl: async (url, options) => scripted(url, options),
      })),
    };
  }

  before(async () => {
    handle = await freshDatabase();
    seen = [];
    queue = [];
    reported = [];
    const organisation = await createOrganisation(handle.db, { name: 'Example Lab' });
    organisationId = organisation.id;
    const root = mkdtempSync(path.join(tmpdir(), 'flow-reader-'));
    storage = createLocalObjectStorage({ root, signingKey: Buffer.alloc(32, 9) });
    trayId = (await createField(handle.db, organisationId, { name: 'Tray', type: 'text' })).id;
    const built = client();
    reader = createCaptureReader({ db: handle.db, storage, port: built.port, settings: built.settings, log, jobsOn: true });
    const clerk = fakeClerk();
    const owner = await seedFirstOwner(handle.db, 'owner@example.test');
    await invitePerson(handle.db, { email: 'staff@example.test', role: 'staff', invitedBy: owner.id });
    ownerToken = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    app = createApp({
      database: handle,
      auth: {
        settings: { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } },
        clerk,
        personAuth: createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log }),
      },
      integrations: createRegistry({ log, env: {} }),
      log,
      storage,
      reader: { on: true, schedule: (row) => reader.schedule(row) },
    });
  });

  after(async () => handle?.close());

  async function upload(key, bytes = PNG, type = 'image/png') {
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/captures`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerToken}`, 'content-type': type, 'idempotency-key': key },
        body: bytes,
      });
      const body = await res.json();
      return { status: res.status, body };
    } finally {
      server.close();
    }
  }

  function run() {
    return runNextJob(handle.db, { workerId: 'reader-test', handlers: { [CAPTURE_READ_KIND]: reader.handle } });
  }

  test('a low sure case number is read again, and a sure blank one is not', async () => {
    reported = [];
    seen = [];
    queue = [
      answered(LOW, { outputTokens: 80 }),
      answered(HIGH, { outputTokens: 90 }),
    ];
    const created = await upload('form-low');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.capture.state, 'reading');
    const again = await upload('form-low');
    assert.equal(again.body.capture.id, created.body.capture.id);
    const ran = await run();
    assert.equal(ran.outcome, 'succeeded');
    assert.deepEqual(seen.map((call) => new URL(call.url).pathname), [
      `/model/${encodeURIComponent(HAIKU)}/converse`,
      `/model/${encodeURIComponent(SONNET)}/converse`,
    ]);
    assert.equal(seen.every((call) => call.url.startsWith('https://bedrock-runtime.ap-southeast-2.amazonaws.com/')), true);
    assert.equal(seen.every((call) => call.body.includes('Tray') && call.body.includes(`custom_${trayId}`)), true);
    assert.equal(seen.some((call) => call.body.includes(PATIENT)), false);

    const { rows: [row] } = await handle.pool.query('select state, problem, read from captures where id = $1', [created.body.capture.id]);
    assert.equal(row.state, 'ready');
    assert.equal(row.problem, null);
    assert.equal(row.read.fields.find((field) => field.key === 'case_number').value, '4821');
    assert.equal(row.read.fields.some((field) => field.key === 'patient'), false);
    assert.equal(JSON.stringify(row.read).includes(PATIENT), false);
    assert.equal(row.read.model, SONNET);
    assert.equal(row.read.inputTokens, 2000);
    assert.equal(row.read.outputTokens, 170);
    assert.equal(row.read.costMicros, 3344);
    assert.deepEqual(row.read.calls.map((call) => call.model), [HAIKU, SONNET]);

    queue = [answered(SURE, { outputTokens: 40 })];
    const sure = await upload('form-sure');
    await run();
    const { rows: [sureRow] } = await handle.pool.query('select read from captures where id = $1', [sure.body.capture.id]);
    assert.equal(sureRow.read.model, HAIKU);
    assert.equal(sureRow.read.calls.length, 1);
    assert.equal(sureRow.read.fields.find((field) => field.key === 'case_number').value, '');
    assert.equal(sureRow.read.fields.find((field) => field.key === `custom_${trayId}`).value, '');
    assert.equal(seen.length, 3);
    assert.equal(reported.join('\n').includes(PATIENT), false);
    assert.equal(reported.join('\n').includes(PNG.toString('base64')), false);

    queue = [answered(SURE, { outputTokens: 40 })];
    const built = client();
    const inline = createCaptureReader({
      db: handle.db, storage, port: built.port, settings: built.settings, log, jobsOn: false,
    });
    const direct = await uploadCapture(handle.db, storage, organisationId, {
      bytes: PNG, contentType: 'image/png', idempotencyKey: 'form-inline', personId: null, baseUrl: 'http://127.0.0.1',
      reader: { on: true, schedule: (row) => inline.schedule(row) },
    });
    assert.equal(direct.capture.state, 'ready');
    assert.equal(direct.capture.read.calls.length, 1);
  });

  test('turning off stops queued reads and new uploads; turning on resumes reading', async () => {
    seen = [];
    queue = [answered(SURE, { outputTokens: 40 })];
    const queued = await upload('switch-queued');
    await saveSettings(handle.db, { adapter: CAPTURE_SETTINGS, actor: null, values: { CAPTURE_READER: 'off' } });
    await run();
    const { rows: [row] } = await handle.pool.query('select state, problem from captures where id = $1', [queued.body.capture.id]);
    assert.equal(row.problem, 'reader turned off');
    const off = await upload('switch-off');
    assert.equal(off.body.capture.state, 'problem');
    assert.equal(seen.length, 0);
    await saveSettings(handle.db, { adapter: CAPTURE_SETTINGS, actor: null, values: { CAPTURE_READER: 'on' } });
    const on = await upload('switch-on');
    assert.equal(on.body.capture.state, 'reading');
    await run();
    assert.equal(seen.length, 1);
  });

  test('three failed calls become a problem a person can type, and a heic photo is not sent', async () => {
    reported = [];
    seen = [];
    queue = [1, 2, 3].map(() => ({ ok: false, status: 500, arrayBuffer: async () => Buffer.from(LEAK) }));
    const created = await upload('form-down');
    const ran = await run();
    assert.equal(ran.outcome, 'succeeded');
    assert.equal(seen.length, 3);
    const { rows: [row] } = await handle.pool.query(
      'select state, problem, read::text as read from captures where id = $1',
      [created.body.capture.id],
    );
    assert.equal(row.state, 'problem');
    assert.equal(row.problem, 'the reader did not answer');
    assert.equal(row.read, null);
    const text = `${row.problem}\n${row.read}\n${reported.join('\n')}`;
    assert.equal(text.includes(LEAK), false);
    assert.match(reported.join('\n'), new RegExp(created.body.capture.id));
    const typed = await typeProposal(
      handle.db, storage, organisationId, created.body.capture.id, { action: 'note', changes: [] }, { baseUrl: 'http://127.0.0.1' },
    );
    assert.equal(typed.capture.state, 'ready');

    const before = seen.length;
    const heic = Buffer.alloc(16);
    heic.write('ftyp', 4, 'ascii');
    heic.write('heic', 8, 'ascii');
    const photo = await uploadCapture(handle.db, storage, organisationId, {
      bytes: heic, contentType: 'image/heic', idempotencyKey: 'form-heic', personId: null, baseUrl: 'http://127.0.0.1',
      reader: { on: true, schedule: (row) => reader.schedule(row) },
    });
    assert.equal(photo.capture.state, 'reading');
    await run();
    const { rows: [heicRow] } = await handle.pool.query('select state, problem from captures where id = $1', [photo.capture.id]);
    assert.equal(heicRow.state, 'problem');
    assert.equal(heicRow.problem, 'photo type cannot be read');
    assert.equal(seen.length, before);
  });
});
