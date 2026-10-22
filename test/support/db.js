import { openDatabase, migrateDatabase } from '../../server/db/index.js';

// Tests that need PostgreSQL read FLOW_TEST_DATABASE_URL. Never point it at a
// real installation: setup drops Flow's schema and recreates the whole public schema.
// Outside CI the tests skip when it is unset; in CI they fail instead.
export const testDatabaseUrl = process.env.FLOW_TEST_DATABASE_URL;

export const skipWithoutDatabase = testDatabaseUrl
  ? false
  : process.env.CI
    ? false
    : 'FLOW_TEST_DATABASE_URL is not set';

export async function freshDatabase() {
  if (!testDatabaseUrl) throw new Error('FLOW_TEST_DATABASE_URL is not set (CI needs a PostgreSQL service)');
  const handle = openDatabase({ url: testDatabaseUrl, max: 4 });
  await handle.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS flow CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrateDatabase(handle.db);
  return handle;
}
