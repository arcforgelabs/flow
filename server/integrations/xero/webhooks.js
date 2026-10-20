import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { isCallsStopped } from '../call-guard.js';
import { lastSync, parseXeroDate, syncCatalogue } from './catalogue.js';
import { withXeroLane } from './governor.js';
import { mirrorState } from './lookup.js';
import { mapRecords, mirrorXero, storeRows, toCents } from './mirror.js';
import { checkSentInvoices } from './reconcile.js';

// Xero's webhooks, and the daily check (issue #45). The poll (import.js) reads
// Xero's changes every 15 minutes. Webhooks make a change reach Flow in
// seconds, and the daily check finds what both of them missed.
//
//   1. Xero posts an event to /api/xero/webhooks: a record id and what
//      happened, never the record. Flow checks the signature, saves the id in
//      the inbox (xero_webhook_events) and answers 200 at once.
//   2. The worker reads the waiting invoices by id, up to 50 a call, into the
//      copy (mirror.js), then compares the sent invoices again (reconcile.js).
//      Credit notes are read as changes since the cursor; contacts refresh the
//      contacts and items copy.
//   3. While webhooks arrive, the poll waits an hour instead of 15 minutes. If
//      they stop, it goes back to 15 minutes by itself.
//   4. Once a day, one summary read of every invoice (about 1,000 a call)
//      finds each copy row whose status, amounts or change time differ from
//      Xero, and each row Xero no longer lists. Those go into the inbox and are
//      read by id like an event. This catches part payments that do not move
//      Xero's change time, and a webhook that never came.
//
// Every read goes through the call guard and the governor's sync lane, and
// leaves the mirror's reserve of the day's calls for drafts and people. Flow
// never writes to Xero here.

export const BY_ID_BATCH = 50;
// The poll's wait while webhooks arrive, and how recent the last one must be.
export const WEBHOOK_REFRESH_MS = 60 * 60 * 1000;
export const WEBHOOK_ACTIVE_MS = 24 * 60 * 60 * 1000;
export const DAILY_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
// A daily check that failed is tried again after this wait.
const DAILY_CHECK_RETRY_MS = 60 * 60 * 1000;
const SUMMARY_PAGE = 1000;
// At most this many records a day go back for a read by id (5 calls), so a
// check that finds the whole copy different cannot spend the day. The rest
// wait for the next day's check.
export const DAILY_FLAG_MAX = 250;
const MAX_SUMMARY_PAGES = 50;
// Contacts and items are read again at most this often for contact events.
const CONTACTS_EVERY_MS = 60 * 60 * 1000;

const CATEGORIES = { INVOICE: 'invoices', CREDITNOTE: 'credit_notes', CREDIT_NOTE: 'credit_notes', CONTACT: 'contacts' };

// Xero signs the raw body with HMAC-SHA256 and the webhook key, in base64
// (x-xero-signature). Compared in constant time.
export function signatureValid(key, rawBody, signature) {
  if (!key || typeof signature !== 'string' || !signature) return false;
  const expected = createHmac('sha256', key).update(rawBody).digest();
  let given;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Saves the events of one verified delivery. An event for an organisation not
// connected in this mode is dropped. Answers how many were saved.
export async function saveEvents(db, runtime, payload, { now = new Date() } = {}) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  if (!events.length) return 0;
  const { rows } = await db.execute(sql`select organisation_id, tenant_id from xero_connections where mode = ${runtime.settings.mode}`);
  const byTenant = new Map(rows.map((r) => [r.tenant_id, r.organisation_id]));
  let saved = 0;
  for (const event of events) {
    const organisationId = byTenant.get(event?.tenantId);
    if (!organisationId || typeof event.resourceId !== 'string' || !event.resourceId) continue;
    const resource = CATEGORIES[String(event.eventCategory ?? '').toUpperCase()] ?? 'other';
    const at = Date.parse(`${String(event.eventDateUtc ?? '').replace(/Z?$/, 'Z')}`);
    await flag(db, organisationId, resource, event.resourceId, {
      source: 'webhook', eventType: event.eventType ?? null, eventAt: Number.isNaN(at) ? null : new Date(at), now,
    });
    saved += 1;
  }
  return saved;
}

