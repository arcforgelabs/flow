import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FlowError } from './errors.js';
import { deriveKey } from './secrets.js';

// The object storage port (docs/DATA_MODEL.md, "Storage"). One interface for
// every host: put, get, delete, and a signed link. PostgreSQL keeps the key,
// size, type and checksum; the bytes stay here.
//
//   local   a folder on one machine, and what tests use
//   s3      any S3-compatible store, signed with AWS Signature Version 4
//   replit  Replit Object Storage, through @replit/object-storage
//
// A published Replit app keeps no files between publishes, so it never uses
// the local folder. Replit's client has no signed URL of its own, so a Replit
// link is a Flow link: Flow checks the signature, reads the bytes and checks
// the checksum. An S3 link is a presigned GET the store itself honours.

const KEY = /^(?:[a-z0-9][a-z0-9_-]{0,63}\/)*[a-z0-9][a-z0-9_-]{0,63}(?:\.[a-z0-9]{1,8})?$/;
const LINK_TTL_SECONDS = 15 * 60;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function assertStorageKey(key) {
  if (typeof key !== 'string' || !KEY.test(key) || key.includes('..')) {
    throw new FlowError('invalid', 'storage key is not allowed');
  }
}

const unavailable = () => new FlowError('storage_unavailable', 'the file store could not be reached');

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A Flow signed link. The token is the key and the expiry, HMAC-SHA256, so a
// change to either fails the check. The key is an id Flow chose, never a name
// from the photo.
function createLinkSigner(secret) {
  if (!Buffer.isBuffer(secret) || secret.length < 32) throw new FlowError('invalid', 'storage signing key is required');
  const key = secret.subarray(0, 32);

  function sign(storageKey, expiresInSeconds, now) {
    assertStorageKey(storageKey);
    const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000);
    const payload = `${storageKey}\n${Math.floor(expiresAt.getTime() / 1000)}`;
    const mac = createHmac('sha256', key).update(payload).digest('base64url');
    return { token: `${Buffer.from(payload).toString('base64url')}.${mac}`, expiresAt: expiresAt.toISOString() };
  }

  function open(token, now) {
    if (typeof token !== 'string' || token.length > 2000) return { ok: false, code: 'link_invalid' };
    const dot = token.indexOf('.');
    if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return { ok: false, code: 'link_invalid' };
    let payload;
    try {
      payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    } catch {
      return { ok: false, code: 'link_invalid' };
    }
    const expected = createHmac('sha256', key).update(payload).digest('base64url');
    if (!safeEqual(token.slice(dot + 1), expected)) return { ok: false, code: 'link_invalid' };
    const nl = payload.lastIndexOf('\n');
    const storageKey = payload.slice(0, nl);
    const exp = Number(payload.slice(nl + 1));
    if (!Number.isInteger(exp) || nl <= 0) return { ok: false, code: 'link_invalid' };
    try {
      assertStorageKey(storageKey);
    } catch {
      return { ok: false, code: 'link_invalid' };
    }
    if (exp <= Math.floor(now.getTime() / 1000)) return { ok: false, code: 'link_expired' };
    return { ok: true, key: storageKey };
  }

  return { sign, open };
}

function flowLink(signer, { key, expiresInSeconds = LINK_TTL_SECONDS, baseUrl, now }) {
  if (!baseUrl || !/^https?:\/\//.test(String(baseUrl))) throw new FlowError('invalid', 'a signed link needs an http origin');
  const signed = signer.sign(key, expiresInSeconds, now());
  const url = `${String(baseUrl).replace(/\/$/, '')}/api/captures/file?token=${encodeURIComponent(signed.token)}`;
  return { url, expiresAt: signed.expiresAt };
}

function insideRoot(root, key) {
  assertStorageKey(key);
  const base = path.resolve(root);
  const full = path.resolve(base, key);
  const relative = path.relative(base, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new FlowError('invalid', 'storage key is not allowed');
  return full;
}

export function createLocalObjectStorage({ root, signingKey, now = () => new Date() }) {
  const signer = createLinkSigner(signingKey);

  return {
    kind: 'local',
    async put({ key, body, contentType }) {
      const full = insideRoot(root, key);
      if (!Buffer.isBuffer(body)) throw new FlowError('invalid', 'photo is required');
      await mkdir(path.dirname(full), { recursive: true });
      const temp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temp, body, { flag: 'wx' });
        await rename(temp, full);
        if (contentType) await writeFile(`${full}.type`, String(contentType), { flag: 'w' });
      } catch {
        await rm(temp, { force: true });
        await rm(full, { force: true });
        throw unavailable();
      }
    },
    async get(key) {
      const full = insideRoot(root, key);
      try {
        const body = await readFile(full);
        const contentType = await readFile(`${full}.type`, 'utf8').catch(() => null);
        return { body, contentType };
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw unavailable();
      }
    },
    async delete(key) {
      const full = insideRoot(root, key);
      await rm(full, { force: true });
      await rm(`${full}.type`, { force: true });
    },
    signedLink(options) {
      return flowLink(signer, { ...options, now });
    },
    openLink(token) {
      return signer.open(token, now());
    },
  };
}

