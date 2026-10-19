import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { FlowError } from './errors.js';

// Flow's one secrets key. It encrypts the integration credentials an owner
// enters in Settings (server/integrations/setup.js) before they reach
// PostgreSQL, and derives each integration's own token key. It never sits in
// the database, so a copy of the database alone reads no credential.
//
// FLOW_SECRETS_KEY is the key: 32 bytes, as 64 hex characters or base64.
// When it is unset, Flow derives the key from SESSION_SECRET, a long random
// secret many hosts already hold. Changing the source makes stored
// credentials unreadable: an owner enters them again.

const MIN_SESSION_SECRET = 32;

export function decodeKey(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
    const key = Buffer.from(value, 'base64');
    if (key.length === 32) return key;
  }
  return null;
}

const keyId = (key) => createHash('sha256').update(key).digest('hex').slice(0, 12);

// Answers { key, id, source } or null when neither setting gives a key. A
// FLOW_SECRETS_KEY that is not a key stops boot, so a typo never falls back.
export function resolveSecretsKey(env = process.env) {
  const raw = String(env.FLOW_SECRETS_KEY ?? '').trim();
  if (raw) {
    const key = decodeKey(raw);
    if (!key) throw new Error('FLOW_SECRETS_KEY must be a 32-byte key, as 64 hex characters or base64');
    return { key, id: keyId(key), source: 'FLOW_SECRETS_KEY' };
  }
  const session = String(env.SESSION_SECRET ?? '').trim();
  if (session.length >= MIN_SESSION_SECRET) {
    const key = Buffer.from(hkdfSync('sha256', session, 'flow', 'flow-secrets-key-v1', 32));
    return { key, id: keyId(key), source: 'SESSION_SECRET' };
  }
  return null;
}

// A separate key for one purpose (for example `XERO_TOKEN_KEY`), so no two
// uses share a key.
export function deriveKey(secrets, purpose) {
  return Buffer.from(hkdfSync('sha256', secrets.key, 'flow', `flow-derived-${purpose}`, 32));
}

// AES-256-GCM. `context` (the integration and the setting's name) is bound
// as associated data, so a value moved to another setting does not open.
export function sealSecret(secrets, plaintext, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secrets.key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { v: 1, key: secrets.id, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function openSecret(secrets, sealed, context) {
  if (!secrets || !sealed || sealed.v !== 1 || sealed.key !== secrets.id) {
    throw new FlowError('secret_unreadable', 'this credential was stored with another key; enter it again');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', secrets.key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new FlowError('secret_unreadable', 'this credential cannot be read; enter it again');
  }
}