// Marks one record as waiting to be read by id.
async function flag(db, organisationId, resource, resourceId, { source, eventType = null, eventAt = null, now = new Date() }) {
  await db.execute(sql`
    insert into xero_webhook_events (organisation_id, resource, resource_id, event_type, source, event_at, received_at)
    values (${organisationId}, ${resource}, ${resourceId}, ${eventType}, ${source}, ${eventAt}, ${now})
    on conflict (organisation_id, resource, resource_id) do update set
      event_type = excluded.event_type, source = excluded.source, event_at = excluded.event_at,
      received_at = excluded.received_at, pending = true`);
}

async function markRead(db, organisationId, resource, ids = null) {
  const only = ids ? sql`and resource_id = any(${sql.param(ids)}::text[])` : sql``;
  await db.execute(sql`update xero_webhook_events set pending = false, read_at = now()
    where organisation_id = ${organisationId} and resource = ${resource} and pending ${only}`);
}

// Whether a webhook for this organisation arrived recently: the poll can wait.
export async function webhooksActive(db, runtime, organisationId, { now = Date.now() } = {}) {
  if (!runtime.settings.webhookKey) return false;
  const { rows: [row] } = await db.execute(sql`select max(received_at) as at from xero_webhook_events
    where organisation_id = ${organisationId} and source = 'webhook'`);
  return Boolean(row?.at && Number(now) - new Date(row.at).getTime() <= WEBHOOK_ACTIVE_MS);
}

// Calls left above the reserve the mirror keeps for drafts and people.
function overReserve(runtime, tenantId) {
  const budget = runtime.governor.status(tenantId);
  return budget.dayRemaining > Math.ceil(budget.dayLimit * runtime.settings.mirrorReserveFraction);
}

async function pendingIds(db, organisationId) {
  const { rows } = await db.execute(sql`select resource, resource_id from xero_webhook_events
    where organisation_id = ${organisationId} and pending order by received_at`);
  const out = new Map();
  for (const r of rows) out.set(r.resource, [...(out.get(r.resource) ?? []), r.resource_id]);
  return out;
}

// Reads every waiting record of one organisation. Answers counts, or a
// `stopped` reason: 'calls_stopped' (the call guard) or 'budget'.
export async function readInbox(db, runtime, organisationId, { now = Date.now } = {}) {
  const waiting = await pendingIds(db, organisationId);
  const result = { invoices: { read: 0, inserted: 0, changed: 0, unchanged: 0 }, creditNotes: 0, contacts: false, sent: null };
  if (!waiting.size) return result;
  const { rows: [connection] } = await db.execute(sql`select tenant_id from xero_connections
    where organisation_id = ${organisationId} and mode = ${runtime.settings.mode}`);
  if (!connection) return result;
  try {
    await runtime.guardFor(db).check(connection.tenant_id);
  } catch (error) {
    if (isCallsStopped(error)) return { ...result, stopped: 'calls_stopped' };
    throw error;
  }

  const invoiceIds = waiting.get('invoices') ?? [];
  if (invoiceIds.length) {
    const counts = result.invoices;
    const stopped = await runtime.serial(organisationId, () => withXeroLane('sync', async () => {
      const { client } = await runtime.clientFor(db, organisationId);
      for (let i = 0; i < invoiceIds.length; i += BY_ID_BATCH) {
        if (!overReserve(runtime, client.tenantId)) return 'budget';
        const batch = invoiceIds.slice(i, i + BY_ID_BATCH);
        const rows = mapRecords('invoices', await client.listInvoicesByIds(batch), runtime.settings);
        await db.transaction(async (tx) => {
          await storeRows(tx, organisationId, 'invoices', rows, counts);
          // An id Xero did not return is read too: there is nothing more to get.
          await markRead(tx, organisationId, 'invoices', batch);
        });
        counts.read += rows.length;
      }
      return null;
    }));
    if (stopped) return { ...result, stopped };
    if (counts.inserted || counts.changed) result.sent = await checkSentInvoices(db, runtime, organisationId);
  }

  if (waiting.get('credit_notes')?.length) {
    // Credit notes are few: one read of the changes since the cursor gets them.
    const [read] = await mirrorXero(db, runtime, organisationId, { resources: ['credit_notes'] });
    if (read?.stopped === 'budget') return { ...result, stopped: 'budget' };
    result.creditNotes = read?.read ?? 0;
    await markRead(db, organisationId, 'credit_notes');
  }

  if (waiting.get('contacts')?.length) {
    const last = await lastSync(db, organisationId);
    const at = last?.finishedAt ?? last?.startedAt;
    if (!at || Number(now()) - new Date(at).getTime() >= CONTACTS_EVERY_MS) {
      await syncCatalogue(db, runtime, organisationId);
      await markRead(db, organisationId, 'contacts');
      result.contacts = true;
    }
  }

  // Events Flow does not copy (other categories) need no read.
  if (waiting.get('other')?.length) await markRead(db, organisationId, 'other');
  return result;
}

