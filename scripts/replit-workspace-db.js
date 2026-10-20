#!/usr/bin/env node
// Keep a Replit workspace's database at exactly the migrations production runs.
//
//   node scripts/replit-workspace-db.js status   # compare; change nothing
//   node scripts/replit-workspace-db.js sync     # apply what the workspace is missing
//   npm run db:follow-production                 # the same as sync
//
// A Replit installation has two databases: the workspace's and the published
// app's. Before each publish Replit compares their tables and, when they
// differ, offers to make production match the workspace ("Development
// database changes detected"). Flow migrates production itself when it
// starts, so that offer is never needed: when the two databases match, it
// does not appear, and when it appears, the answer is Cancel (docs/REPLIT.md,
// "The workspace database"). The same rule as Field's
// (arcforgelabs/field scripts/replit-workspace-db.js).
//
// This asks production which commit it runs, and how many migrations each
// journal has applied (GET <FLOW_PRODUCTION_URL>/health: build.revision,
// schema.migrations). It fetches that commit's migrations from GitHub without
// a token (like scripts/replit-deploy.sh): Flow's own
// (server/db/migrations/) and each integration's
// (server/integrations/<id>/migrations/). Then it compares each journal with
// the workspace database's rows in drizzle.__drizzle_migrations and
// drizzle.__drizzle_migrations_<id>:
//
//   level     the workspace database has exactly production's migrations
//   behind    it lacks some; sync applies them, under Flow's migration lock
//   ahead     it has migrations production does not; nothing is changed
//   diverged  it has different ones; nothing is changed
//
// Production creates an integration's tables only while that integration is
// on, so the workspace follows each journal only as far as production has
// applied it: an integration that is off in production has no tables in the
// workspace either.
//
// It only ever touches the workspace's database (DATABASE_URL) and refuses to
// run in the published app (REPLIT_DEPLOYMENT set). It never connects to
// production's database: production is only asked for its public /health.
//
//   FLOW_PRODUCTION_URL=<https://flow.example>  the published app (a workspace Secret);
//                                               FLOW_PUBLIC_ORIGIN when it is unset
//   FLOW_DEPLOY_REPO=<url>                      fetch from here (default: the public repository)
//
// Without either address it says how to set one and exits 0.
// --warn-only always exits 0, so a failure here never stops the workspace.
//
// It prints one JSON line. The connection string is never printed.
// Exit codes: 0 level, synced or skipped; 1 failed; 2 behind (status only);
// 3 ahead or diverged.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(import.meta.dirname, '..');
export const DEFAULT_REPO = 'https://github.com/arcforgelabs/flow.git';
export const CACHE_DIR = join(REPO_ROOT, '.flow-workspace-db');
const CORE_PATH = 'server/db/migrations';
const INTEGRATIONS_PATH = 'server/integrations';
const HEALTH_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 180_000;
const REVISION = /^[0-9a-f]{40}$/;
const JOURNAL_ID = /^[a-z][a-z0-9-]*$/;

export const EXIT = { ok: 0, failed: 1, behind: 2, attention: 3 };

// The drizzle table that records a journal: Flow's own, or an integration's
// (server/integrations/schema.js, migrationsTable).
export function journalTable(id) {
  return id === 'core' ? '__drizzle_migrations' : `__drizzle_migrations_${id.replaceAll('-', '_')}`;
}

// What drizzle-orm's migrator (0.45, drizzle-orm/migrator.js) records for each
// journal entry: hash is the sha256 of the .sql file read as text, created_at
// is the entry's `when`. It applies an entry only when `when` is later than
// the newest created_at already recorded.
export function readJournal(folder) {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8'));
  return journal.entries.map((entry) => {
    const text = readFileSync(join(folder, `${entry.tag}.sql`)).toString();
    return { tag: entry.tag, when: Number(entry.when), hash: createHash('sha256').update(text).digest('hex') };
  });
}