function sha256Hex(body) {
  return createHash('sha256').update(body ?? '').digest('hex');
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodedPath(segments) {
  return `/${segments.map((segment) => encodeRfc3986(segment)).join('/')}`;
}

function amzDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function signingKey(secret, dateStamp, region) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), 's3'), 'aws4_request');
}

// Canonical request as AWS Signature Version 4 defines it. `headers` is
// lowercase names to values, already trimmed.
function canonicalRequest({ method, path: uri, query = '', headers, payloadHash }) {
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
  return `${method}\n${uri}\n${query}\n${canonicalHeaders}\n${names.join(';')}\n${payloadHash}`;
}

export function authorizationHeader({
  method, path: uri, query = '', headers, payloadHash, accessKeyId, secretAccessKey, region, now,
}) {
  const stamp = amzDate(now);
  const date = stamp.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const request = canonicalRequest({ method, path: uri, query, headers, payloadHash });
  const stringToSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha256Hex(request)}`;
  const signature = createHmac('sha256', signingKey(secretAccessKey, date, region)).update(stringToSign).digest('hex');
  const signed = Object.keys(headers).sort().join(';');
  return {
    stamp,
    signature,
    requestHash: sha256Hex(request),
    header: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${signed},Signature=${signature}`,
  };
}

function locate({ bucket, region, key, endpoint, forcePathStyle }) {
  const segments = key.split('/');
  if (endpoint) {
    const url = new URL(endpoint);
    if (forcePathStyle) return { protocol: url.protocol, host: url.host, path: encodedPath([bucket, ...segments]) };
    return { protocol: url.protocol, host: `${bucket}.${url.host}`, path: encodedPath(segments) };
  }
  const host = region === 'us-east-1' ? `${bucket}.s3.amazonaws.com` : `${bucket}.s3.${region}.amazonaws.com`;
  return { protocol: 'https:', host, path: encodedPath(segments) };
}

function canonicalQuery(params) {
  return Object.keys(params).sort().map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(String(params[name]))}`).join('&');
}

export function presignedGetUrl({
  accessKeyId, secretAccessKey, region, bucket, key, expiresInSeconds, endpoint = null, forcePathStyle = false, now,
}) {
  assertStorageKey(key);
  const located = locate({ bucket, region, key, endpoint, forcePathStyle });
  const stamp = amzDate(now);
  const date = stamp.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const query = canonicalQuery(params);
  const signed = authorizationHeader({
    method: 'GET',
    path: located.path,
    query,
    headers: { host: located.host },
    payloadHash: 'UNSIGNED-PAYLOAD',
    accessKeyId,
    secretAccessKey,
    region,
    now,
  });
  return { url: `${located.protocol}//${located.host}${located.path}?${query}&X-Amz-Signature=${signed.signature}`, expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(), signature: signed.signature, requestHash: signed.requestHash };
}

async function discard(res) {
  await res.arrayBuffer().catch(() => {});
}

