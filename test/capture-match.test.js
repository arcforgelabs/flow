import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { matchJobs, proposeChange, readDate } from '../server/core/capture-match.js';
import { matchCapture, typeProposal, uploadCapture } from '../server/core/captures.js';
import { createOrganisation } from '../server/core/directory.js';
import { createLocalObjectStorage } from '../server/core/storage.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Synthetic jobs and forms. No real practice, dentist or patient.
const NOW = new Date('2026-10-28T00:00:00Z');
const JOBS = [
  { sourceSystem: 'seazona', sourceJobRef: '4821', caseRef: '4821', clientName: 'North Bay Dental', practitioner: 'Dr Ana Ito', dueOn: '2026-10-31', lines: [{ description: 'Zirconia crown 24' }] },
  { sourceSystem: 'seazona', sourceJobRef: '4822', caseRef: '4822', clientName: 'North Bay Dental', practitioner: 'Dr Ana Ito', dueOn: '2026-11-02', lines: [{ description: 'Night guard' }] },
  { sourceSystem: 'seazona', sourceJobRef: '5100', caseRef: '5100', clientName: 'Hill Street Smiles', practitioner: 'Dr Ben Cole', dueOn: '2026-12-15', lines: [{ description: 'Full denture' }] },
];
const field = (key, value, sure = 0.95) => ({ key, value, seen: value, sure });

test('the matcher finds one sure job, a few close jobs, or no job', () => {
  const sure = matchJobs({ case_number: '4821', practice: 'North Bay', due_date: '30/10', work: 'crown' }, JOBS, { now: NOW });
  assert.equal(sure.outcome, 'sure');
  assert.equal(sure.jobs[0].jobId, 'seazona:4821');
  assert.equal(sure.jobs[0].score, 92);
  assert.deepEqual(sure.jobs[0].signals.map((s) => s.signal), ['case_number', 'practice', 'date', 'work']);

  // No case number: two jobs of the same practice and dentist are close.
  const close = matchJobs({ practice: 'Nth Bay Dental', dentist: 'Ana Itoh', due_date: '01/11/2026' }, JOBS, { now: NOW });
  assert.equal(close.outcome, 'close');
  assert.deepEqual(close.jobs.map((j) => j.jobId), ['seazona:4821', 'seazona:4822']);

  const none = matchJobs({ practice: 'Lakeside Dental', work: 'bridge' }, JOBS, { now: NOW });
  assert.deepEqual(none, { outcome: 'none', jobs: [] });
});

test('a misread case number still matches, and a date has no year', () => {
  const misread = matchJobs({ case_number: '48Z1' }, JOBS, { now: NOW });
  assert.equal(misread.jobs[0].jobId, 'seazona:4821');
  assert.equal(misread.jobs[0].signals[0].signal, 'case_number_misread');
  assert.equal(misread.outcome, 'close');
  assert.equal(readDate('2/1', NOW).toISOString().slice(0, 10), '2027-01-02');
  assert.equal(readDate('31/02/2026', NOW), null);
});

test('the proposal updates the sure job with what differs, or creates a job', () => {
  const read = [field('case_number', '4821'), field('practice', 'North Bay'), field('dentist', 'Dr Ana Ito'), field('due_date', '2026-10-30', 0.6), field('shade', 'A2')];
  const values = Object.fromEntries(read.map((f) => [f.key, f.value]));
  const sure = proposeChange(read, matchJobs(values, JOBS, { now: NOW }), JOBS);
  assert.deepEqual(sure, {
    action: 'update',
    jobId: 'seazona:4821',
    changes: [
      { field: 'due_date', from: '2026-10-31', to: '2026-10-30', sure: 0.6 },
      { field: 'shade', from: '', to: 'A2', sure: 0.95 },
    ],
  });
  const fresh = [field('practice', 'Lakeside Dental'), field('work', 'bridge')];
  const created = proposeChange(fresh, matchJobs({ practice: 'Lakeside Dental', work: 'bridge' }, JOBS, { now: NOW }), JOBS);
  assert.equal(created.action, 'create');
  assert.equal(created.jobId, null);
  assert.deepEqual(created.changes.map((c) => c.field), ['practice', 'work']);
});

describe('matching a stored capture', { skip: skipWithoutDatabase }, () => {
  let handle;
  let storage;
  let organisationId;
  before(async () => {
    handle = await freshDatabase();
    storage = createLocalObjectStorage({ root: mkdtempSync(path.join(tmpdir(), 'flow-match-')), signingKey: Buffer.alloc(32, 3) });
    organisationId = (await createOrganisation(handle.db, { name: 'Synthetic Lab' })).id;
  });
  after(async () => { await handle?.close(); });

  const stored = async (key) => (await uploadCapture(handle.db, storage, organisationId, {
    bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    contentType: 'image/png', idempotencyKey: key, baseUrl: 'http://127.0.0.1',
  })).capture;

  test('a read capture is matched, and a typed proposal is kept', async () => {
    const capture = await stored('match-read');
    await handle.pool.query(`update captures set state = 'ready', problem = null, read = $2 where id = $1`, [
      capture.id, JSON.stringify({ fields: [field('case_number', '4821'), field('shade', 'A2')] }),
    ]);
    const matched = await matchCapture(handle.db, storage, organisationId, capture.id, { baseUrl: 'http://127.0.0.1', jobs: JOBS, now: NOW });
    assert.equal(matched.capture.match.outcome, 'sure');
    assert.equal(matched.capture.proposal.jobId, 'seazona:4821');
    assert.deepEqual(matched.capture.proposal.changes.map((c) => c.field), ['shade']);

    await typeProposal(handle.db, storage, organisationId, capture.id, { action: 'note', jobId: 'seazona:5100', changes: [{ field: 'notes', to: 'Typed' }] }, { baseUrl: 'http://127.0.0.1' });
    const again = await matchCapture(handle.db, storage, organisationId, capture.id, { baseUrl: 'http://127.0.0.1', jobs: JOBS, now: NOW });
    assert.equal(again.capture.proposal.action, 'note');
    assert.equal(again.capture.proposal.jobId, 'seazona:5100');
  });

  test('typed fields match a capture the reader could not read', async () => {
    const capture = await stored('match-typed');
    assert.equal(capture.state, 'problem');
    const typed = await matchCapture(handle.db, storage, organisationId, capture.id, {
      baseUrl: 'http://127.0.0.1', jobs: JOBS, now: NOW, fields: { case_number: '5l00', work: 'denture' },
    });
    assert.equal(typed.capture.state, 'ready');
    assert.equal(typed.capture.match.jobs[0].jobId, 'seazona:5100');
    await assert.rejects(
      () => matchCapture(handle.db, storage, organisationId, capture.id, { baseUrl: 'http://127.0.0.1', jobs: JOBS, fields: ['not', 'an', 'object'] }),
      /fields must be an object/,
    );
  });
});
