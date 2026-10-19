import { sql } from 'drizzle-orm';
import { organisations } from '../db/schema.js';
import { applyImport, planImport, readEarlierFlow, summarisePlan } from './earlier-flow.js';

// The import from the earlier codebase, run once by the server itself. On a
// host with no shell next to the app (a published Replit app) the operator
// moves the earlier tables into their own schema, then sets
// FLOW_IMPORT_EARLIER_SCHEMA and FLOW_IMPORT_ORGANISATION. While the database
// has no organisation, the next start reads that schema in a read-only
// transaction and writes the records (server/import/earlier-flow.js). Once an
// organisation exists, it does nothing.

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function resolveImportAtStart(env = process.env) {
  const schema = (env.FLOW_IMPORT_EARLIER_SCHEMA ?? '').trim();
  if (!schema) return null;
  if (!SCHEMA_NAME.test(schema)) throw new Error('FLOW_IMPORT_EARLIER_SCHEMA must be a plain lower-case schema name, e.g. earlier');
  const organisationName = (env.FLOW_IMPORT_ORGANISATION ?? '').trim();
  if (!organisationName) throw new Error('FLOW_IMPORT_ORGANISATION (the lab\'s name) is required with FLOW_IMPORT_EARLIER_SCHEMA');
  return { schema, organisationName };
}

// Returns the import's counts, or null when there was nothing to do.
export async function importEarlierAtStart({ db, pool, settings, log = console }) {
  if (!settings) return null;
  const [{ count }] = (await db.execute(sql`select count(*)::int as count from ${organisations}`)).rows;
  if (count > 0) {
    log.info?.('[import] skipped: this database already has an organisation (unset FLOW_IMPORT_EARLIER_SCHEMA)');
    return null;
  }

  let plan;
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    // The schema name was checked against SCHEMA_NAME, so it is safe to quote.
    await client.query(`SET LOCAL search_path TO "${settings.schema}"`);
    plan = planImport(await readEarlierFlow(client));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(`could not read schema "${settings.schema}": ${error.message}`);
  } finally {
    client.release();
  }

  log.info?.(`[import] plan from schema "${settings.schema}": ${JSON.stringify(summarisePlan(plan))}`);
  const result = await applyImport(db, plan, { organisationName: settings.organisationName });
  log.info?.(`[import] imported: ${JSON.stringify(result.counts)}`);
  return result.counts;
}