// Every journal in a tree laid out like Flow's: { core: folder, xero: folder, ... }.
export function journalFolders(root) {
  const folders = {};
  const core = join(root, CORE_PATH);
  if (existsSync(join(core, 'meta', '_journal.json'))) folders.core = core;
  const integrations = join(root, INTEGRATIONS_PATH);
  if (existsSync(integrations)) {
    for (const id of readdirSync(integrations).sort()) {
      const folder = join(integrations, id, 'migrations');
      if (JOURNAL_ID.test(id) && existsSync(join(folder, 'meta', '_journal.json'))) folders[id] = folder;
    }
  }
  return folders;
}

// Compare a release's journal ([{ tag, when, hash }]) with the rows a database
// recorded ([{ hash, created_at }]). Pure; `known` (other journal entries,
// such as the release's full journal) only names rows the release does not have.
//
// Returns { state, missing, extra, mismatched, skipped } where state is
// "level", "behind", "ahead" or "diverged":
//   missing     release tags the database lacks
//   extra       rows the release does not have ({ created_at, hash, tag })
//   mismatched  release tags recorded with a different hash
//   skipped     missing tags older than the newest row, which drizzle's
//               migrator would never apply
export function compareMigrations({ release, applied, known = [] }) {
  const byWhen = new Map(release.map((entry) => [entry.when, entry]));
  const knownByWhen = new Map(known.map((entry) => [entry.when, entry]));
  const recorded = new Set();
  const extra = [];
  const mismatched = [];
  let newest = -Infinity;
  for (const row of applied) {
    const createdAt = Number(row.created_at);
    newest = Math.max(newest, createdAt);
    const entry = byWhen.get(createdAt);
    if (!entry) {
      extra.push({ created_at: createdAt, hash: row.hash, tag: knownByWhen.get(createdAt)?.tag ?? null });
      continue;
    }
    recorded.add(createdAt);
    if (entry.hash !== row.hash) mismatched.push(entry.tag);
  }
  const missingEntries = release.filter((entry) => !recorded.has(entry.when));
  const missing = missingEntries.map((entry) => entry.tag);
  const skipped = missingEntries.filter((entry) => entry.when <= newest).map((entry) => entry.tag);
  let state;
  if (mismatched.length || skipped.length || (extra.length && missing.length)) state = 'diverged';
  else if (extra.length) state = 'ahead';
  else if (missing.length) state = 'behind';
  else state = 'level';
  return { state, missing, extra, mismatched, skipped };
}

// The journal states together: the worst one wins.
export function overallState(states) {
  for (const state of ['diverged', 'ahead', 'behind']) if (states.includes(state)) return state;
  return 'level';
}

// The production URL as an origin with no credentials, path or query.
export function productionOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FLOW_PRODUCTION_URL is not a URL; set it to the published app's address, such as https://flow.example.com");
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('FLOW_PRODUCTION_URL must start with https://');
  }
  if (url.username || url.password) {
    throw new Error('FLOW_PRODUCTION_URL must not hold a user name or password');
  }
  return url.origin;
}

