import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import {
  CAPTURE_RETENTION_MS, MAX_PHOTO_BYTES, decideCapture, readPhoto, sweepCaptures, typeProposal, uploadCapture,
} from '../server/core/captures.js';
import { createMonitoredLog } from '../server/core/monitoring.js';
import {
  authorizationHeader, createLocalObjectStorage, createReplitObjectStorage, createS3ObjectStorage,
  presignedGetUrl, resolveObjectStorage,
} from '../server/core/storage.js';
import { createOrganisation } from '../server/core/directory.js';
import { createRegistry } from '../server/integrations/port.js';
import { fakeClerk, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// A 1x1 PNG, drawn here. Not a lab form.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SHADE = 'A2-SECRET-SHADE';
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const AWS_NOW = new Date('2013-05-24T00:00:00Z');

function tempStorage() {
  const root = mkdtempSync(path.join(tmpdir(), 'flow-captures-'));
  const storage = createLocalObjectStorage({ root, signingKey: Buffer.alloc(32, 7) });
  return { root, storage };
}

test('a photo is checked before it is stored', () => {
  const photo = readPhoto(PNG, 'image/png; charset=binary');
  assert.equal(photo.fileType, 'image/png');
  assert.equal(photo.fileSha256.length, 64);
  assert.throws(() => readPhoto(Buffer.from('hello'), 'text/plain'), /jpeg, png, webp or heic/);
  assert.throws(() => readPhoto(Buffer.from('not a photo'), 'image/png'), /could not be read/);
  assert.throws(() => readPhoto(Buffer.alloc(MAX_PHOTO_BYTES + 1, 1), 'image/jpeg'), /too large/);
  assert.throws(() => readPhoto('not-bytes', 'image/png'), /photo is required/);
  assert.throws(() => readPhoto([PNG], 'image/png'), /photo is required/);
});

test('the local folder stores a photo and will not leave that folder', async () => {
  const { root, storage } = tempStorage();
  await storage.put({ key: 'captures/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', body: PNG, contentType: 'image/png' });
  const got = await storage.get('captures/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert.equal(got.body.equals(PNG), true);
  assert.equal(got.contentType, 'image/png');
  await storage.delete('captures/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert.equal(await storage.get('captures/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), null);
  await assert.rejects(() => storage.put({ key: '../outside.png', body: PNG, contentType: 'image/png' }));
  assert.equal(path.resolve(root).startsWith(path.resolve(tmpdir())), true);
  const link = storage.signedLink({
    key: 'captures/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    baseUrl: 'http://127.0.0.1:9',
    expiresInSeconds: -1,
  });
  const token = new URL(link.url).searchParams.get('token');
  assert.equal(storage.openLink(token).code, 'link_expired');
  assert.equal(storage.openLink(`${token.slice(0, -1)}x`).code, 'link_invalid');
});

test('an S3 link matches the published signature example', () => {
  const headers = {
    host: 'examplebucket.s3.amazonaws.com',
    range: 'bytes=0-9',
    'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'x-amz-date': '20130524T000000Z',
  };
  const signed = authorizationHeader({
    method: 'GET', path: '/test.txt', headers, payloadHash: headers['x-amz-content-sha256'],
    accessKeyId: AWS_KEY, secretAccessKey: AWS_SECRET, region: 'us-east-1', now: AWS_NOW,
  });
  assert.equal(signed.requestHash, '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972');
  assert.equal(
    signed.header,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
  const presigned = presignedGetUrl({
    accessKeyId: AWS_KEY, secretAccessKey: AWS_SECRET, region: 'us-east-1', bucket: 'examplebucket', key: 'test.txt',
    expiresInSeconds: 86400, now: AWS_NOW,
  });
  assert.equal(presigned.signature, 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.equal(presigned.requestHash, '3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04');
});

test('S3 put and delete send the photo bytes and no error text from the store', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, method: options.method, body: options.body });
    if (options.method === 'GET') return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) };
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => Buffer.alloc(0) };
  };
  const storage = createS3ObjectStorage({
    bucket: 'lab', region: 'us-east-1', accessKeyId: 'AKIA', secretAccessKey: 'secret', fetchImpl,
  });
  const key = 'captures/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  await storage.put({ key, body: PNG, contentType: 'image/png' });
  assert.equal(seen[0].method, 'PUT');
  assert.equal(Buffer.compare(seen[0].body, PNG), 0);
  assert.equal(await storage.get(key), null);
  await storage.delete(key);
  assert.equal(seen[2].method, 'DELETE');
  const failing = createS3ObjectStorage({
    bucket: 'lab', region: 'us-east-1', accessKeyId: 'AKIA', secretAccessKey: 'secret',
    fetchImpl: async () => ({ ok: false, status: 500, headers: { get: () => null }, arrayBuffer: async () => Buffer.from(`leak ${PNG.toString('base64')} ${SHADE}`) }),
  });
  await assert.rejects(
    () => failing.put({ key, body: PNG, contentType: 'image/png' }),
    (error) => error.code === 'storage_unavailable' && !String(error.message).includes(SHADE) && !String(error.message).includes(PNG.toString('base64')),
  );
});