export function createS3ObjectStorage({
  bucket, region, accessKeyId, secretAccessKey, endpoint = null, forcePathStyle = false, fetchImpl = globalThis.fetch, now = () => new Date(),
}) {
  if (!bucket || !region || !accessKeyId || !secretAccessKey) throw new FlowError('invalid', 'S3 storage needs a bucket, region and keys');

  async function call(method, key, { body = null, contentType = null } = {}) {
    assertStorageKey(key);
    const at = now();
    const located = locate({ bucket, region, key, endpoint, forcePathStyle });
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
    const headers = {
      host: located.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate(at),
    };
    if (contentType) headers['content-type'] = contentType;
    const { header } = authorizationHeader({
      method, path: located.path, headers, payloadHash, accessKeyId, secretAccessKey, region, now: at,
    });
    const sent = { ...headers, authorization: header };
    delete sent.host;
    const res = await fetchImpl(`${located.protocol}//${located.host}${located.path}`, {
      method,
      headers: sent,
      body: body ?? undefined,
    }).catch(() => { throw unavailable(); });
    return res;
  }

  return {
    kind: 's3',
    async put({ key, body, contentType }) {
      if (!Buffer.isBuffer(body)) throw new FlowError('invalid', 'photo is required');
      const res = await call('PUT', key, { body, contentType });
      if (!res.ok) {
        await discard(res);
        throw unavailable();
      }
      await discard(res);
    },
    async get(key) {
      const res = await call('GET', key);
      if (res.status === 404) {
        await discard(res);
        return null;
      }
      if (!res.ok) {
        await discard(res);
        throw unavailable();
      }
      return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
    },
    async delete(key) {
      const res = await call('DELETE', key);
      if (!res.ok && res.status !== 404) {
        await discard(res);
        throw unavailable();
      }
      await discard(res);
    },
    signedLink({ key, expiresInSeconds = LINK_TTL_SECONDS }) {
      const signed = presignedGetUrl({
        accessKeyId, secretAccessKey, region, bucket, key, expiresInSeconds, endpoint, forcePathStyle, now: now(),
      });
      return { url: signed.url, expiresAt: signed.expiresAt };
    },
    // An S3 link is opened by S3, not by Flow's file route.
    openLink() {
      return { ok: false, code: 'link_invalid' };
    },
  };
}

function bufferOf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value) && Buffer.isBuffer(value[0])) return value[0];
  return null;
}

function isMissing(error) {
  if (!error) return false;
  if (String(error.name ?? '') === 'ObjectNotFoundError') return true;
  const code = error.code ?? error.status ?? error.statusCode;
  return code === 404 || code === '404';
}

// `client` is a Replit Object Storage Client (uploadFromBytes, downloadAsBytes,
// delete). downloadAsBytes resolves to a one-item array of buffers.
export function createReplitObjectStorage({ client, signingKey, now = () => new Date() }) {
  const signer = createLinkSigner(signingKey);

  async function resultOf(promise) {
    try {
      return await promise;
    } catch {
      throw unavailable();
    }
  }

  return {
    kind: 'replit',
    async put({ key, body }) {
      assertStorageKey(key);
      if (!Buffer.isBuffer(body)) throw new FlowError('invalid', 'photo is required');
      const result = await resultOf(client.uploadFromBytes(key, body));
      if (!result?.ok) throw unavailable();
    },
    async get(key) {
      assertStorageKey(key);
      const result = await resultOf(client.downloadAsBytes(key));
      if (!result?.ok) {
        if (isMissing(result?.error)) return null;
        throw unavailable();
      }
      const body = bufferOf(result.value);
      if (!body) throw unavailable();
      return { body, contentType: null };
    },
    async delete(key) {
      assertStorageKey(key);
      const result = await resultOf(client.delete(key, { ignoreNotFound: true }));
      if (!result?.ok && !isMissing(result?.error)) throw unavailable();
    },
    signedLink(options) {
      return flowLink(signer, { ...options, now });
    },
    openLink(token) {
      return signer.open(token, now());
    },
  };
}

function configuredSigningKey(env, secrets) {
  const raw = String(env.FLOW_STORAGE_SIGNING_KEY ?? '').trim();
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  if (raw) return createHash('sha256').update(raw).digest();
  if (secrets?.key) return deriveKey(secrets, 'storage-signing');
  return null;
}

const FOLDER_BLOCKED = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTDIR']);

function rethrowKey(error) {
  if (FOLDER_BLOCKED.has(error?.code)) throw error;
  throw new Error('FLOW_STORAGE=local could not read its signing key');
}

async function readOrCreateKey(root) {
  const file = path.join(path.resolve(root), '.signing-key');
  try {
    const existing = await readFile(file);
    if (existing.length >= 32) return existing.subarray(0, 32);
  } catch (error) {
    if (error?.code !== 'ENOENT') rethrowKey(error);
  }
  await mkdir(path.dirname(file), { recursive: true });
  const key = randomBytes(32);
  try {
    await writeFile(file, key, { flag: 'wx', mode: 0o600 });
    return key;
  } catch (error) {
    if (error?.code !== 'EEXIST') rethrowKey(error);
  }
  const created = await readFile(file);
  if (created.length >= 32) return created.subarray(0, 32);
  throw new Error('FLOW_STORAGE=local could not read its signing key');
}

