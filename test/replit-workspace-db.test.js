// scripts/replit-workspace-db.js: the comparison on its own, the production
// /health read against a local stand-in, the fetch against a local bare
// repository standing in for GitHub, and sync end to end on PostgreSQL
// (FLOW_TEST_DATABASE_URL), with Flow's own and the integrations' journals.
// Synthetic databases only.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

import {
  EXIT,
  compareMigrations,
  fetchProductionBuild,
  fetchReleaseMigrations,
  journalFolders,
  journalTable,
  overallState,
  outOfOrder,
  productionJournals,
  productionOrigin,
  readJournal,
  run,
} from '../scripts/replit-workspace-db.js';
import { MIGRATION_LOCK_KEY, directUrl, migrateDatabase, openDatabase, withMigrationLock } from '../server/db/index.js';
import { skipWithoutDatabase, testDatabaseUrl } from './support/db.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const REVISION = 'a'.repeat(40);

const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { ...GIT_ENV, HOME: cwd }, encoding: 'utf8' }).trim();
}

const entry = (tag, when, hash = `hash-${tag}`) => ({ tag, when, hash });
const row = (e) => ({ hash: e.hash, created_at: e.when });
const A = entry('0000_a', 100);
const B = entry('0001_b', 200);
const C = entry('0002_c', 300);

test('compareMigrations: level when the database has exactly the release\'s migrations', () => {
  const result = compareMigrations({ release: [A, B], applied: [row(A), row(B)] });
  assert.equal(result.state, 'level');
  assert.deepEqual(result.missing, []);
  // created_at comes back from PostgreSQL as a string (bigint).
  assert.equal(compareMigrations({ release: [A], applied: [{ hash: A.hash, created_at: '100' }] }).state, 'level');
  assert.equal(compareMigrations({ release: [], applied: [] }).state, 'level');
});

test('compareMigrations: behind when the database lacks the release\'s newest migrations', () => {
  assert.deepEqual(compareMigrations({ release: [A, B, C], applied: [row(A)] }), {
    state: 'behind',
    missing: ['0001_b', '0002_c'],
    extra: [],
    mismatched: [],
    skipped: [],
  });
  assert.equal(compareMigrations({ release: [A, B], applied: [] }).state, 'behind');
});

test('compareMigrations: ahead when the database has migrations the release does not', () => {
  const result = compareMigrations({ release: [A], applied: [row(A), row(B)], known: [A, B] });
  assert.equal(result.state, 'ahead');
  assert.deepEqual(result.extra, [{ created_at: 200, hash: B.hash, tag: '0001_b' }]);
  // A row nobody's journal knows is still listed, by its created_at.
  assert.equal(compareMigrations({ release: [A], applied: [row(A), row(C)] }).extra[0].tag, null);
  // An integration that is off in production: any row in the workspace is ahead.
  assert.equal(compareMigrations({ release: [], applied: [row(A)], known: [A] }).state, 'ahead');
});

test('compareMigrations: diverged on a different hash, a skipped migration, or extra and missing at once', () => {
  const changed = compareMigrations({ release: [A, B], applied: [row(A), { hash: 'other', created_at: 200 }] });
  assert.equal(changed.state, 'diverged');
  assert.deepEqual(changed.mismatched, ['0001_b']);
  // drizzle applies only migrations newer than its newest row, so B would never run.
  const skipped = compareMigrations({ release: [A, B, C], applied: [row(A), row(C)] });
  assert.equal(skipped.state, 'diverged');
  assert.deepEqual(skipped.skipped, ['0001_b']);
  const both = compareMigrations({ release: [A, B], applied: [row(A), row(C)] });
  assert.equal(both.state, 'diverged');
  assert.deepEqual(both.missing, ['0001_b']);
});

test('the worst journal decides the state', () => {
  assert.equal(overallState(['level', 'level']), 'level');
  assert.equal(overallState(['level', 'behind']), 'behind');
  assert.equal(overallState(['behind', 'ahead']), 'ahead');
  assert.equal(overallState(['ahead', 'diverged', 'behind']), 'diverged');
});

