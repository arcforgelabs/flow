import { and, eq, sql } from 'drizzle-orm';
import { recordAccountingEvidence } from '../../core/ledger.js';
import { billingObligations } from '../../db/schema.js';
import { xeroError } from './client.js';
import { readConnection } from './connections.js';
import { withXeroLane } from './governor.js';
import { ledgerState } from './ledger.js';
import { writesAllowed } from './settings.js';

// Delete the Xero draft behind an issued Flow invoice (docs/XERO.md).
// The core calls this through the port (`deleteInvoice`) and voids in Flow
// only after the answer is `deleted` or `gone`. This file is the only place
// that knows Xero's statuses.
//
// Read first, then write. DRAFT and SUBMITTED are set to DELETED. DELETED
// and VOIDED need no write. AUTHORISED and PAID are refused, and nothing is
// written. A timeout or a 5xx throws, so Flow stays as it was; the next try
// reads again and does not repeat a delete Xero already made.

const DRAFTS = new Set(['DRAFT', 'SUBMITTED']);
const GONE = new Set(['DELETED', 'VOIDED']);
const APPROVED = new Set(['AUTHORISED', 'PAID']);
export const APPROVED_MESSAGE = 'Approved in Xero. Void it in Xero first.';

async function linkedXeroId(db, organisationId, invoiceId) {
  const { rows: pushes } = await db.execute(sql`
    select xero_invoice_id from xero_invoice_pushes
    where organisation_id = ${organisationId} and invoice_id = ${invoiceId} and xero_invoice_id is not null
    order by version desc limit 1`);
  if (pushes[0]?.xero_invoice_id) return pushes[0].xero_invoice_id;
  const { rows: links } = await db.execute(sql`
    select xero_invoice_id from xero_invoice_links
    where organisation_id = ${organisationId} and invoice_id = ${invoiceId}`);
  return links[0]?.xero_invoice_id ?? null;
}

// Who deleted it, and the status Xero confirmed, on the push, the link and
// Flow's copy. The ledger records deleted or voided so the job is not treated
// as still drafted.
async function recordDeletion(db, organisationId, invoiceId, xeroId, status, actor) {
  await db.execute(sql`
    update xero_invoice_pushes set
      xero_status = ${status}, deleted_by = ${actor}, deleted_at = now(), updated_at = now()
    where organisation_id = ${organisationId} and invoice_id = ${invoiceId} and xero_invoice_id = ${xeroId}`);
  await db.execute(sql`
    update xero_invoice_links set deleted_by = ${actor}, deleted_at = now()
    where organisation_id = ${organisationId} and invoice_id = ${invoiceId}`);
  // A new hash, so the next read of Xero replaces this row with what Xero says.
  await db.execute(sql`
    update xero_invoices set status = ${status}, record_hash = ${`flow-delete:${status}:${Date.now()}`}, last_changed_at = now()
    where organisation_id = ${organisationId} and xero_invoice_id = ${xeroId}`);
  const state = ledgerState({ Status: status });
  if (!state || !actor) return;
  const jobs = await db.select({ id: billingObligations.id }).from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.invoiceId, invoiceId)));
  for (const job of jobs) {
    await recordAccountingEvidence(db, organisationId, job.id, {
      state, accountingRef: xeroId, matchedBy: 'flow_invoice', actor, checkedAt: new Date().toISOString(),
    });
  }
}

async function readLive(client, xeroId) {
  try {
    return await withXeroLane('reads', () => client.getInvoice(xeroId));
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function deleteXeroInvoice(db, runtime, { organisationId, invoiceId, actor = null }) {
  // Writes off: no call at all. The core says so with the Send gate's message
  // before it gets here; this is the same stop for a direct call.
  if (!writesAllowed(runtime.settings)) return { state: 'unavailable', status: null };
  const connection = await readConnection(db, organisationId);
  if (!connection || connection.mode !== runtime.settings.mode) return { state: 'unavailable', status: null };
  const xeroId = await linkedXeroId(db, organisationId, invoiceId);
  if (!xeroId) return { state: 'unavailable', status: null };

  return runtime.serial(organisationId, async () => {
    const { client } = await runtime.clientFor(db, organisationId);
    const live = await readLive(client, xeroId);
    const status = live?.Status ?? null;
    if (!live) {
      await recordDeletion(db, organisationId, invoiceId, xeroId, 'DELETED', actor);
      return { state: 'gone', status: null };
    }
    if (GONE.has(status)) {
      await recordDeletion(db, organisationId, invoiceId, xeroId, status, actor);
      return { state: 'gone', status };
    }
    if (APPROVED.has(status)) return { state: 'approved', status, message: APPROVED_MESSAGE };
    if (!DRAFTS.has(status)) return { state: 'unavailable', status };

    await runtime.assertEnvironment(client);
    const updated = await withXeroLane('writes', () => client.deleteInvoice(xeroId));
    if (updated?.Status !== 'DELETED') {
      throw xeroError('xero_uncertain', 'Xero did not confirm the invoice was deleted. Nothing was changed in Flow.', { status: 502 });
    }
    await recordDeletion(db, organisationId, invoiceId, xeroId, 'DELETED', actor);
    return { state: 'deleted', status: 'DELETED' };
  });
}
