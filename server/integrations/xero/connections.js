import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { xeroError } from './client.js';

// The Xero connection of each Flow organisation: which Xero organisation it
// is, and the refresh token. Xero rotates the refresh token on every use, so
// the newest one must be stored durably. It is stored encrypted with
// XERO_TOKEN_KEY (AES-256-GCM), bound to the Flow organisation so a stored
// token cannot be copied to another row. The client id and secret come from
// settings and are never stored. Tokens are never logged.

const FORMAT = 'v1';

function aad(organisationId) {
  return Buffer.from(`flow:xero:refresh-token:${organisationId}`);
}

export function encryptToken(token, key, organisationId) {
  if (!key) throw xeroError('xero_token_key_missing', 'XERO_TOKEN_KEY is not set, so Flow cannot store the Xero refresh token.', { status: 503 });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(organisationId));
  const sealed = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return [FORMAT, iv.toString('base64'), cipher.getAuthTag().toString('base64'), sealed.toString('base64')].join(':');
}

export function decryptToken(stored, key, organisationId) {
  const [format, iv, tag, sealed] = String(stored ?? '').split(':');
  if (!key || format !== FORMAT || !iv || !tag || !sealed) {
    throw xeroError('xero_token_unreadable', 'The stored Xero token cannot be read with XERO_TOKEN_KEY. Connect Xero again.', { status: 409 });
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(aad(organisationId));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw xeroError('xero_token_unreadable', 'The stored Xero token cannot be read with XERO_TOKEN_KEY. Connect Xero again.', { status: 409 });
  }
}

const COLUMNS = sql`organisation_id, mode, tenant_id, tenant_name, scope, refresh_token_enc, connected_by, connected_at, refreshed_at`;

function mapRow(row) {
  if (!row) return null;
  return {
    organisationId: row.organisation_id,
    mode: row.mode,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    scope: row.scope,
    refreshTokenEnc: row.refresh_token_enc,
    connectedBy: row.connected_by,
    connectedAt: row.connected_at,
    refreshedAt: row.refreshed_at,
  };
}

// The connection with its sealed token, or null. `lock` holds the row for
// the transaction, so two token refreshes never race.
export async function readConnection(db, organisationId, { lock = false } = {}) {
  const { rows } = await db.execute(sql`select ${COLUMNS} from xero_connections where organisation_id = ${organisationId} ${lock ? sql`for update` : sql``}`);
  return mapRow(rows[0]);
}

export async function saveConnection(db, { organisationId, mode, tenantId, tenantName, scope, refreshToken, connectedBy, key }) {
  const sealed = encryptToken(refreshToken, key, organisationId);
  const { rows } = await db.execute(sql`
    insert into xero_connections (organisation_id, mode, tenant_id, tenant_name, scope, refresh_token_enc, connected_by)
    values (${organisationId}, ${mode}, ${tenantId}, ${tenantName}, ${scope}, ${sealed}, ${connectedBy})
    on conflict (organisation_id) do update set
      mode = excluded.mode, tenant_id = excluded.tenant_id, tenant_name = excluded.tenant_name,
      scope = excluded.scope, refresh_token_enc = excluded.refresh_token_enc,
      connected_by = excluded.connected_by, connected_at = now(), refreshed_at = null, updated_at = now()
    returning ${COLUMNS}`);
  return mapRow(rows[0]);
}

export async function storeRotatedToken(db, organisationId, { refreshToken, scope, key }) {
  const sealed = encryptToken(refreshToken, key, organisationId);
  await db.execute(sql`
    update xero_connections set refresh_token_enc = ${sealed}, scope = coalesce(${scope ?? null}, scope),
      refreshed_at = now(), updated_at = now()
    where organisation_id = ${organisationId}`);
}

export async function deleteConnection(db, organisationId) {
  const { rows } = await db.execute(sql`delete from xero_connections where organisation_id = ${organisationId} returning ${COLUMNS}`);
  return mapRow(rows[0]);
}

// What may be shown about a connection: never the token.
export function describeConnection(connection) {
  if (!connection) return null;
  return {
    mode: connection.mode,
    tenantId: connection.tenantId,
    tenantName: connection.tenantName,
    scopes: String(connection.scope ?? '').split(/\s+/).filter(Boolean),
    connectedBy: connection.connectedBy,
    connectedAt: connection.connectedAt,
    refreshedAt: connection.refreshedAt,
  };
}
