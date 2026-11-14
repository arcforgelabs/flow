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
    where organisation_id = ${organisationId} and invoice_id = ${invoiceId} and released_at is null`);
  return links[0]?.xero_invoice_id ?? null;
}

// True when an earlier version of this Flow invoice went to another Xero
// invoice that was approved, paid or voided there, or emailed: a customer may
// have seen that version. Flow then keeps the invoice and its versions (it
// voids the invoice), though the newest Xero invoice was only a draft.
async function earlierVersionSeen(db, organisationId, invoiceId, xeroId) {
  const { rows } = await db.execute(sql`
    select 1 from xero_invoice_pushes p
    left join xero_invoices x on x.organisation_id = p.organisation_id and x.xero_invoice_id = p.xero_invoice_id
    where p.organisation_id = ${organisationId} and p.invoice_id = ${invoiceId}
      and p.xero_invoice_id is not null and p.xero_invoice_id <> ${xeroId}
      and (p.email_state = 'sent' or coalesce(x.status, p.xero_status) = any(${sql.param(['AUTHORISED', 'PAID', 'VOIDED'])}::text[]))
    limit 1`);
  return rows.length > 0;
}

// False only when this Flow invoice never reached Xero: no send was started
// (no push row, not even one in flight) and no link holds it. A released link
// was a wrong pair, so it does not count. The core then deletes it in Flow
// instead of voiding it.
export async function everInXero(db, organisationId, invoiceId) {
  const { rows } = await db.execute(sql`
    select exists (select 1 from xero_invoice_pushes where organisation_id = ${organisationId} and invoice_id = ${invoiceId})
      or exists (select 1 from xero_invoice_links where organisation_id = ${organisationId} and invoice_id = ${invoiceId} and released_at is null) as sent`);
  return rows[0]?.sent === true;
}

// The core is removing a Flow invoice no customer saw: its Xero draft was
// deleted, or it never reached Xero. Inside the core's transaction, its push
// and link rows go with it, a released link too. Each pair stays as a row in
// xero_invoice_link_history, with who made, released, deleted and removed
// it. Flow's copy keeps the Xero row, and the job's history keeps the Xero
// id. Answers { accountingRef }.
export async function forgetXeroInvoice(tx, organisationId, invoiceId, { actor = null, reason = 'removed' } = {}) {
  const accountingRef = await linkedXeroId(tx, organisationId, invoiceId);
  await tx.execute(sql`
    insert into xero_invoice_link_history (organisation_id, xero_invoice_id, invoice_id, invoice_number, matched_by, linked_by, linked_at,
      released_by, released_at, deleted_by, deleted_at, removed_by, reason)
    select l.organisation_id, l.xero_invoice_id, l.invoice_id, i.number, l.matched_by, l.linked_by, l.created_at,
      l.released_by, l.released_at, l.deleted_by, l.deleted_at, ${actor}, ${reason}
    from xero_invoice_links l join invoices i on i.organisation_id = l.organisation_id and i.id = l.invoice_id
    where l.organisation_id = ${organisationId} and l.invoice_id = ${invoiceId}
    union all
    select p.organisation_id, p.xero_invoice_id, p.invoice_id, i.number, 'sent', p.pushed_by::text, p.first_dispatched_at,
      null, null, p.deleted_by, p.deleted_at, ${actor}, ${reason}
    from xero_invoice_pushes p join invoices i on i.organisation_id = p.organisation_id and i.id = p.invoice_id
    where p.organisation_id = ${organisationId} and p.invoice_id = ${invoiceId}`);
  await tx.execute(sql`delete from xero_invoice_links where organisation_id = ${organisationId} and invoice_id = ${invoiceId}`);
  await tx.execute(sql`delete from xero_invoice_pushes where organisation_id = ${organisationId} and invoice_id = ${invoiceId}`);
  return { accountingRef };
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
  // An imported invoice is Xero's own record: Flow never deletes it there.
  // The core refuses first (requireOwn); this is the stop for a direct call.
  const { rows: [own] } = await db.execute(sql`select origin from invoices where organisation_id = ${organisationId} and id = ${invoiceId}`);
  if (own && own.origin !== 'flow') return { state: 'unavailable', status: null, message: 'This invoice came from Xero. Flow does not delete it there.' };
  const xeroId = await linkedXeroId(db, organisationId, invoiceId);
  if (!xeroId) return { state: 'unavailable', status: null };

  return runtime.serial(organisationId, async () => {
    const { client } = await runtime.clientFor(db, organisationId);
    const live = await readLive(client, xeroId);
    const status = live?.Status ?? null;
    // This Xero invoice was only a draft, but a customer may have seen an
    // earlier version: the core then voids the Flow invoice, never removes it.
    const seenBefore = async () => (await earlierVersionSeen(db, organisationId, invoiceId, xeroId) ? { customerSaw: true } : {});
    if (!live) {
      await recordDeletion(db, organisationId, invoiceId, xeroId, 'DELETED', actor);
      return { state: 'gone', status: null, ...(await seenBefore()) };
    }
    if (GONE.has(status)) {
      await recordDeletion(db, organisationId, invoiceId, xeroId, status, actor);
      // A void in Xero was approved first, so a customer may have seen it:
      // Flow voids its invoice too. A deleted one was only ever a draft.
      return status === 'VOIDED' ? { state: 'voided', status } : { state: 'gone', status, ...(await seenBefore()) };
    }
    if (APPROVED.has(status)) return { state: 'approved', status, message: APPROVED_MESSAGE };
    if (!DRAFTS.has(status)) return { state: 'unavailable', status };

    await runtime.assertEnvironment(client);
    const updated = await withXeroLane('writes', () => client.deleteInvoice(xeroId));
    if (updated?.Status !== 'DELETED') {
      throw xeroError('xero_uncertain', 'Xero did not confirm the invoice was deleted. Nothing was changed in Flow.', { status: 502 });
    }
    await recordDeletion(db, organisationId, invoiceId, xeroId, 'DELETED', actor);
    return { state: 'deleted', status: 'DELETED', ...(await seenBefore()) };
  });
}