// The daily check for one organisation: one summary read of every invoice,
// compared with the copy. Each row that differs, and each live copy row Xero
// no longer lists, waits in the inbox to be read by id. Answers counts, or
// `stopped`.
export async function dailyCheck(db, runtime, organisationId, { now = () => new Date() } = {}) {
  await db.execute(sql`insert into xero_daily_checks (organisation_id, last_started_at) values (${organisationId}, ${now()})
    on conflict (organisation_id) do update set last_started_at = excluded.last_started_at`);
  try {
    const seen = [];
    const stopped = await runtime.serial(organisationId, () => withXeroLane('sync', async () => {
      const { client } = await runtime.clientFor(db, organisationId);
      for (let page = 1; page <= MAX_SUMMARY_PAGES; page += 1) {
        if (!overReserve(runtime, client.tenantId)) return 'budget';
        const list = await client.listInvoiceSummaries({ page, pageSize: SUMMARY_PAGE });
        seen.push(...list.filter((i) => i.InvoiceID));
        if (list.length < SUMMARY_PAGE) return null;
      }
      return 'max_pages';
    }));
    if (stopped) {
      await db.execute(sql`update xero_daily_checks set last_error = ${stopped} where organisation_id = ${organisationId}`);
      return { read: seen.length, flagged: 0, stopped };
    }
    const { rows: copy } = await db.execute(sql`select xero_invoice_id, status, total_cents, amount_due_cents,
      amount_paid_cents, amount_credited_cents, xero_updated_at from xero_invoices where organisation_id = ${organisationId}`);
    const byId = new Map(copy.map((r) => [r.xero_invoice_id, r]));
    const flagged = new Set();
    for (const x of seen) {
      const row = byId.get(x.InvoiceID);
      byId.delete(x.InvoiceID);
      if (!row || summaryDiffers(row, x)) flagged.add(x.InvoiceID);
    }
    // A live copy row Xero no longer lists: read it by id to learn its state.
    for (const row of byId.values()) if (!['DELETED', 'VOIDED'].includes(row.status)) flagged.add(row.xero_invoice_id);
    const at = now();
    const list = [...flagged].slice(0, DAILY_FLAG_MAX);
    for (const id of list) await flag(db, organisationId, 'invoices', id, { source: 'daily_check', now: at });
    await db.execute(sql`update xero_daily_checks set last_finished_at = ${at}, last_read = ${seen.length},
      last_flagged = ${flagged.size}, last_error = null where organisation_id = ${organisationId}`);
    return { read: seen.length, flagged: flagged.size, queued: list.length, stopped: null };
  } catch (error) {
    await db.execute(sql`update xero_daily_checks set last_error = ${`${error.code ?? 'error'}: ${String(error.message).slice(0, 300)}`}
      where organisation_id = ${organisationId}`);
    throw error;
  }
}