test('each journal follows only as far as production applied it; an integration off in production has none', () => {
  const journals = productionJournals({ core: [A, B], xero: [A, B, C], seazona: [A] }, { core: 2, xero: 3 });
  assert.deepEqual(journals.core.production, [A, B]);
  assert.deepEqual(journals.xero.production, [A, B, C]);
  assert.deepEqual(journals.seazona.production, []);
  assert.deepEqual(journals.seazona.release, [A]);
  assert.throws(() => productionJournals({ core: [A] }, { core: 2 }), /reports 2 core migrations, but the commit it runs has 1/);
});

test('an out-of-order entry production skipped: production has every other entry, and a workspace row for it is not extra', () => {
  // D was written after C but carries an older `when`: a database that had C
  // first never applies D.
  const D = entry('0003_d', 250);
  const E = entry('0004_e', 400);
  assert.deepEqual(outOfOrder([A, B, C, D, E]), [D]);
  assert.deepEqual(outOfOrder([A, B, C]), []);

  const journals = productionJournals({ core: [A, B, C, D, E] }, { core: 4 });
  assert.deepEqual(journals.core.production, [A, B, C, E]);
  assert.deepEqual(journals.core.skipped, [D]);
  // A count that does not fit that reading is the first entries, as before.
  assert.deepEqual(productionJournals({ core: [A, B, C, D, E] }, { core: 3 }).core.production, [A, B, C]);
  assert.deepEqual(productionJournals({ core: [A, B, C, D, E] }, { core: 5 }).core.skipped, []);

  // The workspace applied D before C and lacks E: behind, not diverged.
  const { production, skipped } = journals.core;
  const behind = compareMigrations({ release: production, applied: [row(A), row(B), row(D), row(C)], known: journals.core.release, tolerated: skipped });
  assert.equal(behind.state, 'behind');
  assert.deepEqual(behind.missing, [E.tag]);
  assert.deepEqual(behind.extra, []);
  assert.equal(compareMigrations({ release: production, applied: [row(A), row(B), row(D), row(C), row(E)], tolerated: skipped }).state, 'level');
  assert.equal(compareMigrations({ release: production, applied: [row(A), row(B), row(C), row(E)], tolerated: skipped }).state, 'level');
  // A row for D with other contents is still extra.
  assert.equal(compareMigrations({ release: production, applied: [row(A), row(B), { hash: 'other', created_at: D.when }, row(C), row(E)], tolerated: skipped }).state, 'ahead');
});

test('a new migration is always later than the ones before it (0013 is the one known exception)', () => {
  for (const [id, folder] of Object.entries(journalFolders(REPO_ROOT))) {
    const late = outOfOrder(readJournal(folder)).map((e) => e.tag);
    assert.deepEqual(late, id === 'core' ? ['0013_line_mappings'] : [], `${id} journal`);
  }
});

test('every journal of a Flow tree is found, with the drizzle table it records into', () => {
  const folders = journalFolders(REPO_ROOT);
  assert.equal(folders.core, join(REPO_ROOT, 'server/db/migrations'));
  assert.ok(folders.xero && folders.seazona);
  assert.equal(journalTable('core'), '__drizzle_migrations');
  assert.equal(journalTable('my-lab'), '__drizzle_migrations_my_lab');
});

test('migrations reach a pooled Neon endpoint through its direct host, which keeps the lock\'s session', () => {
  assert.equal(directUrl('postgres://u:p@ep-cool-1-pooler.us-east-2.aws.neon.tech/db?sslmode=require'), 'postgres://u:p@ep-cool-1.us-east-2.aws.neon.tech/db?sslmode=require');
  assert.equal(directUrl('postgres://u:p@ep-cool-1.us-east-2.aws.neon.tech/db'), null);
  assert.equal(directUrl('postgres://u:p@localhost:5432/db'), null);
  assert.equal(directUrl(undefined), null);
});

