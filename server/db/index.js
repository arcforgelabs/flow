import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

// Session advisory lock held while any migration runs (Flow's own, each
// integration's, and the Replit workspace sync), so two processes sharing one
// database never apply the same migration at once. Field uses the same
// pattern with its own key.
export const MIGRATION_LOCK_KEY = 7_139_000_101n;
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 300_000;

// Flow's tables live in their own schema, not "public": Replit's publish
// compares the workspace's "public" with production's and offers to make
// production match, deletes included (migration 0021, docs/REPLIT.md). Every
// connection searches "flow" first, so queries keep plain table names; the
// database's own default says the same for a pooler's sessions.
export const FLOW_SCHEMA = 'flow';
export const FLOW_SEARCH_PATH = `${FLOW_SCHEMA}, public`;
const setSearchPath = (client) => client.query(`set search_path to ${FLOW_SEARCH_PATH}`);

// Opens Flow's PostgreSQL database. The caller owns the pool: call close().
export function openDatabase({ url = process.env.DATABASE_URL, max = 10 } = {}) {
  if (!url) throw new Error('flow: DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url, max });
  // A client runs its queries in order, so this comes before any other.
  pool.on('connect', (client) => {
    setSearchPath(client).catch(() => {});
  });
  // The server can close an idle connection (a restart, a pooler, migration
  // 0021); the pool drops it and opens another. Unheard, it would stop Flow.
  pool.on('error', (error) => {
    console.warn(`[db] an idle database connection closed: ${error.message}`);
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

// A transaction-mode pooler (PgBouncer, Neon's "-pooler" hosts) does not keep
// a session, so it cannot hold a session lock. Neon names a pooled endpoint
// by adding "-pooler" to the endpoint id; the same host without it is the
// direct endpoint, which migrations use instead (as Field does).
const POOLER_HOST = /-pooler(?=\.|$)/i;

export function directUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!POOLER_HOST.test(parsed.hostname)) return null;
  parsed.hostname = parsed.hostname.replace(POOLER_HOST, '');
  return parsed.toString();
}

function migrationLockTimeoutMs(env = process.env) {
  const value = Number.parseInt(env.FLOW_DB_MIGRATION_LOCK_TIMEOUT_MS || '', 10);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
}

// Runs fn(lockedDb) under MIGRATION_LOCK_KEY. The lock and fn share one
// connection taken from db's pool (or the pooler's direct endpoint), because
// a session lock belongs to one connection. It waits up to
// FLOW_DB_MIGRATION_LOCK_TIMEOUT_MS (300000) for another process to finish.
export async function withMigrationLock(db, fn, { timeoutMs = migrationLockTimeoutMs() } = {}) {
  const source = db?.$client;
  if (!source) throw new Error('flow: a migration needs a PostgreSQL database from openDatabase');
  const direct = source instanceof pg.Pool ? directUrl(source.options?.connectionString) : null;
  let client;
  if (direct) {
    client = new pg.Client({ connectionString: direct });
    await client.connect();
    await setSearchPath(client);
  } else {
    client = source instanceof pg.Pool ? await source.connect() : source;
  }
  let broken = false;
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await client.query('select pg_try_advisory_lock($1::bigint) as locked', [MIGRATION_LOCK_KEY.toString()]);
      if (rows[0].locked) break;
      if (Date.now() >= deadline) {
        throw new Error(`flow: another process held the migration lock (advisory lock ${MIGRATION_LOCK_KEY}) for over ${timeoutMs} ms; is a migration hung? (FLOW_DB_MIGRATION_LOCK_TIMEOUT_MS)`);
      }
      await new Promise((wake) => setTimeout(wake, 250));
    }
    try {
      return await fn(drizzle(client, { schema }));
    } finally {
      // A connection that cannot unlock is closed, which also frees the lock.
      await client.query('select pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY.toString()]).catch(() => { broken = true; });
    }
  } finally {
    if (direct) await client.end().catch(() => {});
    else if (client !== source) client.release(broken);
  }
}

// Applies the migrations in `folder` (this build's own by default) under the
// migration lock. `table` names the journal: drizzle.__drizzle_migrations for
// Flow's own, one per integration (server/integrations/schema.js).
export function migrateDatabase(db, { folder = migrationsFolder, table } = {}) {
  return withMigrationLock(db, (locked) => migrate(locked, { migrationsFolder: folder, ...(table ? { migrationsTable: table } : {}) }));
}

export { migrationsFolder, schema };