const cents = (value) => (value === null || value === undefined ? null : Number(value));

// Whether a summary from Xero differs from the copy row in what the summary
// carries: status, money, and the change time.
export function summaryDiffers(row, summary) {
  if (row.status !== summary.Status) return true;
  for (const [column, field] of [['total_cents', 'Total'], ['amount_due_cents', 'AmountDue'], ['amount_paid_cents', 'AmountPaid'], ['amount_credited_cents', 'AmountCredited']]) {
    if (summary[field] !== undefined && cents(row[column]) !== toCents(summary[field])) return true;
  }
  // Xero changed it after the copy's version (whole seconds, as Xero compares).
  const changed = parseXeroDate(summary.UpdatedDateUTC);
  const copied = row.xero_updated_at ? new Date(row.xero_updated_at) : null;
  return Boolean(changed && (!copied || Math.floor(changed / 1000) > Math.floor(copied / 1000)));
}

// The organisations whose daily check is due: a complete copy, and no check
// finished in the last day (or none tried in the last hour after a failure).
export async function dueDailyChecks(db, runtime, { now = Date.now() } = {}) {
  const { rows } = await db.execute(sql`select c.organisation_id, c.tenant_id, d.last_started_at, d.last_finished_at
    from xero_connections c left join xero_daily_checks d on d.organisation_id = c.organisation_id
    where c.mode = ${runtime.settings.mode}`);
  const due = [];
  for (const r of rows) {
    const finished = r.last_finished_at ? new Date(r.last_finished_at).getTime() : null;
    const started = r.last_started_at ? new Date(r.last_started_at).getTime() : null;
    if (finished && Number(now) - finished < DAILY_CHECK_EVERY_MS) continue;
    if (started && (!finished || started > finished) && Number(now) - started < DAILY_CHECK_RETRY_MS) continue;
    if (!(await mirrorState(db, r.organisation_id, { now: new Date(Number(now)) })).complete) continue;
    due.push({ organisationId: r.organisation_id, tenantId: r.tenant_id });
  }
  return due;
}

// Read before act (issue #45, step 5): just before Flow drafts by rule or
// sends a batch, Xero's latest changes reach the copy. The copy counts as
// current when webhooks arrive and none waits, or when it read Xero's changes
// in the last READ_FIRST_MS. Otherwise this reads the waiting records and the
// invoice and credit note changes now: about two calls. Answers { state }:
//   fresh        no call was needed
//   read         the copy read Xero now; `changed` counts invoices that changed
//   unavailable  the read could not run (`reason`); act on nothing
export const READ_FIRST_MS = 10 * 60 * 1000;

