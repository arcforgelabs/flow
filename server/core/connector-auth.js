import { createHash, createPublicKey, verify } from 'node:crypto';

const SKEW_SECONDS = 300;

export function canonicalRequest({ method, path, timestamp, body }) {
  const raw = body == null || body === '' ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const hash = createHash('sha256').update(raw).digest('hex');
  return `${timestamp}\n${String(method).toUpperCase()}\n${path}\n${hash}`;
}

export function publicKeyFromDer(derBase64) {
  return createPublicKey({ key: Buffer.from(derBase64, 'base64'), format: 'der', type: 'spki' });
}

// One Gateway key is bound to one Flow person. The server keeps the public
// key only. The Gateway keeps the private key and signs each request.
export function keysFromEnv(env = process.env) {
  const id = env.FLOW_CONNECTOR_KEY_ID;
  const publicKey = env.FLOW_CONNECTOR_PUBLIC_KEY;
  const personId = env.FLOW_CONNECTOR_PERSON_ID;
  if (!id && !publicKey && !personId) return [];
  if (!id || !publicKey || !personId) {
    throw new Error('Set FLOW_CONNECTOR_KEY_ID, FLOW_CONNECTOR_PUBLIC_KEY and FLOW_CONNECTOR_PERSON_ID together.');
  }
  return [{ id, publicKey: publicKeyFromDer(publicKey), personId }];
}

export function verifyConnectorSignature({ method, path, body, headers, keys, now = Date.now() }) {
  const keyId = header(headers, 'x-flow-key-id');
  const timestamp = header(headers, 'x-flow-timestamp');
  const signature = header(headers, 'x-flow-signature');
  if (!keyId || !timestamp || !signature) return null;
  const key = keys.find((item) => item.id === keyId);
  if (!key) return null;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return null;
  if (Math.abs(now / 1000 - seconds) > SKEW_SECONDS) return null;
  const payload = Buffer.from(canonicalRequest({ method, path, timestamp, body }));
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature, 'base64');
  } catch {
    return null;
  }
  const valid = verify(null, payload, key.publicKey, signatureBytes);
  return valid ? key : null;
}

function header(headers, name) {
  if (!headers) return '';
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return value == null ? '' : String(value);
}