function onReplit(env) {
  return Boolean(String(env.REPL_ID ?? '').trim() || String(env.REPLIT_DEPLOYMENT ?? '').trim());
}

function storageMode(env) {
  const set = String(env.FLOW_STORAGE ?? '').trim().toLowerCase();
  if (set) return set;
  if (onReplit(env)) return 'off';
  return 'local';
}

async function loadReplitClient() {
  let Client;
  try {
    ({ Client } = await import('@replit/object-storage'));
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw new Error('FLOW_STORAGE=replit could not load @replit/object-storage');
  }
  try {
    return new Client();
  } catch {
    throw new Error('FLOW_STORAGE=replit could not open the bucket');
  }
}

// Answers { storage, mode, reason }. `storage` is null when captures are off.
// A bad explicit setting throws, so boot stops. On Replit the default is off,
// never the local folder: a publish would drop those files. Where the local
// folder cannot be created, an unset FLOW_STORAGE is off too.
export async function resolveObjectStorage({ env = process.env, secrets = null, root = null } = {}) {
  const mode = storageMode(env);
  const explicit = Boolean(String(env.FLOW_STORAGE ?? '').trim());
  if (!['local', 's3', 'replit', 'off'].includes(mode)) throw new Error('FLOW_STORAGE must be "local", "s3", "replit" or "off"');
  if (mode === 'off') return { storage: null, mode, reason: 'off' };
  if (mode === 'local') {
    if (env.REPLIT_DEPLOYMENT) throw new Error('FLOW_STORAGE=local cannot be used on a published Replit app: a publish keeps no files');
    const folder = root ?? env.FLOW_STORAGE_DIR ?? path.join('data', 'storage');
    try {
      const signingKey = configuredSigningKey(env, secrets) ?? await readOrCreateKey(folder);
      return { storage: createLocalObjectStorage({ root: folder, signingKey }), mode, reason: null };
    } catch (error) {
      // The server image is read-only. An unset FLOW_STORAGE must not stop boot.
      if (FOLDER_BLOCKED.has(error?.code)) {
        if (!explicit) return { storage: null, mode: 'off', reason: 'local_not_writable' };
        throw new Error('FLOW_STORAGE=local could not create its folder');
      }
      throw error;
    }
  }
  if (mode === 's3') {
    const bucket = String(env.FLOW_S3_BUCKET ?? '').trim();
    const region = String(env.FLOW_S3_REGION ?? '').trim();
    const accessKeyId = String(env.FLOW_S3_ACCESS_KEY_ID ?? '').trim();
    const secretAccessKey = String(env.FLOW_S3_SECRET_ACCESS_KEY ?? '').trim();
    if (!bucket || !region || !accessKeyId || !secretAccessKey) throw new Error('FLOW_STORAGE=s3 needs FLOW_S3_BUCKET, FLOW_S3_REGION, FLOW_S3_ACCESS_KEY_ID and FLOW_S3_SECRET_ACCESS_KEY');
    return {
      storage: createS3ObjectStorage({
        bucket, region, accessKeyId, secretAccessKey,
        endpoint: String(env.FLOW_S3_ENDPOINT ?? '').trim() || null,
        forcePathStyle: String(env.FLOW_S3_FORCE_PATH_STYLE ?? '').trim().toLowerCase() === 'on',
      }),
      mode,
      reason: null,
    };
  }
  try {
    const client = await loadReplitClient();
    if (!client) {
      if (explicit) throw new Error('FLOW_STORAGE=replit needs the @replit/object-storage package');
      return { storage: null, mode, reason: 'replit_client_missing' };
    }
    const signingKey = configuredSigningKey(env, secrets);
    if (!signingKey) {
      if (explicit) throw new Error('FLOW_STORAGE=replit needs FLOW_SECRETS_KEY or FLOW_STORAGE_SIGNING_KEY');
      return { storage: null, mode, reason: 'signing_key_missing' };
    }
    return { storage: createReplitObjectStorage({ client, signingKey }), mode, reason: null };
  } catch (error) {
    if (explicit) throw error;
    return { storage: null, mode, reason: 'replit_unavailable' };
  }
}