test('Replit storage reads the client buffer and signs a Flow link', async () => {
  const objects = new Map();
  const client = {
    async uploadFromBytes(key, body) {
      objects.set(key, Buffer.from(body));
      return { ok: true };
    },
    async downloadAsBytes(key) {
      const body = objects.get(key);
      if (!body) return { ok: false, error: { name: 'ObjectNotFoundError' } };
      return { ok: true, value: [body] };
    },
    async delete(key) {
      objects.delete(key);
      return { ok: true };
    },
  };
  const storage = createReplitObjectStorage({ client, signingKey: Buffer.alloc(32, 3) });
  const key = 'captures/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  await storage.put({ key, body: PNG, contentType: 'image/png' });
  const got = await storage.get(key);
  assert.equal(got.body.equals(PNG), true);
  const link = storage.signedLink({ key, baseUrl: 'https://lab.example' });
  assert.match(link.url, /^https:\/\/lab\.example\/api\/captures\/file\?token=/);
  const token = new URL(link.url).searchParams.get('token');
  assert.equal(storage.openLink(token).key, key);
  await storage.delete(key);
  assert.equal(await storage.get(key), null);
});

test('a local folder without a signing key makes one and keeps it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'flow-storage-key-'));
  const key = 'captures/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const first = await resolveObjectStorage({ env: { FLOW_STORAGE: 'local' }, root });
  await first.storage.put({ key, body: PNG, contentType: 'image/png' });
  const second = await resolveObjectStorage({ env: { FLOW_STORAGE: 'local' }, root });
  const got = await second.storage.get(key);
  assert.equal(got.body.equals(PNG), true);
  const link = first.storage.signedLink({ key, baseUrl: 'http://127.0.0.1:9' });
  const token = new URL(link.url).searchParams.get('token');
  assert.equal(second.storage.openLink(token).key, key);
});