export async function readChangesFirst(db, runtime, organisationId, { now = Date.now } = {}) {
  const { rows: [connection] } = await db.execute(sql`select tenant_id from xero_connections
    where organisation_id = ${organisationId} and mode = ${runtime.settings.mode}`);
  if (!connection) return { state: 'unavailable', reason: 'Xero is not connected' };
  const { rows: [{ waiting }] } = await db.execute(sql`select count(*)::int as waiting from xero_webhook_events
    where organisation_id = ${organisationId} and pending`);
  if (!waiting && await webhooksActive(db, runtime, organisationId, { now: Number(now()) })) return { state: 'fresh' };
  const { rows: [{ oldest }] } = await db.execute(sql`select min(last_read_at) as oldest from xero_mirror_cursors
    where organisation_id = ${organisationId} and resource in ('invoices', 'credit_notes')`);
  if (!waiting && oldest && Number(now()) - new Date(oldest).getTime() <= READ_FIRST_MS) return { state: 'fresh' };
  try {
    const inbox = await readInbox(db, runtime, organisationId, { now });
    if (inbox.stopped) return { state: 'unavailable', reason: inbox.stopped === 'budget' ? 'the day\'s Xero calls are kept for people' : 'Xero calls are stopped' };
    const reads = await mirrorXero(db, runtime, organisationId, { resources: ['invoices', 'credit_notes'], maxPages: 5 });
    const short = reads.find((r) => !['done', 'refused'].includes(r.stopped));
    if (short) return { state: 'unavailable', reason: short.stopped === 'budget' ? 'the day\'s Xero calls are kept for people' : 'Xero has more changes than one read takes' };
    const invoices = reads.find((r) => r.resource === 'invoices');
    const changed = inbox.invoices.inserted + inbox.invoices.changed + (invoices?.inserted ?? 0) + (invoices?.changed ?? 0);
    if (changed && !inbox.sent) await checkSentInvoices(db, runtime, organisationId);
    return { state: 'read', changed };
  } catch (error) {
    return { state: 'unavailable', reason: isCallsStopped(error) ? 'Xero calls are stopped' : `reading Xero failed (${error?.code ?? 'error'})` };
  }
}

// After a failed read, an organisation waits 1 minute, then 2, 4 and up to an
// hour, so a failing read is never tried every tick.
export const RETRY_FIRST_MS = 60 * 1000;
export const RETRY_MAX_MS = 60 * 60 * 1000;

// One worker step: reads each organisation's inbox, then runs any daily check
// that is due. A stop by the call guard skips that organisation quietly; the
// guard has reported it. A failure is logged once as an error; the same
// failure again is a warning. `holds` keeps each organisation's wait between
// steps.
export async function runWebhookWork(db, runtime, { log = console, now = Date.now, holds = new Map() } = {}) {
  const failed = (organisationId, what, error) => {
    const held = holds.get(organisationId);
    const failures = (held?.failures ?? 0) + 1;
    holds.set(organisationId, { failures, until: Number(now()) + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1)), code: error?.code ?? 'error' });
    const line = `[xero] ${what} for organisation ${organisationId} failed: ${error?.code ?? 'error'}`;
    if (held?.code === (error?.code ?? 'error')) log.warn?.(line);
    else log.error?.(line);
  };
  const waiting = (organisationId) => (holds.get(organisationId)?.until ?? 0) > Number(now());

  const { rows } = await db.execute(sql`select distinct e.organisation_id from xero_webhook_events e
    join xero_connections c on c.organisation_id = e.organisation_id and c.mode = ${runtime.settings.mode}
    where e.pending`);
  for (const { organisation_id: organisationId } of rows) {
    if (waiting(organisationId)) continue;
    try {
      const read = await readInbox(db, runtime, organisationId, { now });
      holds.delete(organisationId);
      if (read.invoices.read || read.creditNotes || read.contacts) {
        log.info?.(`[xero] read waiting changes for organisation ${organisationId}: ${read.invoices.read} invoices, ${read.creditNotes} credit notes${read.contacts ? ', contacts' : ''}`);
      }
    } catch (error) {
      if (!isCallsStopped(error)) failed(organisationId, 'reading waiting changes', error);
    }
  }
  for (const { organisationId, tenantId } of await dueDailyChecks(db, runtime, { now: now() })) {
    try {
      await runtime.guardFor(db).check(tenantId);
      const check = await dailyCheck(db, runtime, organisationId, { now: () => new Date(Number(now())) });
      log.info?.(`[xero] daily check for organisation ${organisationId}: ${check.read} invoices, ${check.flagged} to read again${check.stopped ? `; stopped (${check.stopped})` : ''}`);
    } catch (error) {
      // dueDailyChecks waits an hour after a failed check.
      if (!isCallsStopped(error)) log.error?.(`[xero] daily check for organisation ${organisationId} failed: ${error?.code ?? 'error'}`);
    }
  }
}