// Ask production which build it runs and how far each journal is. No
// credentials: /health is public.
export async function fetchProductionBuild(origin, { fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(`${origin}/health`, {
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`${origin}/health did not answer (${error?.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : error?.cause?.code || error?.message || error})`);
  }
  if (!response.ok) throw new Error(`${origin}/health answered HTTP ${response.status}; is production up?`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${origin}/health did not answer JSON; is FLOW_PRODUCTION_URL the published Flow app?`);
  }
  const build = body?.build ?? {};
  const revision = typeof build.revision === 'string' ? build.revision.trim().toLowerCase() : '';
  if (!REVISION.test(revision)) {
    throw new Error(`${origin}/health has no build.revision (a 40-character commit), so the release production runs is unknown. A publish built by scripts/replit-deploy.sh reports it`);
  }
  const counts = body?.schema?.migrations;
  if (!counts || typeof counts !== 'object' || !Number.isInteger(counts.core)) {
    throw new Error(`${origin}/health has no schema.migrations, so how far production's database is is unknown`);
  }
  const migrations = {};
  for (const [id, n] of Object.entries(counts)) {
    if (JOURNAL_ID.test(id) && Number.isInteger(n) && n >= 0) migrations[id] = n;
  }
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return { revision, release: text(build.release), ref: text(build.ref), source: text(build.source), migrations };
}

function runGit(cwd, args) {
  return execFileSync('git', ['-C', cwd, '-c', 'credential.helper=', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function validRepo(repo) {
  return /^(https:\/\/|file:\/\/)[^\s]+$/.test(repo);
}

const isMigrationPath = (path) =>
  path.startsWith(`${CORE_PATH}/`) || /^server\/integrations\/[^/]+\/migrations\//.test(path);

// Fetch `revision`'s migrations (Flow's own and each integration's) into
// <cacheDir>/<revision>/ and return that folder, laid out like the repository.
// Anonymous, depth 1, from `repo`; the fetched commit must be `revision`. A
// folder fetched before is reused. Only <cacheDir> is written.
export function fetchReleaseMigrations({ repo = DEFAULT_REPO, revision, cacheDir = CACHE_DIR }) {
  if (!REVISION.test(revision)) throw new Error(`'${revision}' is not a 40-character commit`);
  if (!validRepo(repo)) throw new Error('FLOW_DEPLOY_REPO must be an https:// URL');
  const target = join(cacheDir, revision);
  const folder = join(target, 'tree');
  if (existsSync(join(target, 'complete'))) return folder;

  mkdirSync(cacheDir, { recursive: true });
  const work = join(cacheDir, `.fetch-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(work);
    runGit(work, ['init', '-q']);
    try {
      runGit(work, ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30', 'fetch', '-q', '--depth', '1', '--no-tags', repo, revision]);
    } catch (error) {
      const reason = String(error.stderr || error.message).trim().split('\n').pop();
      throw new Error(`could not fetch ${revision} from ${repo} (${reason})`);
    }
    const fetched = runGit(work, ['rev-parse', 'FETCH_HEAD^{commit}']).trim();
    if (fetched !== revision) throw new Error(`fetched ${fetched} from ${repo}, not ${revision}`);
    const paths = runGit(work, ['ls-tree', '-r', '-z', '--name-only', 'FETCH_HEAD', '--', `${CORE_PATH}/`, `${INTEGRATIONS_PATH}/`])
      .split('\0')
      .filter((path) => path && isMigrationPath(path));
    if (!paths.includes(`${CORE_PATH}/meta/_journal.json`)) {
      throw new Error(`${revision} has no ${CORE_PATH}/meta/_journal.json`);
    }
    const staged = join(work, 'out');
    for (const path of paths) {
      const out = join(staged, 'tree', path);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, execFileSync('git', ['-C', work, 'cat-file', 'blob', `FETCH_HEAD:${path}`], { maxBuffer: 64 * 1024 * 1024 }));
    }
    writeFileSync(join(staged, 'complete'), `${revision}\n`);
    rmSync(target, { recursive: true, force: true });
    renameSync(staged, target);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // Keep only the newest release fetched.
  for (const name of readdirSync(cacheDir)) {
    if (REVISION.test(name) && name !== revision) rmSync(join(cacheDir, name), { recursive: true, force: true });
  }
  return folder;
}

// The rows drizzle-orm recorded in one journal, oldest first; [] before its
// first migration.
export async function readAppliedMigrations(pool, table) {
  const { rows: [exists] } = await pool.query('select to_regclass($1) is not null as present', [`drizzle."${table}"`]);
  if (!exists?.present) return [];
  const { rows } = await pool.query(`select hash, created_at from drizzle."${table.replaceAll('"', '""')}" order by id`);
  return rows.map((row) => ({ hash: row.hash, created_at: Number(row.created_at) }));
}

// The workspace database through Flow's own database module. Imported only
// when needed.
async function workspaceDb(env) {
  const { openDatabase, migrateDatabase } = await import('../server/db/index.js');
  const handle = openDatabase({ url: env.DATABASE_URL, max: 2 });
  return {
    readApplied: (table) => readAppliedMigrations(handle.pool, table),
    apply: (folder, table) => migrateDatabase(handle.db, { folder, table }),
    close: () => handle.close(),
  };
}

function describe(id, result) {
  const named = (rows) => rows.map((row) => row.tag ?? `created_at ${row.created_at}`).join(', ');
  const parts = [];
  if (result.extra.length) parts.push(`${id} has ${result.extra.length} migration(s) production does not: ${named(result.extra)}`);
  if (result.mismatched.length) parts.push(`${id} recorded ${result.mismatched.join(', ')} with different contents`);
  if (result.skipped.length) parts.push(`${id} lacks ${result.skipped.join(', ')}, older than its newest migration`);
  return parts.join('; ');
}

const ATTENTION_HELP =
  "Nothing was changed. If Replit shows 'Development database changes detected', press Cancel. " +
  'When production publishes a release with these migrations, the workspace is level again by itself. ' +
  "Otherwise replace the workspace database (docs/REPLIT.md, 'The workspace database')";

// Where production's journals stand: for each journal of its release, the
// entries production has applied (the first `count`, as drizzle applies them
// in order). A journal production reports more of than its release has
// cannot be followed.
export function productionJournals(releaseJournals, counts) {
  const journals = {};
  for (const [id, entries] of Object.entries(releaseJournals)) {
    const count = counts[id] ?? 0;
    if (count > entries.length) {
      throw new Error(`production reports ${count} ${id} migrations, but the commit it runs has ${entries.length}`);
    }
    journals[id] = { release: entries, production: entries.slice(0, count) };
  }
  return journals;
}

// The whole command. `deps` replaces the database and network for tests.
export async function run({ command, env = process.env, deps = {}, warn = console.error }) {
  const summary = { ok: false, command };
  const fail = (message, exitCode = EXIT.failed) => ({ exitCode, summary: { ...summary, error: message } });
  if (command !== 'status' && command !== 'sync') {
    return fail('usage: replit-workspace-db.js status|sync [--warn-only]');
  }
  if (String(env.REPLIT_DEPLOYMENT ?? '').trim()) {
    return fail('refused: this is the published app (REPLIT_DEPLOYMENT is set). It follows production only in the workspace');
  }
  const productionUrl = String(env.FLOW_PRODUCTION_URL ?? '').trim() || String(env.FLOW_PUBLIC_ORIGIN ?? '').trim();
  if (!productionUrl) {
    return {
      exitCode: EXIT.ok,
      summary: {
        ...summary,
        ok: true,
        state: 'skipped',
        message:
          "FLOW_PRODUCTION_URL is not set, so the workspace database does not follow production. Add a workspace Secret (Tools > Secrets) named FLOW_PRODUCTION_URL with the published app's address, such as https://flow.example.com",
      },
    };
  }
  if (!deps.db && !String(env.DATABASE_URL ?? '').trim()) {
    return fail("no workspace database: set DATABASE_URL (add Replit's PostgreSQL database)");
  }

  let db;
  try {
    const origin = productionOrigin(productionUrl);
    summary.production = { url: origin };
    const build = await (deps.fetchProductionBuild ?? fetchProductionBuild)(origin);
    summary.production = { url: origin, revision: build.revision, release: build.release, ref: build.ref };
    if (build.source === 'workspace') {
      warn('[workspace-db] production is an emergency build of workspace files; its revision is only their base commit');
    }
    const repo = String(env.FLOW_DEPLOY_REPO ?? '').trim() || DEFAULT_REPO;
    const tree = (deps.fetchReleaseMigrations ?? fetchReleaseMigrations)({ repo, revision: build.revision });
    const folders = journalFolders(tree);
    const releaseJournals = Object.fromEntries(Object.entries(folders).map(([id, folder]) => [id, readJournal(folder)]));
    const journals = productionJournals(releaseJournals, build.migrations);

    db = deps.db ?? (await workspaceDb(env));
    const compareAll = async () => {
      const results = {};
      for (const [id, journal] of Object.entries(journals)) {
        const applied = await db.readApplied(journalTable(id));
        results[id] = { ...compareMigrations({ release: journal.production, applied, known: journal.release }), applied: applied.length };
      }
      return results;
    };

    let results = await compareAll();
    let state = overallState(Object.values(results).map((r) => r.state));
    let appliedNow = 0;
    if (state === 'behind' && command === 'sync') {
      for (const [id, result] of Object.entries(results)) {
        if (result.state !== 'behind') continue;
        const journal = journals[id];
        // drizzle applies a whole folder; production stopping part-way
        // through a journal is not something to copy.
        if (journal.production.length !== journal.release.length) {
          return fail(`production has applied ${journal.production.length} of the ${journal.release.length} ${id} migrations of the commit it runs; the workspace follows only a finished migration. Check production's start log`);
        }
        await db.apply(folders[id], journalTable(id));
      }
      const before = Object.values(results).reduce((n, r) => n + r.applied, 0);
      results = await compareAll();
      state = overallState(Object.values(results).map((r) => r.state));
      appliedNow = Object.values(results).reduce((n, r) => n + r.applied, 0) - before;
    }

    summary.migrations = Object.fromEntries(
      Object.entries(journals).map(([id, journal]) => [id, { production: journal.production.length, workspace: results[id].applied }]),
    );
    const listed = (key, map = (x) => x) => {
      const out = {};
      for (const [id, result] of Object.entries(results)) if (result[key].length) out[id] = result[key].map(map);
      return Object.keys(out).length ? { [key]: out } : {};
    };
    Object.assign(summary, {
      state,
      ...(command === 'sync' ? { appliedNow } : {}),
      ...listed('missing'),
      ...listed('extra', (row) => row.tag ?? `created_at ${row.created_at}`),
      ...listed('mismatched'),
      ...listed('skipped'),
    });
    if (state === 'level') {
      summary.ok = true;
      return { exitCode: EXIT.ok, summary };
    }
    if (state === 'behind') {
      if (command === 'sync') return fail('applied migrations, but the workspace database is still behind production');
      summary.ok = true;
      summary.message = 'behind production; `npm run db:follow-production` applies the missing migrations';
      return { exitCode: EXIT.behind, summary };
    }
    const reasons = Object.entries(results)
      .filter(([, result]) => result.state === 'ahead' || result.state === 'diverged')
      .map(([id, result]) => describe(id, result))
      .join('; ');
    summary.message = `The workspace database is ${state} of production${build.release ? ` (${build.release})` : ''}: ${reasons}. ${ATTENTION_HELP}`;
    return { exitCode: EXIT.attention, summary };
  } catch (error) {
    const message = String(error?.message ?? error).replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://[redacted]');
    return fail(message);
  } finally {
    await db?.close?.();
  }
}

async function main(argv) {
  const args = argv.slice(2);
  const warnOnly = args.includes('--warn-only');
  const command = args.find((arg) => !arg.startsWith('--')) ?? 'status';
  const { exitCode, summary } = await run({ command });
  console.log(JSON.stringify(summary));
  if (warnOnly && exitCode !== EXIT.ok) {
    console.error(`[workspace-db] WARNING: ${summary.error ?? summary.message ?? `the workspace database is ${summary.state}`}. Starting anyway.`);
    return EXIT.ok;
  }
  return exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv);
}
