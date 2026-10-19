import { and, eq, isNull, sql } from 'drizzle-orm';
import { lineMappings, organisations, priceItems, priorLinks } from '../db/schema.js';
import { lineLookupText, remapJobs } from '../core/line-mapping.js';
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

// The earlier app's table of jobs bound to accounting invoices. Each row ties a
// Seazona order to the Xero invoice that already bills it.
const EARLIER_LINKS = 'seazona_order_xero_match_overrides';
const LINK_ORIGIN = `earlier:${EARLIER_LINKS}`;
const LINK_BATCH = 500;

function matchedAt(text) {
  const at = text ? new Date(text) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

// Carries the earlier app's order -> invoice links into `prior_links`, at
// every start while the import settings are set. It reads in a read-only
// transaction and only adds links it does not hold, so a repeat costs one read
// and changes nothing. It copies ids and how each link was made; never the
// earlier notes or who made it, which can name people. Answers counts, or null
// when there is nothing to read.
export async function importEarlierLinksAtStart({ db, pool, settings, log = console }) {
  if (!settings) return null;
  // The lab the import made, by name; or the only organisation, if renamed since.
  const { rows: labs } = await db.execute(sql`select id, name from ${organisations}`);
  const organisation = labs.find((lab) => lab.name === settings.organisationName) ?? (labs.length === 1 ? labs[0] : null);
  if (!organisation) return null;

  let rows;
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL search_path TO "${settings.schema}"`);
    const { rows: [found] } = await client.query('select to_regclass($1) is not null as present', [EARLIER_LINKS]);
    if (found.present) {
      ({ rows } = await client.query(`select seazona_order_id, xero_invoice_id, xero_invoice_number, match_source, matched_at
        from ${EARLIER_LINKS} where coalesce(xero_invoice_id, '') <> '' and coalesce(seazona_order_id, '') <> ''`));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(`could not read links from schema "${settings.schema}": ${error.message}`);
  } finally {
    client.release();
  }
  if (!rows) {
    log.info?.(`[import] links: schema "${settings.schema}" has no ${EARLIER_LINKS}`);
    return null;
  }

  const values = rows.map((row) => ({
    organisationId: organisation.id,
    sourceSystem: 'seazona',
    sourceJobRef: String(row.seazona_order_id).trim(),
    system: 'xero',
    externalId: String(row.xero_invoice_id).trim(),
    externalNumber: row.xero_invoice_number?.trim() || null,
    matchedBy: row.match_source === 'operator_link' ? 'person' : 'imported',
    matchedAt: matchedAt(row.matched_at),
    origin: LINK_ORIGIN,
  }));
  let added = 0;
  for (let start = 0; start < values.length; start += LINK_BATCH) {
    const written = await db.insert(priorLinks).values(values.slice(start, start + LINK_BATCH))
      .onConflictDoNothing().returning({ id: priorLinks.id });
    added += written.length;
  }
  const counts = { read: values.length, added };
  log.info?.(`[import] links from schema "${settings.schema}": ${JSON.stringify(counts)}`);
  return counts;
}

// Carries the earlier app's line mapping knowledge into Flow, at every start
// while the import settings are set, in the same read-only way:
// - each label and price a person matched to an item becomes a "saved" line
//   mapping (server/core/line-mapping.js), unless the lab already has one;
// - each price item with no description takes the accounting item's own.
// Answers counts, or null when there is nothing to read.
const EARLIER_RULES = 'xero_item_match_rules';
const EARLIER_ITEMS = 'xero_catalog_items';

export async function importEarlierMappingsAtStart({ db, pool, settings, log = console }) {
  if (!settings) return null;
  const { rows: labs } = await db.execute(sql`select id, name from ${organisations}`);
  const organisation = labs.find((lab) => lab.name === settings.organisationName) ?? (labs.length === 1 ? labs[0] : null);
  if (!organisation) return null;

  let rules = [];
  let items = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL search_path TO "${settings.schema}"`);
    const present = async (table) => (await client.query('select to_regclass($1) is not null as present', [table])).rows[0].present;
    if (await present(EARLIER_RULES)) {
      ({ rows: rules } = await client.query(`select source_lookup_text, unit_amount_cents, xero_item_code from ${EARLIER_RULES}`));
    }
    if (await present(EARLIER_ITEMS)) {
      ({ rows: items } = await client.query(`select item_code, description from ${EARLIER_ITEMS} where coalesce(description, '') <> ''`));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(`could not read mappings from schema "${settings.schema}": ${error.message}`);
  } finally {
    client.release();
  }

  const values = rules
    .map((row) => ({
      organisationId: organisation.id,
      kind: 'saved',
      match: 'exact',
      label: lineLookupText(row.source_lookup_text),
      unitAmountCents: Number(row.unit_amount_cents),
      itemCode: String(row.xero_item_code ?? '').trim(),
      origin: `earlier:${EARLIER_RULES}`,
    }))
    .filter((v) => v.label && v.label.length <= 200 && v.itemCode && Number.isInteger(v.unitAmountCents) && v.unitAmountCents >= 0);
  const added = values.length ? (await db.insert(lineMappings).values(values).onConflictDoNothing().returning({ id: lineMappings.id })).length : 0;
  let described = 0;
  for (const item of items) {
    const updated = await db.update(priceItems).set({ description: String(item.description).trim().slice(0, 1000) })
      .where(and(eq(priceItems.organisationId, organisation.id), eq(priceItems.code, String(item.item_code).trim()), isNull(priceItems.description)))
      .returning({ id: priceItems.id });
    described += updated.length;
  }
  if (added) await remapJobs(db, organisation.id);
  const counts = { rules: values.length, added, described };
  log.info?.(`[import] mappings from schema "${settings.schema}": ${JSON.stringify(counts)}`);
  return counts;
}
