#!/usr/bin/env node
import pg from 'pg';
import { migrateDatabase, openDatabase } from './db/index.js';
import { applyImport, planImport, readEarlierFlow, summarisePlan } from './import/earlier-flow.js';

// Moves an installation's records from the earlier Flow codebase into a new
// Flow database (server/import/earlier-flow.js).
//
//   EARLIER_FLOW_DATABASE_URL=… DATABASE_URL=… \
//     node server/import-earlier-flow.js --organisation "<lab name>" [--dry-run]
//
// The source is only read. Run it against a copy of the source first. The
// target must be a new Flow database: the tool runs Flow's migrations on it
// and refuses one that already has an organisation. It prints counts and
// reasons only, never names, emails or amounts. Keep both connection strings
// out of chat and shell history.

function parseArgs(argv) {
  const args = { dryRun: false, organisation: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--organisation') args.organisation = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceUrl = process.env.EARLIER_FLOW_DATABASE_URL;
  if (!sourceUrl) throw new Error('EARLIER_FLOW_DATABASE_URL is not set');
  if (!args.dryRun && !args.organisation?.trim()) throw new Error('--organisation "<lab name>" is required');

  const source = new pg.Pool({ connectionString: sourceUrl, max: 2 });
  let plan;
  try {
    // A read-only transaction: the source cannot change by mistake.
    const client = await source.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      plan = planImport(await readEarlierFlow(client));
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  } finally {
    await source.end();
  }

  console.log(JSON.stringify({ plan: summarisePlan(plan) }, null, 2));
  if (args.dryRun) return;

  const target = openDatabase({ max: 2 });
  try {
    await migrateDatabase(target.db);
    const result = await applyImport(target.db, plan, { organisationName: args.organisation });
    console.log(JSON.stringify({ imported: result.counts }, null, 2));
  } finally {
    await target.close();
  }
}

main().catch((error) => {
  console.error(`[import] ${error.message}`);
  process.exit(1);
});
