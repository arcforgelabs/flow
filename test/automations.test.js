import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { listAutomations, runAutomations, saveAutomation, workStatuses } from '../server/core/automations.js';
import { createOrganisation } from '../server/core/directory.js';
import { explainObligation, observeJob, observeWithdrawn, setReady } from '../server/core/ledger.js';
import { automations, people } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

const KEY = 'mark_ready_from_work_status';
const ACTOR = `automation:${KEY}`;

// Synthetic records only. The pipeline and draft contracts stay in
// invoicing-rules.test.js; this suite owns changes to ready-status settings.
describe('ready-status automations', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  let otherLab;
  let counter = 0;

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
  });
  after(async () => handle?.close());
  beforeEach(async () => {
    lab = await createOrganisation(db, { name: 'Example Lab' });
    otherLab = await createOrganisation(db, { name: 'Other Lab' });
    await saveAutomation(db, lab.id, 'draft_when_ready', { enabled: false });
  });

  const job = (sourceStatus, organisationId = lab.id) => observeJob(db, organisationId, {
    sourceSystem: 'example-work', sourceJobRef: `job-${++counter}`, sourceStatus,
    observedAt: new Date('2026-01-01T00:00:00.000Z'),
    lines: [{ description: 'Example work', unitAmountCents: 1000 }],
  });
  const explain = (row, organisationId = lab.id) => explainObligation(db, organisationId, row.id);
  const run = async () => (await runAutomations(db, lab.id))[KEY];

  test('a new status marks existing jobs; a removed status keeps its marks without repeat events', async () => {
    const shipped = await job('Shipped');
    const queued = await job('Queued');
    const foreign = await job('Queued', otherLab.id);

    assert.deepEqual(await run(), { marked: 1 });
    const first = await explain(shipped);
    assert.ok(first.obligation.readyAt);

    await saveAutomation(db, lab.id, KEY, { config: { statuses: ['Queued'] } });
    assert.equal((await explain(queued)).obligation.readyAt, null, 'saving alone does not mark a job');
    assert.deepEqual(await run(), { marked: 1 });
    const added = await explain(queued);
    assert.ok(added.obligation.readyAt, 'the new status also applies to old jobs');
    assert.equal(added.obligation.readyBy, ACTOR);
    assert.deepEqual(added.events.filter((e) => e.kind === 'ready').map((e) => e.actor), [ACTOR]);
    assert.deepEqual(await explain(shipped), first, 'removing a status keeps the ready mark and its events');
    assert.equal((await explain(foreign, otherLab.id)).obligation.readyAt, null);

    assert.deepEqual(await run(), { marked: 0 });
    assert.deepEqual(await explain(queued), added, 'a repeat run preserves the mark and its events');
    assert.deepEqual(await explain(shipped), first);
  });

  test('a status round trip restores an automatic mark but keeps a person\'s in-work choice', async () => {
    const automatic = await job('Shipped');
    const personal = await job('Shipped');
    assert.deepEqual(await run(), { marked: 2 });
    await setReady(db, lab.id, personal.id, { ready: false, actor: 'person:example' });
    // The work system reports a move back, then Shipped again. Later source
    // events must not replace a person's earlier in-work decision.
    for (const row of [automatic, personal]) {
      const identity = { sourceSystem: row.sourceSystem, sourceJobRef: row.sourceJobRef };
      await observeWithdrawn(db, lab.id, {
        ...identity, sourceStatus: 'In production', observedAt: new Date('2026-01-02T00:00:00.000Z'),
      });
      await observeJob(db, lab.id, {
        ...identity, sourceStatus: 'Shipped', observedAt: new Date('2026-01-03T00:00:00.000Z'), lines: row.lines,
      });
    }
    const keptBack = await explain(personal);

    assert.deepEqual(await run(), { marked: 1 });
    assert.ok((await explain(automatic)).obligation.readyAt);
    assert.deepEqual(await explain(personal), keptBack);
  });

  test('the last save replaces the writer and supplied settings, and keeps omitted settings', async () => {
    const [first, last] = await db.insert(people).values([
      { email: 'first@example.test', role: 'owner' },
      { email: 'last@example.test', role: 'admin' },
    ]).returning();
    await saveAutomation(db, otherLab.id, KEY, { config: { statuses: ['Other'] } }, { personId: first.id });
    await saveAutomation(db, lab.id, KEY, {
      enabled: false, config: { statuses: [' Shipped ', 'SHIPPED', 'In\t production'] },
    }, { personId: first.id });

    const savedRows = () => db.select({ enabled: automations.enabled, config: automations.config, updatedBy: automations.updatedBy })
      .from(automations).where(and(eq(automations.organisationId, lab.id), eq(automations.key, KEY)));
    assert.deepEqual(await savedRows(), [{
      enabled: false, config: { statuses: ['shipped', 'in production'] }, updatedBy: first.id,
    }]);

    await saveAutomation(db, lab.id, KEY, { config: { statuses: ['Delivered'] } }, { personId: last.id });
    assert.deepEqual(await savedRows(), [{
      enabled: false, config: { statuses: ['delivered'] }, updatedBy: last.id,
    }]);
    const enabled = await saveAutomation(db, lab.id, KEY, { enabled: true }, { personId: first.id });
    assert.equal(enabled.enabled, true);
    assert.deepEqual(enabled.config, { statuses: ['delivered'] });
    assert.deepEqual(await savedRows(), [{
      enabled: true, config: { statuses: ['delivered'] }, updatedBy: first.id,
    }]);
    assert.deepEqual((await listAutomations(db, otherLab.id)).find((a) => a.key === KEY).config, { statuses: ['other'] });
  });

  test('the status menu merges case and spaces, ignores blank statuses, and counts only this lab', async () => {
    assert.deepEqual(await workStatuses(db, lab.id), []);
    for (const status of [' Shipped ', 'SHIPPED', 'shipped', 'In  production', 'in\tproduction', 'Zulu', 'Alpha', null, '', ' \t ']) {
      await job(status);
    }
    for (const status of ['Shipped', 'Foreign only']) await job(status, otherLab.id);

    const statuses = await workStatuses(db, lab.id);
    assert.deepEqual(statuses.map(({ value, jobs }) => ({ value, jobs })), [
      { value: 'shipped', jobs: 3 }, { value: 'in production', jobs: 2 },
      { value: 'alpha', jobs: 1 }, { value: 'zulu', jobs: 1 },
    ]);
    assert.ok(['Shipped', 'SHIPPED', 'shipped'].includes(statuses[0].label));
    assert.deepEqual(statuses.slice(2).map((s) => s.label), ['Alpha', 'Zulu']);
  });
});