test('a published Replit app never uses the local folder', async () => {
  await assert.rejects(
    () => resolveObjectStorage({ env: { REPLIT_DEPLOYMENT: '1', FLOW_STORAGE: 'local' } }),
    /publish keeps no files/,
  );
  const off = await resolveObjectStorage({ env: { REPLIT_DEPLOYMENT: '1' } });
  assert.equal(off.storage, null);
  assert.equal(off.mode, 'off');
  await assert.rejects(() => resolveObjectStorage({ env: { FLOW_STORAGE: 's3' } }), /FLOW_S3_BUCKET/);
  const parent = mkdtempSync(path.join(tmpdir(), 'flow-storage-ro-'));
  const blocked = path.join(parent, 'not-a-directory');
  writeFileSync(blocked, 'x');
  const unwritable = await resolveObjectStorage({ env: {}, root: path.join(blocked, 'storage') });
  assert.equal(unwritable.storage, null);
  assert.equal(unwritable.mode, 'off');
  assert.equal(unwritable.reason, 'local_not_writable');
  await assert.rejects(
    () => resolveObjectStorage({ env: { FLOW_STORAGE: 'local' }, root: path.join(blocked, 'storage') }),
    /could not create its folder/,
  );
  const lockedParent = mkdtempSync(path.join(tmpdir(), 'flow-storage-lock-'));
  const locked = path.join(lockedParent, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  try {
    const denied = await resolveObjectStorage({ env: {}, root: path.join(locked, 'storage') });
    assert.equal(denied.storage, null);
    assert.equal(denied.reason, 'local_not_writable');
    await assert.rejects(
      () => resolveObjectStorage({ env: { FLOW_STORAGE: 'local' }, root: path.join(locked, 'storage') }),
      /could not create its folder/,
    );
  } finally {
    chmodSync(locked, 0o755);
  }
});

describe('captures against PostgreSQL', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let storage;
  let ownerToken;
  let staffToken;
  let organisationId;
  const reported = [];
  const log = createMonitoredLog({
    log: { info() {}, warn() {}, error(...args) { reported.push(args.map(String).join(' ')); } },
    reporters: () => [{ id: 'sentry', capabilities: { captureError(event) { reported.push(event.message); } } }],
  });

  async function send(path, { token = ownerToken, method = 'GET', body, headers = {} } = {}) {
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        redirect: 'manual',
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body,
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') ?? '';
      return { status: res.status, bytes, body: type.includes('json') ? JSON.parse(bytes.toString('utf8')) : null };
    } finally {
      server.close();
    }
  }

  function upload(bytes, key, token) {
    return send('/api/captures', {
      token,
      method: 'POST',
      body: bytes,
      headers: { 'content-type': 'image/png', 'idempotency-key': key },
    });
  }

  before(async () => {
    handle = await freshDatabase();
    const organisation = await createOrganisation(handle.db, { name: 'Example Lab' });
    organisationId = organisation.id;
    const folder = tempStorage();
    storage = folder.storage;
    const integrations = createRegistry({ log, env: {} });
    const clerk = fakeClerk();
    const owner = await seedFirstOwner(handle.db, 'owner@example.test');
    await invitePerson(handle.db, { email: 'staff@example.test', role: 'staff', invitedBy: owner.id });
    ownerToken = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    staffToken = clerk.signIn(clerk.addUser({ email: 'staff@example.test' }));
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log });
    app = createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations, log, storage });
  });

  after(async () => handle?.close());

  test('a photo is stored, and with the reader off a person types it before deciding', async () => {
    const signedOut = await upload(PNG, 'form-1', null);
    assert.equal(signedOut.status, 401);
    const bad = await send('/api/captures', {
      method: 'POST', body: Buffer.from('hello'),
      headers: { 'content-type': 'text/plain', 'idempotency-key': 'form-bad' },
    });
    assert.equal(bad.status, 415);

    const created = await upload(PNG, 'form-1', staffToken);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.capture.state, 'problem');
    assert.equal(created.body.capture.problem, 'reader turned off');
    assert.equal(created.body.capture.read, null);
    assert.equal(created.body.capture.source, 'api');
    assert.deepEqual(created.body.capture.proposal, { action: null, jobId: null, changes: [] });
    assert.equal(created.body.capture.decision, null);
    assert.equal(created.body.capture.fileSha256, readPhoto(PNG, 'image/png').fileSha256);
    assert.match(created.body.capture.link.url, /\/api\/captures\/file\?token=/);

    const again = await upload(Buffer.concat([PNG, Buffer.from('other')]), 'form-1');
    assert.equal(again.status, 200);
    assert.equal(again.body.capture.id, created.body.capture.id);
    assert.equal(again.body.capture.fileSha256, created.body.capture.fileSha256);

    const photo = await send(new URL(created.body.capture.link.url).pathname + new URL(created.body.capture.link.url).search, { token: null });
    assert.equal(photo.status, 200);
    assert.equal(photo.bytes.equals(PNG), true);

    const tampered = created.body.capture.link.url.replace(/.$/, (ch) => (ch === 'a' ? 'b' : 'a'));
    const refused = await send(new URL(tampered).pathname + new URL(tampered).search, { token: null });
    assert.equal(refused.status, 403);

    const typed = await send(`/api/captures/${created.body.capture.id}/proposal`, {
      method: 'POST',
      body: JSON.stringify({ action: 'update', changes: [{ field: 'shade', from: '', to: SHADE }] }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(typed.status, 200, JSON.stringify(typed.body));
    assert.equal(typed.body.capture.proposal.changes[0].to, SHADE);
    assert.equal(typed.body.capture.state, 'ready');

    const decided = await send(`/api/captures/${created.body.capture.id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'applied' }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.capture.state, 'done');
    assert.equal(decided.body.capture.decision, 'applied');
    assert.ok(decided.body.capture.photoDeletedAt);
    assert.equal(decided.body.capture.link, null);
    const gone = await send(new URL(created.body.capture.link.url).pathname + new URL(created.body.capture.link.url).search, { token: null });
    assert.equal(gone.status, 404);

    const corrupt = await upload(PNG, 'form-corrupt');
    const { rows: [stored] } = await handle.pool.query('select file_key from captures where id = $1', [corrupt.body.capture.id]);
    await storage.put({ key: stored.file_key, body: Buffer.from(`LEAKED-PHOTO-BYTES ${SHADE}`), contentType: 'image/png' });
    const link = new URL(corrupt.body.capture.link.url);
    const mismatched = await send(link.pathname + link.search, { token: null });
    assert.equal(mismatched.status, 404);
    assert.equal(mismatched.bytes.toString('utf8').includes('LEAKED-PHOTO-BYTES'), false);
    assert.match(reported.join('\n'), /hash_mismatch/);

    const other = await createOrganisation(handle.db, { name: 'Other Lab' });
    const hidden = await send(`/api/captures/${created.body.capture.id}?organisationId=${other.id}`);
    assert.equal(hidden.status, 404);
  });

  test('an undecided capture is deleted after 7 days, and logs never carry the photo or the typed text', async () => {
    const leaking = {
      ...storage,
      async delete() {
        throw new Error(`leak ${PNG.toString('base64')} ${SHADE}`);
      },
    };
    const held = await uploadCapture(handle.db, storage, organisationId, {
      bytes: PNG, contentType: 'image/png', idempotencyKey: 'form-held', personId: null, baseUrl: 'http://127.0.0.1',
    });
    await typeProposal(handle.db, storage, organisationId, held.capture.id, { action: null, changes: [] }, { baseUrl: 'http://127.0.0.1' });
    await assert.rejects(
      () => decideCapture(handle.db, leaking, organisationId, held.capture.id, 'discarded'),
      (error) => {
        log.error(`[captures] ${error.captureId} ${error.code}`);
        return error.code === 'storage_unavailable' && !error.message.includes(SHADE);
      },
    );
    const text = reported.join('\n');
    assert.equal(text.includes(SHADE), false);
    assert.equal(text.includes('LEAKED-PHOTO-BYTES'), false);
    assert.equal(text.includes(PNG.toString('base64')), false);
    assert.match(text, new RegExp(`\\[captures\\] ${held.capture.id} storage_unavailable`));

    const old = await uploadCapture(handle.db, storage, organisationId, {
      bytes: PNG, contentType: 'image/png', idempotencyKey: 'form-old', personId: null, baseUrl: 'http://127.0.0.1',
    });
    const young = await uploadCapture(handle.db, storage, organisationId, {
      bytes: PNG, contentType: 'image/png', idempotencyKey: 'form-young', personId: null, baseUrl: 'http://127.0.0.1',
    });
    await handle.pool.query(`update captures set created_at = now() - interval '8 days' where id = $1`, [old.capture.id]);
    await handle.pool.query(`update captures set created_at = now() - interval '6 days' where id = $1`, [young.capture.id]);
    const swept = await sweepCaptures(handle.db, storage, { retentionMs: CAPTURE_RETENTION_MS });
    assert.ok(swept.removed >= 1);
    assert.ok(swept.photos >= 1);
    const { rows: left } = await handle.pool.query('select id from captures where id = any($1::uuid[])', [[old.capture.id, young.capture.id, held.capture.id]]);
    assert.deepEqual(left.map((row) => row.id).sort(), [held.capture.id, young.capture.id].sort());
    const { rows: [kept] } = await handle.pool.query('select photo_deleted_at from captures where id = $1', [held.capture.id]);
    assert.ok(kept.photo_deleted_at);
    assert.equal(await storage.get(old.capture.fileKey), null);
  });
});
