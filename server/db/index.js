import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

// Opens Flow's PostgreSQL database. The caller owns the pool: call close().
export function openDatabase({ url = process.env.DATABASE_URL, max = 10 } = {}) {
  if (!url) throw new Error('flow: DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url, max });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export function migrateDatabase(db) {
  return migrate(db, { migrationsFolder });
}

export { schema };