test('productionOrigin keeps the origin and refuses credentials and other schemes', () => {
  assert.equal(productionOrigin('https://flow.example.com/some/path?x=1'), 'https://flow.example.com');
  assert.throws(() => productionOrigin('https://user:pass@flow.example.com'), /user name or password/);
  assert.throws(() => productionOrigin('ftp://flow.example.com'), /https/);
  assert.throws(() => productionOrigin('flow.example.com'), /not a URL/);
});

async function standInProduction() {
  const state = { health: { ok: true, build: {} }, status: 200, requests: [] };
  const server = createServer((req, res) => {
    state.requests.push({ url: req.url, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
    res.writeHead(state.status, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify(state.health));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}

test('fetchProductionBuild reads build.revision and schema.migrations from /health, without credentials', async () => {
  const production = await standInProduction();
  try {
    production.state.health = {
      ok: true,
      build: { revision: REVISION, release: 'v2026.10.38', ref: 'stable', source: 'github' },
      schema: { migrations: { core: 20, xero: 9, seazona: 0, 'Bad Id': 3 } },
    };
    assert.deepEqual(await fetchProductionBuild(production.origin), {
      revision: REVISION,
      release: 'v2026.10.38',
      ref: 'stable',
      source: 'github',
      migrations: { core: 20, xero: 9, seazona: 0 },
    });
    assert.deepEqual(production.state.requests.at(-1), { url: '/health', authorization: null, cookie: null });

    production.state.health = { ok: true, build: { revision: REVISION } };
    await assert.rejects(fetchProductionBuild(production.origin), /no schema\.migrations/);
    production.state.health = { ok: true, build: { revision: null }, schema: { migrations: { core: 1 } } };
    await assert.rejects(fetchProductionBuild(production.origin), /no build\.revision/);
    production.state.status = 503;
    await assert.rejects(fetchProductionBuild(production.origin), /HTTP 503/);
  } finally {
    await production.close();
  }
  await assert.rejects(fetchProductionBuild(production.origin), /did not answer/);
});

test('fetchReleaseMigrations fetches one commit\'s core and integration migrations, and nothing else', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-workspace-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '-b', 'main', work);
  cpSync(join(REPO_ROOT, 'server/db/migrations'), join(work, 'server/db/migrations'), { recursive: true });
  cpSync(join(REPO_ROOT, 'server/integrations/xero/migrations'), join(work, 'server/integrations/xero/migrations'), { recursive: true });
  writeFileSync(join(work, 'server/integrations/xero/index.js'), 'export {};\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'release');
  const revision = git(work, 'rev-parse', 'HEAD');
  const bare = join(dir, 'remote.git');
  git(dir, 'clone', '-q', '--bare', work, bare);
  // Anonymous fetches of a commit by its hash, as from GitHub.
  git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');

  const cacheDir = join(dir, 'cache');
  const tree = fetchReleaseMigrations({ repo: `file://${bare}`, revision, cacheDir });
  const folders = journalFolders(tree);
  assert.deepEqual(Object.keys(folders), ['core', 'xero']);
  assert.deepEqual(readJournal(folders.core), readJournal(join(REPO_ROOT, 'server/db/migrations')));
  assert.deepEqual(readJournal(folders.xero), readJournal(join(REPO_ROOT, 'server/integrations/xero/migrations')));
  assert.throws(() => readFileSync(join(tree, 'server/integrations/xero/index.js')), /ENOENT/);
  // The second time it reads the cache, with no fetch.
  assert.equal(fetchReleaseMigrations({ repo: 'file:///nowhere', revision, cacheDir }), tree);

  assert.throws(() => fetchReleaseMigrations({ repo: `file://${bare}`, revision: 'b'.repeat(40), cacheDir }), /could not fetch/);
  assert.throws(() => fetchReleaseMigrations({ repo: 'ssh://x', revision, cacheDir }), /https/);
});

test('run refuses the published app, and does nothing without the production address', async () => {
  const refused = await run({ command: 'sync', env: { REPLIT_DEPLOYMENT: '1', FLOW_PRODUCTION_URL: 'https://flow.example' } });
  assert.equal(refused.exitCode, EXIT.failed);
  assert.match(refused.summary.error, /published app/);
  const skipped = await run({ command: 'sync', env: { DATABASE_URL: 'postgres://u:p@h/db' } });
  assert.equal(skipped.exitCode, EXIT.ok);
  assert.equal(skipped.summary.state, 'skipped');
  assert.match(skipped.summary.message, /FLOW_PRODUCTION_URL/);
  assert.equal((await run({ command: 'drop' })).exitCode, EXIT.failed);
});

// The real migrations of this checkout stand in for the release production
// runs. Production's /health counts decide how far each journal goes.
const releaseTree = () => REPO_ROOT;
const counts = () => Object.fromEntries(Object.entries(journalFolders(REPO_ROOT)).map(([id, folder]) => [id, readJournal(folder).length]));

describe('the workspace sync on PostgreSQL', { skip: skipWithoutDatabase }, () => {
  let admin;
  before(async () => {
    admin = new pg.Pool({ connectionString: testDatabaseUrl, max: 2 });
    // Migration 0021 closes this role's idle sessions; the pool opens others.
    admin.on('error', () => {});
  });
  after(async () => { await admin?.end(); });

  const empty = () => admin.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS flow CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const syncWith = (command, migrations, env = {}) =>
    run({
      command,
      env: { FLOW_PUBLIC_ORIGIN: 'https://flow.example', DATABASE_URL: testDatabaseUrl, ...env },
      deps: {
        fetchProductionBuild: async () => ({ revision: REVISION, release: 'v2026.10.99', ref: 'stable', source: 'github', migrations }),
        fetchReleaseMigrations: releaseTree,
      },
      warn: () => {},
    });
  const tableExists = async (name) => (await admin.query('select to_regclass($1) is not null as present', [name])).rows[0].present;

  test('behind: status reports it, sync applies production\'s core and integration migrations, then level', async () => {
    await empty();
    const production = { ...counts(), seazona: 0 };
    const status = await syncWith('status', production);
    assert.equal(status.exitCode, EXIT.behind, JSON.stringify(status.summary));
    assert.equal(status.summary.state, 'behind');
    assert.ok(status.summary.missing.core.length > 0);
    assert.ok(status.summary.missing.xero.length > 0);
    assert.equal(status.summary.missing.seazona, undefined);

    const synced = await syncWith('sync', production);
    assert.equal(synced.exitCode, EXIT.ok, JSON.stringify(synced.summary));
    assert.equal(synced.summary.state, 'level');
    assert.equal(synced.summary.appliedNow, production.core + production.xero);
    assert.deepEqual(synced.summary.migrations.seazona, { production: 0, workspace: 0 });
    assert.equal(await tableExists('flow.invoices'), true);
    assert.equal(await tableExists('flow.xero_connections'), true);
    // Seazona is off in production, so its tables are not made in the workspace.
    assert.equal(await tableExists('flow.seazona_api_governor'), false);
    assert.doesNotMatch(JSON.stringify(synced.summary), /postgres:\/\//);

    const again = await syncWith('sync', production);
    assert.equal(again.summary.state, 'level');
    assert.equal(again.summary.appliedNow, 0);
  });

  test('ahead: the workspace has core migrations production does not; nothing changes', async () => {
    const production = { ...counts(), seazona: 0, core: counts().core - 2 };
    const result = await syncWith('sync', production);
    assert.equal(result.exitCode, EXIT.attention);
    assert.equal(result.summary.state, 'ahead');
    const tags = readJournal(join(REPO_ROOT, 'server/db/migrations')).map((e) => e.tag);
    assert.deepEqual(result.summary.extra, { core: tags.slice(-2) });
    assert.match(result.summary.message, /press Cancel/);
  });

  test('an integration journal: tables production does not have are ahead', async () => {
    const handle = openDatabase({ url: testDatabaseUrl, max: 2 });
    try {
      await migrateDatabase(handle.db, { folder: join(REPO_ROOT, 'server/integrations/seazona/migrations'), table: journalTable('seazona') });
    } finally {
      await handle.close();
    }
    const result = await syncWith('status', { ...counts(), seazona: 0 });
    assert.equal(result.exitCode, EXIT.attention);
    assert.equal(result.summary.state, 'ahead');
    assert.equal(result.summary.extra.seazona.length, readJournal(join(REPO_ROOT, 'server/integrations/seazona/migrations')).length);
    // With Seazona on in production, the same workspace is level.
    assert.equal((await syncWith('status', counts())).summary.state, 'level');
  });

  test('diverged: a migration recorded with different contents; nothing changes', async () => {
    await admin.query('update drizzle.__drizzle_migrations_xero set hash = $1 where id = (select max(id) from drizzle.__drizzle_migrations_xero)', ['changed']);
    const result = await syncWith('sync', counts());
    assert.equal(result.exitCode, EXIT.attention);
    assert.equal(result.summary.state, 'diverged');
    assert.equal(result.summary.mismatched.xero.length, 1);
  });

  test('production skipped core 0013 (out of order): a workspace without the newest migration is behind, and sync applies it', async (t) => {
    await empty();
    const core = join(REPO_ROOT, 'server/db/migrations');
    const entries = readJournal(core);
    const late = outOfOrder(entries);
    assert.deepEqual(late.map((e) => e.tag), ['0013_line_mappings']);
    // The workspace applied every core migration but the newest, as an
    // install did before the newest release.
    const older = mkdtempSync(join(tmpdir(), 'flow-older-core-'));
    t.after(() => rmSync(older, { recursive: true, force: true }));
    cpSync(core, older, { recursive: true });
    const journal = JSON.parse(readFileSync(join(older, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.slice(0, -1);
    writeFileSync(join(older, 'meta/_journal.json'), JSON.stringify(journal));
    const handle = openDatabase({ url: testDatabaseUrl, max: 2 });
    try {
      await migrateDatabase(handle.db, { folder: older });
    } finally {
      await handle.close();
    }
    const newest = entries.at(-1).tag;
    // Production has every core migration but 0013, so it reports one fewer.
    const production = { ...counts(), seazona: 0, xero: 0, core: entries.length - late.length };
    const status = await syncWith('status', production);
    assert.equal(status.summary.state, 'behind', JSON.stringify(status.summary));
    assert.deepEqual(status.summary.missing, { core: [newest] });

    const synced = await syncWith('sync', production);
    assert.equal(synced.exitCode, EXIT.ok, JSON.stringify(synced.summary));
    assert.equal(synced.summary.state, 'level');
    assert.equal(await tableExists('flow.job_field_settings'), true);
  });

  test('production stopped part-way through a journal: the workspace does not copy that', async () => {
    await empty();
    const result = await syncWith('sync', { ...counts(), seazona: 0, xero: 1 });
    assert.equal(result.exitCode, EXIT.failed);
    assert.match(result.summary.error, /applied 1 of the \d+ xero migrations/);
  });

  test('a migration waits for the migration lock, and gives up after its timeout', async () => {
    const holder = await admin.connect();
    const handle = openDatabase({ url: testDatabaseUrl, max: 2 });
    try {
      await holder.query('select pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY.toString()]);
      await assert.rejects(withMigrationLock(handle.db, async () => assert.fail('must wait'), { timeoutMs: 300 }), /migration lock/);
      const waiting = withMigrationLock(handle.db, async () => 'ran', { timeoutMs: 10_000 });
      await new Promise((wait) => setTimeout(wait, 400));
      await holder.query('select pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY.toString()]);
      assert.equal(await waiting, 'ran');
      // Released afterwards: another session takes it at once.
      const { rows } = await holder.query('select pg_try_advisory_lock($1::bigint) as locked', [MIGRATION_LOCK_KEY.toString()]);
      assert.equal(rows[0].locked, true);
      await holder.query('select pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY.toString()]);
    } finally {
      holder.release();
      await handle.close();
    }
  });
});
