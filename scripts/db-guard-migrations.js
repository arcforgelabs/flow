#!/usr/bin/env node
// Makes Flow's new migrations safe to run on a database that already has
// their tables and columns. A second safety net (docs/REPLIT.md, "The
// workspace database"): on Replit, the workspace database follows production
// and the answer to "Development database changes detected" is Cancel, but if
// that prompt is approved by mistake, Replit adds a release's tables to
// production before Flow starts, and Flow's own migration finds them already
// there. Every statement in the core migrations from GUARD_FROM on, and in
// every adapter's migrations, therefore skips what exists:
//
//   CREATE TABLE "t"            -> CREATE TABLE IF NOT EXISTS "t"
//   CREATE [UNIQUE] INDEX "i"   -> CREATE [UNIQUE] INDEX IF NOT EXISTS "i"
//   ADD COLUMN "c"              -> ADD COLUMN IF NOT EXISTS "c"
//   ADD CONSTRAINT, CREATE TYPE -> run in a block that ignores "already exists"
//
// A migration never drops or renames (docs/DATA_MODEL.md); --check refuses one
// that does, and any other statement that would fail on a second run.
//
//   node scripts/db-guard-migrations.js          # rewrite the migrations in place
//   node scripts/db-guard-migrations.js --check  # exit 1 if one is not guarded
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUARD_FROM = 10;
export const BREAKPOINT = '--> statement-breakpoint';
const MIGRATIONS = fileURLToPath(new URL('../server/db/migrations', import.meta.url));
const INTEGRATIONS = fileURLToPath(new URL('../server/integrations', import.meta.url));
const IGNORE_EXISTING = 'duplicate_object OR duplicate_table OR invalid_table_definition';

function ignoreExisting(statement) {
  const body = statement.trim().replace(/;\s*$/, '');
  return `DO $flow_guard$ BEGIN\n\t${body};\nEXCEPTION WHEN ${IGNORE_EXISTING} THEN NULL;\nEND $flow_guard$;`;
}

// One statement, guarded. Returns null for a statement this cannot guard.
// Leading comment lines stay as they are; the guard reads the code after them.
const withoutComments = (statement) => statement.replace(/^(\s*--[^\n]*\n)+/, '').trim();

export function guardStatement(statement) {
  const text = withoutComments(statement);
  if (!text) return statement;
  if (/^DO \$flow_guard\$/.test(text)) return statement;
  if (/^CREATE TABLE IF NOT EXISTS /i.test(text)) return statement;
  if (/^CREATE TABLE /i.test(text)) return statement.replace(/CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ');
  if (/^CREATE (UNIQUE )?INDEX IF NOT EXISTS /i.test(text)) return statement;
  if (/^CREATE (UNIQUE )?INDEX /i.test(text)) return statement.replace(/INDEX /i, 'INDEX IF NOT EXISTS ');
  if (/^ALTER TABLE "[^"]+" ADD COLUMN IF NOT EXISTS /i.test(text)) return statement;
  if (/^ALTER TABLE "[^"]+" ADD COLUMN /i.test(text)) return statement.replace(/ ADD COLUMN /i, ' ADD COLUMN IF NOT EXISTS ');
  if (/^ALTER TABLE "[^"]+" ADD CONSTRAINT /i.test(text) || /^CREATE TYPE /i.test(text)) {
    return statement.replace(text, ignoreExisting(text));
  }
  // Data changes and CREATE OR REPLACE run again without harm.
  if (/^(UPDATE|INSERT|CREATE OR REPLACE) /i.test(text)) return statement;
  return null;
}

export function guardSql(sql) {
  const problems = [];
  const parts = sql.split(BREAKPOINT).map((statement) => {
    const code = statement.replace(/--[^\n]*/g, '').replace(/ON DELETE|ON UPDATE/gi, '');
    if (/\b(DROP|RENAME)\b/i.test(code)) {
      problems.push(`drops or renames: ${withoutComments(statement).split('\n')[0]}`);
      return statement;
    }
    const guarded = guardStatement(statement);
    if (guarded === null) {
      problems.push(`cannot run twice: ${withoutComments(statement).split('\n')[0]}`);
      return statement;
    }
    return guarded;
  });
  return { sql: parts.join(BREAKPOINT), problems };
}

const sqlFiles = (folder) => readdirSync(folder).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();

// The core migrations from GUARD_FROM on, then every adapter's.
export function migrationFiles({ core = MIGRATIONS, integrations = INTEGRATIONS } = {}) {
  const files = sqlFiles(core)
    .filter((name) => Number(name.slice(0, 4)) >= GUARD_FROM)
    .map((name) => join(core, name));
  for (const adapter of readdirSync(integrations).sort()) {
    const folder = join(integrations, adapter, 'migrations');
    if (!existsSync(folder)) continue;
    files.push(...sqlFiles(folder).map((name) => join(folder, name)));
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  let failed = false;
  for (const file of migrationFiles()) {
    const before = readFileSync(file, 'utf8');
    const { sql, problems } = guardSql(before);
    for (const problem of problems) {
      console.error(`${file}: ${problem}`);
      failed = true;
    }
    if (sql === before) continue;
    if (check) {
      console.error(`${file}: not guarded; run node scripts/db-guard-migrations.js`);
      failed = true;
    } else {
      writeFileSync(file, sql);
      console.log(`guarded ${file}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
