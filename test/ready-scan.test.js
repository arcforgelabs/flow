import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { runAutomations, saveAutomation } from '../server/core/automations.js';
import { observeJob } from '../server/core/ledger.js';
import { billingObligations } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// The ready-mark routine finds a shipped job however many jobs are still in
// work (server/core/automations.js). Synthetic data only.
describe('marking jobs ready from their work status', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  let practice;

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
    lab = await createOrganisation(db, { name: 'Example Lab' });
    practice = await createContact(db, lab.id, { kind: 'customer', name: 'Example Practice' });
    await createPriceItem(db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
  });

  after(async () => handle?.close());

  const job = (ref, sourceStatus) => observeJob(db, lab.id, {
    sourceSystem: 'worksystem', sourceJobRef: ref, caseRef: ref, sourceStatus,
    contactId: practice.id, shippedOn: '2026-10-17', jobDate: '2026-10-17', lines: [{ itemCode: 'CRN' }],
  });

  test('a shipped job is marked even behind more than a batch of jobs in work', async () => {
    const template = await job('IN-0', 'In production');
    // 600 more jobs in work, all older than the shipped one.
    await handle.pool.query(`
      insert into billing_obligations (organisation_id, source_system, source_job_ref, case_ref, contact_id, shipped_on, job_date,
        source_status, lines, line_fingerprint, source_totals, subtotal_cents, tax_cents, total_cents, mapping_complete, source_seen_at)
      select organisation_id, source_system, 'IN-' || n, 'IN-' || n, contact_id, shipped_on, job_date,
        source_status, lines, line_fingerprint, source_totals, subtotal_cents, tax_cents, total_cents, mapping_complete, source_seen_at
      from billing_obligations, generate_series(1, 600) n where id = $1`, [template.id]);
    const shipped = await job('SHIP-1', '  shipped ');
    await saveAutomation(db, lab.id, 'draft_when_ready', { enabled: false });
    const result = await runAutomations(db, lab.id, {});
    assert.deepEqual(result.mark_ready_from_work_status, { marked: 1 });
    const [row] = await db.select().from(billingObligations).where(eq(billingObligations.id, shipped.id));
    assert.ok(row.readyAt, 'the shipped job is ready');
  });
});
