import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { FlowError } from '../../../core/errors.js';
import { listClients } from '../feed.js';
import { hashOf, parseSeazonaDate, text } from '../map.js';
import {
  seazonaClients,
  seazonaHistoryBatches,
  seazonaHistoryBatchJobs,
  seazonaHistoryJobs,
  seazonaHistoryRows,
  seazonaInvoices,
  seazonaOrders,
} from '../schema.js';
import { CsvError, parseCsv } from './csv.js';
import { detectColumns, groupJobs, INVOICE_LINE_COLUMNS, readRow } from './read.js';

// The history import (docs/SEAZONA.md, "History import"). A person uploads
// Seazona's CSV export; Flow stages it, reconciles each job with what it
// already holds, lets a person decide the jobs it cannot settle, and applies
// the batch into `seazona_history_jobs`. It reads and writes Flow's database
// only: no Seazona or Xero call, so no call guard applies. Nothing here
// overwrites the API copy: a difference is a finding, never a change.

export const PROFILE = 'invoice_lines';
export const MAX_ROWS = 200_000;
export const OUTCOMES = ['new', 'same', 'changed', 'needs_person'];
export const DECISIONS = ['import', 'skip'];
const CHUNK = 500;

const invalid = (message, details) => Object.assign(new FlowError('invalid', message, details), { status: 400 });
const conflict = (message) => Object.assign(new FlowError('conflict', message), { status: 409 });

