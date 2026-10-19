import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrationsTable } from '../integrations/schema.js';

// Flow's doctor: checks a database against this build. It reads, and never
// changes anything.
//
//   - each migration journal (Flow's own, and each shipped adapter's): how
//     many of this build's migrations the database has applied;
//   - every table and column this build's latest core snapshot declares, and
//     every table each adapter declares: which are missing;
//   - the tables in public that neither declares (another app's, or an
//     earlier Flow's).
//
// On Replit it runs on the workspace's database after each update
// (scripts/replit-deploy.sh), and compares that database with the live app's
// GET /health, which reports the same migration counts. Replit's publish step
// offers to make production's tables match the workspace's, so the
// comparison says what that step will show (docs/REPLIT.md, "The workspace
// updater"). Anyone who runs Flow can run it: `flow-server doctor`.

const CORE_MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));
const CORE_TABLE = '__drizzle_migrations';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// What this build expects: one journal per migrations folder, and the tables
// (with their columns, where a snapshot names them) those migrations create.
export function expectedSchema({ adapters = [] } = {}) {
  const journals = [{ id: 'core', table: CORE_TABLE, folder: CORE_MIGRATIONS }];
  for (const adapter of adapters) {
    if (!adapter.schema) continue;
    journals.push({ id: adapter.id, table: migrationsTable(adapter), folder: adapter.schema.migrationsFolder, tables: adapter.schema.tables });
  }
  const tables = new Map();
  for (const journal of journals) {
    const { entries } = readJson(`${journal.folder}/meta/_journal.json`);
    journal.tags = entries.map((entry) => entry.tag);
    const last = entries.at(-1);
    let snapshot = null;
    try {
      snapshot = last ? readJson(`${journal.folder}/meta/${String(last.idx).padStart(4, '0')}_snapshot.json`) : null;
    } catch {
      snapshot = null; // An adapter may ship its migrations without snapshots.
    }
    for (const table of Object.values(snapshot?.tables ?? {})) {
      if ((table.schema || 'public') !== 'public') continue;
      tables.set(table.name, new Set(Object.keys(table.columns)));
    }
    for (const name of journal.tables ?? []) {
      if (!tables.has(name)) tables.set(name, null);
    }
  }
  return { journals, tables };
}

// How many migrations each journal has applied: { core: 14, xero: 6, ... }.
// A journal whose table does not exist (an adapter never turned on) counts 0.
export async function appliedMigrationCounts(pool, journals) {
  const { rows } = await pool.query(
    "select table_name from information_schema.tables where table_schema = 'drizzle'",
  );
  const present = new Set(rows.map((row) => row.table_name));
  const counts = {};
  for (const journal of journals) {
    if (!present.has(journal.table)) {
      counts[journal.id] = 0;
      continue;
    }
    // The name was read from the catalogue above, so quoting it is enough.
    const result = await pool.query(`select count(*)::int as n from drizzle."${journal.table.replaceAll('"', '""')}"`);
    counts[journal.id] = result.rows[0].n;
  }
  return counts;
}

export async function diagnoseDatabase(pool, { adapters = [] } = {}) {
  const expected = expectedSchema({ adapters });
  const applied = await appliedMigrationCounts(pool, expected.journals);
  const pending = expected.journals
    .filter((journal) => applied[journal.id] < journal.tags.length)
    .map((journal) => ({ journal: journal.id, applied: applied[journal.id], shipped: journal.tags.length, next: journal.tags.slice(applied[journal.id]) }));

  const { rows } = await pool.query(
    "select table_name, column_name from information_schema.columns where table_schema = 'public'",
  );
  const actual = new Map();
  for (const row of rows) {
    if (!actual.has(row.table_name)) actual.set(row.table_name, new Set());
    actual.get(row.table_name).add(row.column_name);
  }
  const missingTables = [];
  const missingColumns = [];
  for (const [table, columns] of expected.tables) {
    const have = actual.get(table);
    if (!have) {
      missingTables.push(table);
      continue;
    }
    for (const column of columns ?? []) {
      if (!have.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }
  const unknownTables = [...actual.keys()].filter((table) => !expected.tables.has(table)).sort();
  return {
    ok: pending.length === 0 && missingTables.length === 0 && missingColumns.length === 0,
    migrations: applied,
    pending,
    missingTables: missingTables.sort(),
    missingColumns: missingColumns.sort(),
    unknownTables,
  };
}

// What Replit's publish step will offer, from the workspace's report and the
// live app's migration counts (GET /health's schema.migrations, or null when
// the live app could not say).
//
//   broken  the workspace database is not at this build: do not publish
//   behind  production has migrations the workspace lacks: the list would
//           drop them, so Cancel and update the workspace first
//   adds    the workspace is ahead: the list holds additions only; approve
//   same    the two match: no list
//   unknown the live app did not say: approve additions, Cancel a DROP
export function publishVerdict(report, live) {
  if (!report.ok) return { verdict: 'broken', say: 'The workspace database is not at this build. Do not publish. Update the workspace again.' };
  if (!live) return { verdict: 'unknown', say: 'The live app did not report its migrations. Publish: approve a list of additions; Cancel any DROP.' };
  const behind = Object.entries(live).filter(([id, n]) => n > (report.migrations[id] ?? 0)).map(([id]) => id);
  if (behind.length) {
    return { verdict: 'behind', say: `Production has ${behind.join(', ')} migrations the workspace lacks. Do not publish: Replit would offer to DROP them. Update the workspace first.` };
  }
  const ahead = Object.entries(report.migrations).filter(([id, n]) => n > (live[id] ?? 0)).map(([id]) => id);
  if (ahead.length) {
    return { verdict: 'adds', say: `The workspace is ahead of production (${ahead.join(', ')}). Publish: Replit offers to add tables or columns only. Approve.` };
  }
  return { verdict: 'same', say: 'The workspace and production are at the same migrations. Publish: Replit shows no database changes.' };
}

// The live app's migration counts from its GET /health, or null.
export async function liveMigrationCounts(origin, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  try {
    const url = new URL('/health', origin);
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok && res.status !== 503) return null;
    const body = await res.json();
    const counts = body?.schema?.migrations;
    return counts && typeof counts === 'object' ? counts : null;
  } catch {
    return null;
  }
}

export function formatReport(report, verdict = null) {
  const lines = [];
  for (const [id, n] of Object.entries(report.migrations)) {
    const pending = report.pending.find((p) => p.journal === id);
    lines.push(`${id} migrations: ${n} applied${pending ? `, ${pending.next.length} pending (${pending.next.join(', ')})` : ''}`);
  }
  lines.push(report.missingTables.length ? `missing tables: ${report.missingTables.join(', ')}` : 'tables: all present');
  lines.push(report.missingColumns.length ? `missing columns: ${report.missingColumns.join(', ')}` : 'columns: all present');
  if (report.unknownTables.length) {
    lines.push(`tables this build does not know: ${report.unknownTables.join(', ')}. On Replit, publishing offers to copy them to production.`);
  }
  if (verdict) lines.push(`verdict: ${verdict.verdict}. ${verdict.say}`);
  return lines;
}
