import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createContact, createOrganisation } from '../server/core/directory.js';
import { confirmLink, externalIdFor, flowIdFor, linkRecord, supersedeLink } from '../server/core/links.js';
import {
  cancelWrite, claimWrites, markAmbiguous, markFailed, markSent, queueWrite,
} from '../server/core/outbox.js';
import {
  claimJobs, completeJob, enqueueJob, failJob, retryDelayMs, runNextJob,
} from '../server/core/queue.js';
import { listReview, openReview, resolveReview } from '../server/core/review.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Synthetic data only (CONTRIBUTING.md).
describe('data spine', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  let otherLab;
  const actor = 'user:test';

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
    lab = await createOrganisation(db, { name: 'Example Lab' });
    otherLab = await createOrganisation(db, { name: 'Other Lab' });
  });

  after(async () => handle?.close());

  const contact = (name = `Practice ${randomUUID().slice(0, 8)}`) => createContact(db, lab.id, { kind: 'customer', name });
  const ext = () => `00000000-0000-0000-0000-${randomUUID().slice(-12)}`;

  describe('identity map', () => {
    test('an exact link is active and found both ways', async () => {
      const c = await contact();
      const externalId = ext();
      const { outcome, link } = await linkRecord(db, lab.id, {
        entity: 'contact', flowId: c.id, system: 'accounting', externalId, matchedBy: 'exact_id',
      });
      assert.equal(outcome, 'linked');
      assert.equal(link.state, 'active');
      assert.equal(await flowIdFor(db, lab.id, { system: 'accounting', entity: 'contact', externalId }), c.id);
      assert.equal(await externalIdFor(db, lab.id, { system: 'accounting', entity: 'contact', flowId: c.id }), externalId);
      assert.equal(await flowIdFor(db, otherLab.id, { system: 'accounting', entity: 'contact', externalId }), null);
    });

    test('the same link twice is one link', async () => {
      const c = await contact();
      const link = { entity: 'contact', flowId: c.id, system: 'accounting', externalId: ext(), matchedBy: 'imported' };
      const first = await linkRecord(db, lab.id, link);
      const again = await linkRecord(db, lab.id, link);
      assert.equal(again.outcome, 'existing');
      assert.equal(again.link.id, first.link.id);
    });

    test('a link that would move a record is a conflict for a person, and changes nothing', async () => {
      const a = await contact();
      const b = await contact();
      const externalId = ext();
      await linkRecord(db, lab.id, { entity: 'contact', flowId: a.id, system: 'accounting', externalId, matchedBy: 'exact_id' });
      const { outcome } = await linkRecord(db, lab.id, {
        entity: 'contact', flowId: b.id, system: 'accounting', externalId, matchedBy: 'exact_id',
      });
      assert.equal(outcome, 'conflict');
      assert.equal(await flowIdFor(db, lab.id, { system: 'accounting', entity: 'contact', externalId }), a.id);
      const items = await listReview(db, lab.id, { kind: 'link.conflict' });
      assert.ok(items.some((item) => item.flowId === b.id));
    });

    test('a name match waits for a person, and the confirmation closes its review item', async () => {
      const c = await contact();
      const externalId = ext();
      const proposed = await linkRecord(db, lab.id, {
        entity: 'contact', flowId: c.id, system: 'accounting', externalId, matchedBy: 'name',
      });
      assert.equal(proposed.outcome, 'proposed');
      assert.equal(await flowIdFor(db, lab.id, { system: 'accounting', entity: 'contact', externalId }), null);
      const again = await linkRecord(db, lab.id, {
        entity: 'contact', flowId: c.id, system: 'accounting', externalId, matchedBy: 'name',
      });
      assert.equal(again.link.id, proposed.link.id);
      assert.equal((await listReview(db, lab.id, { kind: 'link.proposed' })).filter((i) => i.flowId === c.id).length, 1);

      const confirmed = await confirmLink(db, lab.id, proposed.link.id, { actor });
      assert.equal(confirmed.state, 'active');
      assert.ok(confirmed.confirmedAt);
      assert.equal((await listReview(db, lab.id, { kind: 'link.proposed' })).filter((i) => i.flowId === c.id).length, 0);
      await assert.rejects(confirmLink(db, lab.id, proposed.link.id, { actor }), { code: 'conflict' });
    });

    test('an active name link without a person is refused by the database', async () => {
      const c = await contact();
      await assert.rejects(db.execute(sql`
        insert into external_links (organisation_id, entity, flow_id, system, external_id, matched_by, state)
        values (${lab.id}, 'contact', ${c.id}, 'accounting', ${ext()}, 'name', 'active')`));
    });

    test('exact evidence settles a proposed link', async () => {
      const c = await contact();
      const externalId = ext();
      await linkRecord(db, lab.id, { entity: 'contact', flowId: c.id, system: 'accounting', externalId, matchedBy: 'name' });
      const exact = await linkRecord(db, lab.id, {
        entity: 'contact', flowId: c.id, system: 'accounting', externalId, matchedBy: 'exact_id',
      });
      assert.equal(exact.outcome, 'linked');
      assert.equal((await listReview(db, lab.id, { kind: 'link.proposed' })).filter((i) => i.flowId === c.id).length, 0);
    });

    test('two callers that link one external record at once make one link', async () => {
      const a = await contact();
      const b = await contact();
      const externalId = ext();
      const results = await Promise.all([a, b].map((c) => linkRecord(db, lab.id, {
        entity: 'contact', flowId: c.id, system: 'accounting', externalId, matchedBy: 'exact_id',
      })));
      assert.deepEqual(results.map((r) => r.outcome).sort(), ['conflict', 'linked']);
    });

    test('a superseded link frees both sides', async () => {
      const c = await contact();
      const externalId = ext();
      const { link } = await linkRecord(db, lab.id, { entity: 'contact', flowId: c.id, system: 'accounting', externalId, matchedBy: 'exact_id' });
      await supersedeLink(db, lab.id, link.id);
      const next = await linkRecord(db, lab.id, { entity: 'contact', flowId: c.id, system: 'accounting', externalId: ext(), matchedBy: 'exact_id' });
      assert.equal(next.outcome, 'linked');
    });
  });

  describe('review queue', () => {
    test('a repeat finding updates one item', async () => {
      const flowId = randomUUID();
      const first = await openReview(db, lab.id, { kind: 'price.difference', entity: 'obligation', flowId, evidence: { a: 1 }, moneyAtRiskCents: 500 });
      const again = await openReview(db, lab.id, { kind: 'price.difference', entity: 'obligation', flowId, evidence: { a: 2 }, moneyAtRiskCents: 700 });
      assert.equal(again.id, first.id);
      assert.equal(again.seenCount, 2);
      assert.deepEqual(again.evidence, { a: 2 });
    });

    test('the queue puts most money at risk first, and a closed item records who chose what', async () => {
      const small = await openReview(db, otherLab.id, { kind: 'invoice.duplicate', entity: 'invoice', flowId: randomUUID(), moneyAtRiskCents: 100 });
      const large = await openReview(db, otherLab.id, { kind: 'invoice.duplicate', entity: 'invoice', flowId: randomUUID(), moneyAtRiskCents: 90000 });
      assert.deepEqual((await listReview(db, otherLab.id)).map((i) => i.id), [large.id, small.id]);

      const closed = await resolveReview(db, otherLab.id, large.id, { resolution: 'credit_duplicate', note: 'synthetic', actor });
      assert.equal(closed.state, 'resolved');
      assert.equal(closed.resolvedBy, actor);
      await assert.rejects(resolveReview(db, otherLab.id, large.id, { resolution: 'again', actor }), { code: 'conflict' });
      await assert.rejects(resolveReview(db, lab.id, small.id, { resolution: 'x', actor }), { code: 'not_found' });

      const reopened = await openReview(db, otherLab.id, { kind: 'invoice.duplicate', entity: 'invoice', flowId: large.flowId });
      assert.notEqual(reopened.id, large.id);
    });
  });

  describe('job queue', () => {
    test('one open job per kind and key', async () => {
      const first = await enqueueJob(db, lab.id, { kind: 'test.dedupe', dedupeKey: 'k' });
      const again = await enqueueJob(db, lab.id, { kind: 'test.dedupe', dedupeKey: 'k' });
      assert.equal(first.queued, true);
      assert.equal(again.queued, false);
      assert.equal(again.job.id, first.job.id);
    });

    test('two workers never claim the same job', async () => {
      for (let i = 0; i < 6; i++) await enqueueJob(db, lab.id, { kind: 'test.parallel', dedupeKey: String(i) });
      const [a, b] = await Promise.all([
        claimJobs(db, { workerId: 'a', kinds: ['test.parallel'], limit: 4 }),
        claimJobs(db, { workerId: 'b', kinds: ['test.parallel'], limit: 4 }),
      ]);
      const ids = [...a, ...b].map((j) => j.id);
      assert.equal(ids.length, 6);
      assert.equal(new Set(ids).size, 6);
    });

    test('a failed job waits longer each time, then gives up into the review queue', async () => {
      assert.equal(retryDelayMs(1), 60000);
      assert.equal(retryDelayMs(3), 240000);
      assert.equal(retryDelayMs(50), 6 * 60 * 60 * 1000);

      const { job } = await enqueueJob(db, lab.id, { kind: 'test.fail', maxAttempts: 2 });
      let [claimed] = await claimJobs(db, { workerId: 'w', kinds: ['test.fail'] });
      const retried = await failJob(db, claimed, { workerId: 'w', error: new Error('synthetic 500') });
      assert.equal(retried.state, 'queued');
      assert.ok(retried.runAfter > new Date());
      assert.deepEqual(await claimJobs(db, { workerId: 'w', kinds: ['test.fail'] }), []);

      await db.execute(sql`update background_jobs set run_after = now() where id = ${job.id}`);
      [claimed] = await claimJobs(db, { workerId: 'w', kinds: ['test.fail'] });
      const dead = await failJob(db, claimed, { workerId: 'w', error: 'synthetic 500 again' });
      assert.equal(dead.state, 'dead');
      const items = await listReview(db, lab.id, { kind: 'job.dead' });
      assert.ok(items.some((i) => i.flowId === job.id));
    });

    test('a lease that runs out lets another worker take over, and the first cannot finish', async () => {
      await enqueueJob(db, lab.id, { kind: 'test.lease' });
      const [first] = await claimJobs(db, { workerId: 'slow', kinds: ['test.lease'], leaseMs: 1000 });
      await db.execute(sql`update background_jobs set locked_until = now() - interval '1 second' where id = ${first.id}`);
      const [second] = await claimJobs(db, { workerId: 'fast', kinds: ['test.lease'] });
      assert.equal(second.id, first.id);
      assert.equal(second.attempts, 2);
      await assert.rejects(completeJob(db, first, { workerId: 'slow' }), { code: 'conflict' });
      const done = await completeJob(db, second, { workerId: 'fast', result: { ok: true } });
      assert.equal(done.state, 'succeeded');
    });

    test('runNextJob runs a handler and records its result', async () => {
      await enqueueJob(db, lab.id, { kind: 'test.run', payload: { n: 2 } });
      const ran = await runNextJob(db, { workerId: 'w', handlers: { 'test.run': async (job) => ({ doubled: job.payload.n * 2 }) } });
      assert.equal(ran.outcome, 'succeeded');
      assert.deepEqual(ran.job.result, { doubled: 4 });

      await enqueueJob(db, lab.id, { kind: 'test.refuse' });
      const refused = await runNextJob(db, {
        workerId: 'w',
        handlers: { 'test.refuse': async () => { throw Object.assign(new Error('synthetic refusal'), { retry: false }); } },
      });
      assert.equal(refused.outcome, 'dead');
      assert.equal(await runNextJob(db, { workerId: 'w', handlers: { 'test.none': async () => {} } }), null);
    });
  });

  describe('outbox', () => {
    const write = (flowId, overrides = {}) => ({
      system: 'accounting',
      action: 'invoice.draft',
      entity: 'invoice',
      flowId,
      idempotencyKey: `invoice:${flowId}:v1`,
      request: { total: 24200 },
      actor,
      ...overrides,
    });

    test('a write is queued once per key, and a key cannot serve another record', async () => {
      const flowId = randomUUID();
      const first = await queueWrite(db, lab.id, write(flowId));
      const again = await queueWrite(db, lab.id, write(flowId));
      assert.equal(first.queued, true);
      assert.equal(again.write.id, first.write.id);
      await assert.rejects(queueWrite(db, lab.id, write(randomUUID(), { idempotencyKey: first.write.idempotencyKey })), { code: 'conflict' });
    });

    test('a write rolls back with the Flow change it belongs to', async () => {
      const flowId = randomUUID();
      await assert.rejects(db.transaction(async (tx) => {
        await queueWrite(tx, lab.id, write(flowId, { system: 'rollback' }));
        throw new Error('the Flow change failed');
      }));
      assert.deepEqual(await claimWrites(db, { system: 'rollback' }), []);
    });

    test('a sent write links the Flow record to what the system made', async () => {
      const flowId = randomUUID();
      await queueWrite(db, lab.id, write(flowId, { system: 'sent-test' }));
      const [claimed] = await claimWrites(db, { system: 'sent-test' });
      assert.equal(claimed.state, 'sending');
      assert.deepEqual(await claimWrites(db, { system: 'sent-test' }), []);
      const externalId = ext();
      const { write: sent, link } = await markSent(db, lab.id, claimed.id, { externalId });
      assert.equal(sent.state, 'sent');
      assert.equal(link.outcome, 'linked');
      assert.equal(link.link.matchedBy, 'created_by_flow');
      assert.equal(await flowIdFor(db, lab.id, { system: 'sent-test', entity: 'invoice', externalId }), flowId);
      await assert.rejects(markSent(db, lab.id, claimed.id, { externalId }), { code: 'conflict' });
    });

    test('a send that never finished becomes ambiguous, not pending', async () => {
      const flowId = randomUUID();
      await queueWrite(db, lab.id, write(flowId, { system: 'stale-test' }));
      const [claimed] = await claimWrites(db, { system: 'stale-test' });
      await db.execute(sql`update outbox set updated_at = now() - interval '1 hour' where id = ${claimed.id}`);
      assert.deepEqual(await claimWrites(db, { system: 'stale-test' }), []);
      const [row] = (await db.execute(sql`select state from outbox where id = ${claimed.id}`)).rows;
      assert.equal(row.state, 'ambiguous');
    });

    test('an unknown outcome is settled by a lookup; a refusal opens a review item', async () => {
      const flowId = randomUUID();
      await queueWrite(db, lab.id, write(flowId, { system: 'fail-test' }));
      let [claimed] = await claimWrites(db, { system: 'fail-test' });
      await markAmbiguous(db, lab.id, claimed.id, { error: 'timeout' });
      const retry = await markFailed(db, lab.id, claimed.id, { error: 'lookup found nothing', retry: true });
      assert.equal(retry.state, 'pending');
      [claimed] = await claimWrites(db, { system: 'fail-test' });
      assert.equal(claimed.attempts, 2);
      const failed = await markFailed(db, lab.id, claimed.id, { error: 'synthetic 400: contact archived' });
      assert.equal(failed.state, 'failed');
      assert.ok((await listReview(db, lab.id, { kind: 'write.failed' })).some((i) => i.flowId === flowId));
      const cancelled = await cancelWrite(db, lab.id, claimed.id, { actor });
      assert.equal(cancelled.state, 'cancelled');
    });
  });
});