function chunks(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const normaliseName = (name) => text(name).toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(pty|ltd|limited|proprietary)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

async function requireBatch(db, batchId) {
  const id = Number(batchId);
  if (!Number.isSafeInteger(id) || id < 1) throw invalid('batch id must be a number');
  const [batch] = await db.select().from(seazonaHistoryBatches).where(eq(seazonaHistoryBatches.id, id));
  if (!batch) throw Object.assign(new FlowError('not_found', 'import batch not found'), { status: 404 });
  return batch;
}

// Reads the file into a staged batch and reconciles it. The same file staged
// before (and not cancelled) answers that batch instead. `columns` maps a
// Flow field to a header when the guess is wrong (field -> header, or null).
export async function stageBatch(db, { csv, fileName = null, columns: override = {}, createdBy, keepPatientReference = false, maxRows = MAX_ROWS, now = Date.now }) {
  if (typeof csv !== 'string' || !csv.trim()) throw invalid('The upload is empty');
  if (!createdBy) throw invalid('createdBy is required');
  const fileSha256 = createHash('sha256').update(csv).digest('hex');
  const [earlier] = await db.select().from(seazonaHistoryBatches)
    .where(and(eq(seazonaHistoryBatches.fileSha256, fileSha256), sql`${seazonaHistoryBatches.status} <> 'cancelled'`))
    .orderBy(desc(seazonaHistoryBatches.id)).limit(1);
  if (earlier) return { ...(await summarise(db, earlier)), duplicate: true };

  let parsed;
  try {
    parsed = parseCsv(csv);
  } catch (error) {
    if (error instanceof CsvError) throw invalid(error.message, { line: error.line });
    throw error;
  }
  if (parsed.rows.length > maxRows) throw invalid(`The file has ${parsed.rows.length} rows; split it into files of at most ${maxRows}`);
  let detected;
  try {
    detected = detectColumns(parsed.headers, override);
  } catch (error) {
    throw invalid(error.message);
  }
  if (detected.missing.length) {
    throw invalid(`The file is missing columns Flow needs: ${detected.missing.join(', ')}`, { missing: detected.missing, headers: parsed.headers, columns: detected.columns });
  }

  const rows = parsed.rows.map((row, i) => ({ rowNumber: i + 1, line: row.line, ...readRow(row.cells, parsed.headers, detected.columns) }));
  const { jobs, rowKeys } = groupJobs(rows);
  const at = new Date(Number(now()));

  const batchId = await db.transaction(async (tx) => {
    const [batch] = await tx.insert(seazonaHistoryBatches).values({
      fileName: fileName ? String(fileName).slice(0, 200) : null,
      fileSha256,
      profile: PROFILE,
      columns: detected.columns,
      ignoredColumns: detected.ignored,
      status: 'staged',
      counts: {},
      createdBy: String(createdBy),
      createdAt: at,
    }).returning({ id: seazonaHistoryBatches.id });
    // The patient field groups rows; it is stored only when the installation
    // keeps a patient reference (SEAZONA_KEEP_PATIENT_REFERENCE).
    const keep = (value) => (keepPatientReference ? value : null);
    for (const part of chunks(rows)) {
      await tx.insert(seazonaHistoryRows).values(part.map((row) => ({
        batchId: batch.id,
        rowNumber: row.rowNumber,
        jobKey: rowKeys.get(row.rowNumber) ?? null,
        fields: { ...row.fields, patient: keep(row.fields.patient), line: row.line },
        problems: row.problems,
      })));
    }
    for (const part of chunks(jobs)) {
      await tx.insert(seazonaHistoryBatchJobs).values(part.map(({ jobKey, job, findings }) => {
        const stored = { ...job, patientReference: keep(job.patientReference) };
        return { batchId: batch.id, jobKey, job: { ...stored, fileFindings: findings }, recordHash: hashOf(stored) };
      }));
    }
    return batch.id;
  });
  return reconcileBatch(db, batchId, { now });
}

// Flow's copies that each job could be: the API mirror by number, else by
// practice, doctor, date and amount; and the Seazona client by account number
// or practice name.
async function loadEvidence(db, jobs) {
  const numbers = [...new Set(jobs.map((j) => j.job.invoiceNumber).filter(Boolean))];
  const cases = [...new Set(jobs.map((j) => j.job.caseRef).filter(Boolean))];
  const companies = [...new Set(jobs.filter((j) => !j.job.invoiceNumber && !j.job.caseRef).map((j) => text(j.job.company)))].filter(Boolean);
  const invoices = new Map();
  for (const part of chunks(numbers)) {
    for (const row of await db.select({ invoiceNumber: seazonaInvoices.invoiceNumber, totalCents: seazonaInvoices.totalCents, subtotalCents: seazonaInvoices.subtotalCents })
      .from(seazonaInvoices).where(inArray(seazonaInvoices.invoiceNumber, part))) invoices.set(row.invoiceNumber, row);
  }
  const ordersByInvoice = new Map();
  const ordersById = new Map();
  const orderColumns = { id: seazonaOrders.id, invoiceNumber: seazonaOrders.invoiceNumber, company: seazonaOrders.company, doctorName: seazonaOrders.doctorName, orderedText: seazonaOrders.orderedText, dueText: seazonaOrders.dueText, subtotalCents: seazonaOrders.subtotalCents };
  for (const part of chunks(numbers)) {
    for (const row of await db.select(orderColumns).from(seazonaOrders).where(inArray(seazonaOrders.invoiceNumber, part))) {
      if (!ordersByInvoice.has(row.invoiceNumber)) ordersByInvoice.set(row.invoiceNumber, []);
      ordersByInvoice.get(row.invoiceNumber).push(row);
    }
  }
  for (const part of chunks(cases)) {
    for (const row of await db.select(orderColumns).from(seazonaOrders).where(inArray(seazonaOrders.id, part))) ordersById.set(row.id, row);
  }
  const ordersByCompany = new Map();
  for (const part of chunks(companies.map((c) => c.toLowerCase()))) {
    for (const row of await db.select(orderColumns).from(seazonaOrders).where(inArray(sql`lower(trim(${seazonaOrders.company}))`, part))) {
      const key = normaliseName(row.company);
      if (!ordersByCompany.has(key)) ordersByCompany.set(key, []);
      ordersByCompany.get(key).push(row);
    }
  }
  const clients = await listClients(db);
  const clientsByName = new Map();
  for (const c of clients) {
    const key = normaliseName(c.name);
    if (!clientsByName.has(key)) clientsByName.set(key, new Set());
    clientsByName.get(key).add(c.id);
  }
  const accounts = new Map();
  for (const row of await db.select({ id: seazonaClients.id, accountNumber: seazonaClients.accountNumber }).from(seazonaClients)) {
    if (row.accountNumber) accounts.set(text(row.accountNumber).toLowerCase(), row.id);
  }
  const history = new Map();
  for (const part of chunks(jobs.map((j) => j.jobKey))) {
    for (const row of await db.select({ jobKey: seazonaHistoryJobs.jobKey, recordHash: seazonaHistoryJobs.recordHash })
      .from(seazonaHistoryJobs).where(inArray(seazonaHistoryJobs.jobKey, part))) history.set(row.jobKey, row.recordHash);
  }
  return { invoices, ordersByInvoice, ordersById, ordersByCompany, clientsByName, accounts, history };
}

// One job against the evidence. Answers the batch-job columns reconciliation
// owns: outcome, findings, mirror references and client.
export function reconcileJob({ jobKey, job, recordHash }, evidence) {
  const findings = [...(job.fileFindings ?? [])];
  let mirrorOrderId = null;
  let mirrorInvoiceNumber = null;
  let clientId = null;

  if (job.invoiceNumber || job.caseRef) {
    const invoice = job.invoiceNumber ? evidence.invoices.get(job.invoiceNumber) : null;
    const orders = job.caseRef
      ? [evidence.ordersById.get(job.caseRef)].filter(Boolean)
      : evidence.ordersByInvoice.get(job.invoiceNumber) ?? [];
    if (invoice) mirrorInvoiceNumber = invoice.invoiceNumber;
    if (orders.length === 1) mirrorOrderId = orders[0].id;
    else if (orders.length > 1) findings.push({ code: 'invoice_has_several_orders', blocking: false });
    const theirTotal = invoice?.totalCents ?? (orders.length === 1 ? orders[0].subtotalCents : null);
    if (theirTotal !== null && theirTotal !== undefined && ![job.totalCents, job.subtotalCents].includes(theirTotal)) {
      findings.push({ code: 'differs_from_api_copy', blocking: false });
    }
  } else {
    const day = job.jobDate ?? job.dueDate ?? job.shippedDate;
    const candidates = (evidence.ordersByCompany.get(normaliseName(job.company)) ?? []).filter((o) => (
      normaliseName(o.doctorName) === normaliseName(job.doctorName)
      && o.subtotalCents === job.subtotalCents
      && [parseSeazonaDate(o.dueText), parseSeazonaDate(o.orderedText)].includes(day)
    ));
    if (candidates.length === 1) {
      mirrorOrderId = candidates[0].id;
      mirrorInvoiceNumber = candidates[0].invoiceNumber ?? null;
    } else if (candidates.length > 1) {
      findings.push({ code: 'api_copy_ambiguous', blocking: true });
    }
  }

  const byAccount = job.accountNumber ? evidence.accounts.get(text(job.accountNumber).toLowerCase()) : null;
  const byName = [...(evidence.clientsByName.get(normaliseName(job.company)) ?? [])];
  if (byAccount) clientId = byAccount;
  else if (byName.length === 1) [clientId] = byName;
  else if (byName.length > 1) findings.push({ code: 'client_ambiguous', blocking: true });
  else findings.push({ code: 'client_unknown', blocking: false });

  const before = evidence.history.get(jobKey);
  let outcome;
  if (findings.some((f) => f.blocking)) outcome = 'needs_person';
  else if (before === recordHash) outcome = 'same';
  else if (before) {
    findings.push({ code: 'differs_from_earlier_import', blocking: true });
    outcome = 'changed';
  } else outcome = 'new';
  return { outcome, findings, mirrorOrderId, mirrorInvoiceNumber, clientId };
}

// Reconciles every job of a staged or reconciled batch with what Flow holds
// now. A person's decisions stay.
export async function reconcileBatch(db, batchId, { now = Date.now } = {}) {
  const batch = await requireBatch(db, batchId);
  if (!['staged', 'reconciled'].includes(batch.status)) throw conflict(`The batch is ${batch.status}`);
  const jobs = await db.select().from(seazonaHistoryBatchJobs).where(eq(seazonaHistoryBatchJobs.batchId, batch.id));
  const evidence = await loadEvidence(db, jobs);
  await db.transaction(async (tx) => {
    for (const job of jobs) {
      const result = reconcileJob(job, evidence);
      // A client a person picked stays.
      if (job.decision !== null && job.clientId) result.clientId = job.clientId;
      await tx.update(seazonaHistoryBatchJobs).set(result)
        .where(and(eq(seazonaHistoryBatchJobs.batchId, batch.id), eq(seazonaHistoryBatchJobs.jobKey, job.jobKey)));
    }
    await tx.update(seazonaHistoryBatches)
      .set({ status: 'reconciled', reconciledAt: new Date(Number(now())), counts: await countBatch(tx, batch.id) })
      .where(eq(seazonaHistoryBatches.id, batch.id));
  });
  return summarise(db, await requireBatch(db, batch.id));
}

// Whether apply writes the job: a person's choice, else only a new job.
const writes = (job) => job.decision === 'import' || (job.decision === null && job.outcome === 'new');

async function countBatch(db, batchId) {
  const [rows] = await db.select({
    rows: sql`count(*)::int`,
    rowsWithProblems: sql`count(*) filter (where jsonb_array_length(${seazonaHistoryRows.problems}) > 0)::int`,
  }).from(seazonaHistoryRows).where(eq(seazonaHistoryRows.batchId, batchId));
  const jobs = await db.select({ outcome: seazonaHistoryBatchJobs.outcome, decision: seazonaHistoryBatchJobs.decision, n: sql`count(*)::int` })
    .from(seazonaHistoryBatchJobs).where(eq(seazonaHistoryBatchJobs.batchId, batchId))
    .groupBy(seazonaHistoryBatchJobs.outcome, seazonaHistoryBatchJobs.decision);
  const counts = { rows: rows.rows, rowsWithProblems: rows.rowsWithProblems, jobs: 0, willImport: 0, waitingForPerson: 0, skipped: 0 };
  for (const o of OUTCOMES) counts[o] = 0;
  for (const g of jobs) {
    counts.jobs += g.n;
    if (g.outcome) counts[g.outcome] += g.n;
    if (writes(g)) counts.willImport += g.n;
    else if (g.decision === 'skip' || g.outcome === 'same') counts.skipped += g.n;
    else counts.waitingForPerson += g.n;
  }
  return counts;
}

async function summarise(db, batch) {
  return {
    id: batch.id,
    fileName: batch.fileName,
    profile: batch.profile,
    status: batch.status,
    columns: batch.columns,
    ignoredColumns: batch.ignoredColumns,
    counts: batch.counts && Object.keys(batch.counts).length ? batch.counts : await countBatch(db, batch.id),
    createdBy: batch.createdBy,
    createdAt: batch.createdAt?.toISOString() ?? null,
    reconciledAt: batch.reconciledAt?.toISOString() ?? null,
    appliedAt: batch.appliedAt?.toISOString() ?? null,
    appliedBy: batch.appliedBy,
  };
}

export async function listBatches(db, { limit = 50 } = {}) {
  const rows = await db.select().from(seazonaHistoryBatches).orderBy(desc(seazonaHistoryBatches.id)).limit(Math.min(200, limit));
  return Promise.all(rows.map((b) => summarise(db, b)));
}

// A batch with one page of its jobs (filter by outcome, or `waiting` for the
// jobs a person must decide) and the rows Flow could not read.
export async function readBatch(db, batchId, { outcome = null, limit = 100, offset = 0 } = {}) {
  const batch = await requireBatch(db, batchId);
  const filters = [eq(seazonaHistoryBatchJobs.batchId, batch.id)];
  if (outcome === 'waiting') filters.push(sql`${seazonaHistoryBatchJobs.decision} is null and ${seazonaHistoryBatchJobs.outcome} in ('needs_person', 'changed')`);
  else if (outcome) {
    if (!OUTCOMES.includes(outcome)) throw invalid(`outcome must be one of ${[...OUTCOMES, 'waiting'].join(', ')}`);
    filters.push(eq(seazonaHistoryBatchJobs.outcome, outcome));
  }
  const pageSize = Math.max(1, Math.min(500, Number(limit) || 100));
  const jobs = await db.select().from(seazonaHistoryBatchJobs).where(and(...filters))
    .orderBy(asc(seazonaHistoryBatchJobs.jobKey)).limit(pageSize).offset(Math.max(0, Number(offset) || 0));
  const problemRows = await db.select().from(seazonaHistoryRows)
    .where(and(eq(seazonaHistoryRows.batchId, batch.id), sql`jsonb_array_length(${seazonaHistoryRows.problems}) > 0`))
    .orderBy(asc(seazonaHistoryRows.rowNumber)).limit(200);
  return {
    ...(await summarise(db, batch)),
    jobs: jobs.map((j) => ({
      jobKey: j.jobKey,
      outcome: j.outcome,
      findings: j.findings,
      decision: j.decision,
      willImport: writes(j),
      mirrorOrderId: j.mirrorOrderId,
      mirrorInvoiceNumber: j.mirrorInvoiceNumber,
      clientId: j.clientId,
      job: { ...j.job, fileFindings: undefined },
    })),
    problemRows: problemRows.map((r) => ({ rowNumber: r.rowNumber, line: r.fields.line ?? null, problems: r.problems })),
  };
}

// A person's choices: { jobKey, decision: 'import' | 'skip' | null, clientId? }.
// A client id picks the Seazona client when the name matched several.
export async function decideJobs(db, batchId, decisions, { by, now = Date.now }) {
  const batch = await requireBatch(db, batchId);
  if (!['reconciled', 'running'].includes(batch.status)) throw conflict(`The batch is ${batch.status}`);
  if (!Array.isArray(decisions) || !decisions.length || decisions.length > 5000) throw invalid('decisions must list 1 to 5000 jobs');
  const at = new Date(Number(now()));
  let changed = 0;
  await db.transaction(async (tx) => {
    for (const d of decisions) {
      if (!d || typeof d.jobKey !== 'string') throw invalid('each decision needs a jobKey');
      if (d.decision !== null && !DECISIONS.includes(d.decision)) throw invalid(`decision must be ${DECISIONS.join(', ')} or null`);
      const patch = { decision: d.decision, decidedBy: d.decision === null ? null : String(by), decidedAt: d.decision === null ? null : at };
      if (d.clientId !== undefined) patch.clientId = d.clientId === null ? null : String(d.clientId);
      const rows = await tx.update(seazonaHistoryBatchJobs).set(patch)
        .where(and(eq(seazonaHistoryBatchJobs.batchId, batch.id), eq(seazonaHistoryBatchJobs.jobKey, d.jobKey)))
        .returning({ jobKey: seazonaHistoryBatchJobs.jobKey });
      if (!rows.length) throw invalid(`The batch has no job ${d.jobKey}`);
      changed += 1;
    }
    await tx.update(seazonaHistoryBatches).set({ counts: await countBatch(tx, batch.id) }).where(eq(seazonaHistoryBatches.id, batch.id));
  });
  return { changed, ...(await summarise(db, await requireBatch(db, batch.id))) };
}

// Writes batch jobs into Flow's history. Answers { applied, updated }: new
// jobs, and jobs an earlier batch wrote.
async function writeHistoryJobs(tx, batchId, jobs, at, { checkedAt = null } = {}) {
  let applied = 0;
  let updated = 0;
  for (const part of chunks(jobs)) {
    const values = part.map((j) => ({
      jobKey: j.jobKey,
      invoiceNumber: j.job.invoiceNumber ?? null,
      caseRef: j.job.caseRef ?? null,
      clientId: j.clientId,
      company: j.job.company ?? null,
      doctorName: j.job.doctorName ?? null,
      status: j.job.status ?? null,
      jobDate: j.job.jobDate ?? null,
      dueDate: j.job.dueDate ?? null,
      shippedDate: j.job.shippedDate ?? null,
      lines: j.job.lines ?? [],
      subtotalCents: j.job.subtotalCents ?? null,
      totalCents: j.job.totalCents ?? null,
      patientReference: j.job.patientReference ?? null,
      mirrorOrderId: j.mirrorOrderId,
      mirrorInvoiceNumber: j.mirrorInvoiceNumber,
      recordHash: j.recordHash,
      batchId,
      firstBatchId: batchId,
      firstImportedAt: at,
      lastCheckedAt: checkedAt, lastAttemptAt: null, lastReadError: null, deletedInSourceAt: null,
      lastChangedAt: at,
    }));
    const rows = await tx.insert(seazonaHistoryJobs).values(values).onConflictDoUpdate({
      target: seazonaHistoryJobs.jobKey,
      set: Object.fromEntries(['invoiceNumber', 'caseRef', 'clientId', 'company', 'doctorName', 'status', 'jobDate', 'dueDate', 'shippedDate', 'lines',
        'subtotalCents', 'totalCents', 'patientReference', 'mirrorOrderId', 'mirrorInvoiceNumber', 'recordHash', 'batchId', 'lastChangedAt', 'lastCheckedAt', 'lastAttemptAt', 'lastReadError', 'deletedInSourceAt']
        .map((field) => [field, sql.raw(`excluded."${seazonaHistoryJobs[field].name}"`)])),
    }).returning({ firstBatchId: seazonaHistoryJobs.firstBatchId });
    for (const row of rows) {
      if (row.firstBatchId === batchId) applied += 1;
      else updated += 1;
    }
  }
  return { applied, updated };
}

// Reconciles once more, then writes each job that apply writes into Flow's
// history. Jobs waiting for a person stay out; the batch can be applied only
// once. Answers the batch with `applied` and `updated` counts.
export async function applyBatch(db, batchId, { by, now = Date.now }) {
  await reconcileBatch(db, batchId, { now });
  const at = new Date(Number(now()));
  const result = await db.transaction(async (tx) => {
    // Locks the batch, so two applies never run at once.
    const [batch] = await tx.execute(sql`select status from seazona_history_batches where id = ${Number(batchId)} for update`).then((r) => r.rows);
    if (batch.status !== 'reconciled') throw conflict(`The batch is ${batch.status}`);
    const jobs = (await tx.select().from(seazonaHistoryBatchJobs).where(eq(seazonaHistoryBatchJobs.batchId, Number(batchId)))).filter(writes);
    const { applied, updated } = await writeHistoryJobs(tx, Number(batchId), jobs, at);
    await tx.update(seazonaHistoryBatches)
      .set({ status: 'applied', appliedAt: at, appliedBy: String(by), counts: { ...(await countBatch(tx, Number(batchId))), applied, updated } })
      .where(eq(seazonaHistoryBatches.id, Number(batchId)));
    return { applied, updated };
  });
  return { ...(await summarise(db, await requireBatch(db, batchId))), ...result };
}

// The API backfill (backfill.js) writes jobs as it reads them: each batch of
// mapped jobs is staged, reconciled, and the new ones written to history at
// once, so a long backfill keeps its progress. Jobs that need a person wait
// in the batch. Answers { staged, applied, waiting }.
export async function stageApiJobs(db, batchId, jobs, { at }) {
  if (!jobs.length) return { staged: 0, applied: 0, waiting: 0 };
  const rows = jobs.map(({ jobKey, job }) => ({ batchId, jobKey, job, recordHash: hashOf(job) }));
  await db.insert(seazonaHistoryBatchJobs).values(rows).onConflictDoUpdate({
    target: [seazonaHistoryBatchJobs.batchId, seazonaHistoryBatchJobs.jobKey],
    set: { job: sql`excluded.job`, recordHash: sql`excluded.record_hash` },
  });
  const staged = await db.select().from(seazonaHistoryBatchJobs).where(and(
    eq(seazonaHistoryBatchJobs.batchId, batchId),
    inArray(seazonaHistoryBatchJobs.jobKey, rows.map((r) => r.jobKey)),
  ));
  const evidence = await loadEvidence(db, staged);
  return db.transaction(async (tx) => {
    const ready = [];
    let waiting = 0;
    for (const job of staged) {
      const result = reconcileJob(job, evidence);
      await tx.update(seazonaHistoryBatchJobs).set(result)
        .where(and(eq(seazonaHistoryBatchJobs.batchId, batchId), eq(seazonaHistoryBatchJobs.jobKey, job.jobKey)));
      if (writes({ ...job, ...result })) ready.push({ ...job, ...result });
      else if (result.outcome !== 'same') waiting += 1;
    }
    const { applied, updated } = await writeHistoryJobs(tx, batchId, ready, at, { checkedAt: at });
    await tx.update(seazonaHistoryBatches).set({ counts: await countBatch(tx, batchId) }).where(eq(seazonaHistoryBatches.id, batchId));
    return { staged: staged.length, applied: applied + updated, waiting };
  });
}

export async function createApiBatch(db, { createdBy, from, through, at }) {
  const [batch] = await db.insert(seazonaHistoryBatches).values({
    fileName: `Seazona API orders ${from} to ${through}`,
    fileSha256: `api:${from}:${through}:${at.toISOString()}`,
    profile: 'api_orders',
    columns: {},
    ignoredColumns: [],
    status: 'running',
    counts: {},
    createdBy: String(createdBy),
    createdAt: at,
  }).returning();
  return batch;
}

// The backfill finished: the batch waits like an upload, for a person to
// decide what is left and apply it.
export async function finishApiBatch(db, batchId, { status = 'reconciled', at }) {
  await db.update(seazonaHistoryBatches).set({ status, reconciledAt: at, counts: await countBatch(db, batchId) })
    .where(eq(seazonaHistoryBatches.id, batchId));
}

export async function cancelBatch(db, batchId) {
  const batch = await requireBatch(db, batchId);
  if (!['staged', 'reconciled'].includes(batch.status)) throw conflict(`The batch is ${batch.status}`);
  await db.update(seazonaHistoryBatches).set({ status: 'cancelled' }).where(eq(seazonaHistoryBatches.id, batch.id));
  return summarise(db, await requireBatch(db, batch.id));
}

// The fields Flow reads from an export, with the headers it knows for each.
export function describeColumns() {
  return Object.entries(INVOICE_LINE_COLUMNS).map(([field, headers]) => ({ field, headers }));
}

// Past jobs since a cursor, oldest change first, shaped like the billing
// feed's ledger jobs and marked `historical`, so the core can keep them out
// of drafting and match them to their accounting invoices. A job the API
// copy also holds uses the same order id, so the two are one job.
export async function readHistoryWork(db, { cursor = null, limit = 200 } = {}) {
  let after = null;
  if (cursor) {
    try {
      after = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    } catch {
      throw new TypeError('Not a Seazona history cursor');
    }
  }
  const pageSize = Math.max(1, Math.min(1000, limit));
  const changedAt = sql`to_char(${seazonaHistoryJobs.lastChangedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const rows = await db.select({ job: seazonaHistoryJobs, changedAt })
    .from(seazonaHistoryJobs)
    .where(after ? sql`(${seazonaHistoryJobs.lastChangedAt}, ${seazonaHistoryJobs.jobKey}) > (${after.at}::timestamptz, ${after.key})` : undefined)
    .orderBy(seazonaHistoryJobs.lastChangedAt, seazonaHistoryJobs.jobKey)
    .limit(pageSize);
  const items = rows.map(({ job }) => historyWorkItem(job));
  const last = rows.at(-1);
  return {
    items,
    cursor: last ? Buffer.from(JSON.stringify({ at: last.changedAt, key: last.job.jobKey })).toString('base64url') : cursor,
    more: rows.length === pageSize,
  };
}

export function historyWorkItem(job) {
  const sourceJobRef = job.mirrorOrderId ?? job.caseRef ?? `history:${job.jobKey}`;
  return {
    source: 'seazona',
    historical: true,
    jobKey: job.jobKey,
    sourceId: sourceJobRef,
    clientId: job.clientId,
    company: job.company,
    ledgerJob: {
      sourceSystem: 'seazona',
      sourceJobRef,
      sourceInvoiceRef: job.invoiceNumber ?? job.mirrorInvoiceNumber ?? null,
      caseRef: job.caseRef ?? job.mirrorOrderId ?? null,
      practitioner: job.doctorName,
      shippedOn: job.shippedDate,
      jobDate: job.jobDate ?? job.dueDate ?? job.shippedDate,
      sourceStatus: job.deletedInSourceAt ? 'Deleted in Seazona' : job.status,
      lines: (job.lines ?? []).map((l) => ({
        itemCode: l.code ?? null,
        description: l.description,
        quantity: 1,
        unitAmountCents: l.amountCents ?? undefined,
        taxCode: typeof l.taxable === 'boolean' ? (l.taxable ? 'GST' : 'GST_FREE') : undefined,
      })),
      observedAt: (job.lastCheckedAt ?? job.lastChangedAt).toISOString(),
      actor: 'seazona:history_import',
    },
  };
}


// One short phrase for each finding, for the issue on a job card.
const ISSUE_PHRASE = {
  client_ambiguous: 'Seazona client is unclear',
  api_copy_ambiguous: 'Matches several Seazona orders',
  differs_from_earlier_import: 'Seazona history changed',
  differs_from_api_copy: 'Seazona history differs',
  invoice_has_several_orders: 'Invoice number is on several orders',
  client_unknown: 'Seazona client not found',
};
const waitingJobs = sql`${seazonaHistoryBatchJobs.decision} is null and ${seazonaHistoryBatchJobs.outcome} in ('needs_person', 'changed')
  and ${seazonaHistoryBatchJobs.batchId} in (select id from seazona_history_batches where status in ('staged', 'reconciled', 'running'))`;

// The history jobs a person must decide, as issues on the jobs they belong
// to (the port's jobIssues): { [order id]: [{ phrase, href }] }. Each opens
// the job in the Seazona integration's reconciliation; a decision there
// clears the issue, since it is read again for each board.
export async function historyJobIssues(db, refs) {
  const ids = [...new Set((refs ?? []).filter(Boolean).map(String))];
  if (!ids.length) return {};
  const rows = await db.select().from(seazonaHistoryBatchJobs).where(and(
    waitingJobs,
    sql`(${seazonaHistoryBatchJobs.mirrorOrderId} in ${ids} or ${seazonaHistoryBatchJobs.job}->>'caseRef' in ${ids})`,
  ));
  const issues = {};
  for (const row of rows) {
    const ref = ids.includes(row.mirrorOrderId) ? row.mirrorOrderId : row.job.caseRef;
    const code = (row.findings ?? []).find((f) => f.blocking)?.code ?? row.findings?.[0]?.code;
    (issues[ref] ??= []).push({
      integration: 'seazona',
      phrase: ISSUE_PHRASE[code] ?? 'Seazona history needs a check',
      href: `/integrations/seazona?batch=${row.batchId}&job=${encodeURIComponent(row.jobKey)}`,
    });
  }
  return issues;
}

// Totals for health and Settings.
export async function historySummary(db) {
  const [jobs] = await db.select({ jobs: sql`count(*)::int`, linked: sql`count(${seazonaHistoryJobs.mirrorOrderId})::int`, first: sql`min(coalesce(${seazonaHistoryJobs.jobDate}, ${seazonaHistoryJobs.dueDate}, ${seazonaHistoryJobs.shippedDate}))`, last: sql`max(coalesce(${seazonaHistoryJobs.jobDate}, ${seazonaHistoryJobs.dueDate}, ${seazonaHistoryJobs.shippedDate}))` })
    .from(seazonaHistoryJobs);
  const [batches] = await db.select({ open: sql`count(*) filter (where ${seazonaHistoryBatches.status} in ('staged', 'reconciled'))::int`, applied: sql`count(*) filter (where ${seazonaHistoryBatches.status} = 'applied')::int` })
    .from(seazonaHistoryBatches).where(gt(seazonaHistoryBatches.id, 0));
  const [waiting] = await db.select({ n: sql`count(*)::int` }).from(seazonaHistoryBatchJobs).where(waitingJobs);
  return { jobs: jobs.jobs, alsoInApiCopy: jobs.linked, firstJobDate: jobs.first, lastJobDate: jobs.last, openBatches: batches.open, appliedBatches: batches.applied, waitingForPerson: waiting.n };
}
