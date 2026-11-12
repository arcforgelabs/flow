import express from 'express';
import { FlowError } from '../../core/errors.js';
import { listHistoryJobs, releaseHistoryJob } from '../../core/history.js';
import { soleOrganisation } from '../../core/pipeline.js';
import {
  applyBatch,
  cancelBatch,
  decideJobs,
  describeColumns,
  historySummary,
  listBatches,
  readBatch,
  reconcileBatch,
  stageBatch,
} from './history/index.js';
import { readBackfill, startBackfill, stopBackfill } from './history/backfill.js';

// The Seazona adapter's routes, mounted at /api/seazona (server/integrations/port.js).
// The history import (docs/SEAZONA.md, "History import"):
//
//   GET  /history                         any signed-in person: totals and batches
//   GET  /history/columns                 any signed-in person: the headers Flow reads
//   POST /history/batches                 owner or admin: upload a CSV export
//                                         (text/csv body, ?fileName=; or JSON
//                                         { csv, fileName, columns })
//   GET  /history/batches/:id?outcome=&limit=&offset=   any signed-in person
//   POST /history/batches/:id/reconcile   owner or admin: match again
//   POST /history/batches/:id/decisions   owner or admin: { decisions: [{ jobKey, decision, clientId? }] }
//   POST /history/batches/:id/apply       owner or admin: write the batch into Flow's history
//   POST /history/batches/:id/cancel      owner or admin
//   POST /history/backfill                owner or admin: { from, through? } reads
//                                         past orders from the Seazona API, a few a run
//   POST /history/backfill/stop           owner or admin
//   GET  /history/ledger?state=&limit=&offset=   any signed-in person: held
//                                         history jobs by accounting state
//                                         (state: one state, or needs_person)
//   POST /history/ledger/:obligationId/release   owner or admin: the job may draft
//
// None of these call Seazona, except one read:
//
//   GET  /api/<resource>[/<id>]?<query>   owner or admin: one GET to the
//                                         Seazona REST API, through Flow's
//                                         rate governor, answered as
//                                         { ok, data }. resource is invoices,
//                                         orders, clients, products or users.
//                                         It never writes to Seazona. It is how
//                                         an AI assistant reads Seazona with its
//                                         Flow key (docs/AGENT_ACCESS.md).

export const MAX_UPLOAD = '25mb';

function sendError(res, error, log) {
  const status = error instanceof FlowError ? (error.status ?? 400) : 500;
  if (status >= 500) log.error?.(`[seazona] history import: ${error.code ?? 'error'}: ${error.message}`);
  const body = { ok: false, code: error.code ?? 'seazona_failed', error: status === 500 ? 'Something went wrong with the import.' : error.message };
  if (error.details !== undefined) body.details = error.details;
  return res.status(status).json(body);
}

const handle = (log, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    sendError(res, error, log);
  }
};

const API_RESOURCES = ['invoices', 'orders', 'clients', 'products', 'users'];

// With "Hide patient details" on (SEAZONA_API_READ_HIDE_PATIENT), any field
// whose name says patient, note, file, prescription and the like is dropped
// from the read, at any depth. Off by default.
const PRIVATE_FIELD = /patient|note|comment|instruction|remark|file|attach|image|photo|prescri|shade|clinical|medical|birth|dob/i;
// The value is parsed JSON, so it has no cycles.
export function withoutPrivateFields(value) {
  if (Array.isArray(value)) return value.map(withoutPrivateFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_FIELD.test(key))
    .map(([key, item]) => [key, withoutPrivateFields(item)]));
}
// A list read must carry the filter Flow's own sync uses. Seazona answers a
// list without it with an error, and every error counts against the call
// guard that also protects Flow's sync, so Flow refuses it before the call.
const SEAZONA_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const LIST_FILTERS = {
  orders: { key: 'ordered', hint: 'ordered=2026-11-11T00:00:00 (one day)' },
  invoices: { key: 'lastModified', hint: 'lastModified=2026-11-01T00:00:00' },
  clients: { key: 'lastModified', hint: 'lastModified=2026-11-01T00:00:00' },
};
export function listQueryProblem(resource, query) {
  const filter = LIST_FILTERS[resource];
  if (filter && !SEAZONA_TIME.test(query[filter.key] ?? '')) return `A ${resource} list needs ${filter.hint}.`;
  for (const key of ['page', 'pageSize']) {
    if (key in query && !/^[1-9]\d{0,2}$/.test(query[key])) return `${key} must be a whole number from 1 to 999.`;
  }
  return null;
}
const API_PATH = new RegExp(`^/api/(${API_RESOURCES.join('|')})(?:/([A-Za-z0-9-]{1,64}))?/?$`);

// Reads through the route below share Seazona's minute with Flow's own sync
// (the rate governor allows 30 a minute). They get at most this many a
// minute, so an agent that reads in a loop never leaves the sync waiting.
export const API_READS_PER_MINUTE = 10;

export function createSeazonaRouter({
  db, personAuth, settings, read = null, hidePatientFields = () => false, log = console,
  apiReadsPerMinute = API_READS_PER_MINUTE, now = Date.now,
}) {
  const router = express.Router();
  const apiReads = [];
  // Sign-in off: every route answers 503, as the Xero routes do.
  const signedIn = personAuth
    ? [personAuth.requireSession]
    : [(_req, res) => res.status(503).json({ ok: false, code: 'sign_in_not_configured', error: 'Sign-in is not configured on this installation (FLOW_AUTH is unset).' })];
  const manager = personAuth ? [...signedIn, personAuth.requireRole('owner', 'admin')] : signedIn;
  const actor = (req) => (req.person?.id ? `person:${req.person.id}` : 'person:unknown');
  const json = express.json({ limit: MAX_UPLOAD });
  const csv = express.text({ type: ['text/csv', 'text/plain', 'application/csv'], limit: MAX_UPLOAD });

  if (!db) {
    router.use((req, res) => res.status(503).json({ ok: false, code: 'no_database', error: 'Flow has no database' }));
    return router;
  }

  // One read from the Seazona API (above). Only plain query values pass on.
  router.get(API_PATH, ...manager, handle(log, async (req, res) => {
    if (!read) throw Object.assign(new FlowError('seazona_off', 'Seazona is not connected'), { status: 503 });
    const [, resource, id] = API_PATH.exec(req.path);
    const query = {};
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) query[key] = value.slice(0, 200);
    }
    const problem = id ? null : listQueryProblem(resource, query);
    if (problem) return res.status(400).json({ ok: false, code: 'invalid', error: problem });
    const at = Number(now());
    while (apiReads.length && apiReads[0] <= at - 60_000) apiReads.shift();
    if (apiReads.length >= apiReadsPerMinute) {
      const waitSeconds = Math.max(1, Math.ceil((apiReads[0] + 60_000 - at) / 1000));
      res.set('Retry-After', String(waitSeconds));
      return res.status(429).json({
        ok: false, code: 'rate_limited',
        error: `At most ${apiReadsPerMinute} Seazona reads a minute go through here, so Flow's own sync keeps its share. Try again in ${waitSeconds} s.`,
      });
    }
    apiReads.push(at);
    try {
      const data = await read(id ? `${resource}/${id}` : `${resource}/`, query);
      log.info?.(`[seazona] api read ${resource}${id ? '/:id' : ''} by ${actor(req)}`);
      res.json({ ok: true, data: hidePatientFields() ? withoutPrivateFields(data) : data });
    } catch (error) {
      if (error?.name !== 'SeazonaApiError' && error?.name !== 'SeazonaCallsStopped') throw error;
      const status = error.statusCode === 404 ? 404 : error.statusCode === 400 ? 400 : error.name === 'SeazonaCallsStopped' || error.statusCode === 429 || error.kind === 'governor_timeout' ? 429 : 502;
      res.status(status).json({ ok: false, code: 'seazona_read_failed', error: error.message });
    }
  }));

  router.get('/history', ...signedIn, handle(log, async (req, res) => {
    res.json({ ok: true, history: await historySummary(db), backfill: await readBackfill(db), batches: await listBatches(db) });
  }));

  router.get('/history/columns', ...signedIn, (req, res) => res.json({ ok: true, profile: 'invoice_lines', columns: describeColumns() }));

  router.post('/history/batches', ...manager, csv, json, handle(log, async (req, res) => {
    const body = typeof req.body === 'string' ? { csv: req.body, fileName: req.query.fileName } : (req.body ?? {});
    const batch = await stageBatch(db, {
      csv: body.csv,
      fileName: body.fileName ?? null,
      columns: body.columns ?? {},
      createdBy: actor(req),
      keepPatientReference: Boolean(settings?.keepPatientReference),
    });
    log.info?.(`[seazona] history import: batch ${batch.id} ${batch.duplicate ? 'already staged' : 'staged'} by ${actor(req)}: ${JSON.stringify(batch.counts)}`);
    res.status(batch.duplicate ? 200 : 201).json({ ok: true, batch });
  }));

  router.get('/history/batches/:id', ...signedIn, handle(log, async (req, res) => {
    const { outcome = null, limit, offset } = req.query;
    res.json({ ok: true, batch: await readBatch(db, req.params.id, { outcome: outcome || null, limit, offset }) });
  }));

  router.post('/history/batches/:id/reconcile', ...manager, handle(log, async (req, res) => {
    res.json({ ok: true, batch: await reconcileBatch(db, req.params.id) });
  }));

  router.post('/history/batches/:id/decisions', ...manager, json, handle(log, async (req, res) => {
    res.json({ ok: true, batch: await decideJobs(db, req.params.id, req.body?.decisions, { by: actor(req) }) });
  }));

  router.post('/history/batches/:id/apply', ...manager, handle(log, async (req, res) => {
    const batch = await applyBatch(db, req.params.id, { by: actor(req) });
    log.info?.(`[seazona] history import: batch ${batch.id} applied by ${actor(req)}: ${batch.applied} new, ${batch.updated} updated`);
    res.json({ ok: true, batch });
  }));

  router.post('/history/batches/:id/cancel', ...manager, handle(log, async (req, res) => {
    res.json({ ok: true, batch: await cancelBatch(db, req.params.id) });
  }));

  const organisation = async () => {
    const id = await soleOrganisation(db);
    if (!id) throw Object.assign(new FlowError('invalid', 'the installation needs exactly one organisation'), { status: 409 });
    return id;
  };

  router.post('/history/backfill', ...manager, json, handle(log, async (req, res) => {
    const backfill = await startBackfill(db, { from: req.body?.from, through: req.body?.through ?? null, createdBy: actor(req), settings });
    log.info?.(`[seazona] history backfill from ${backfill.from} to ${backfill.through} started by ${actor(req)}`);
    res.status(201).json({ ok: true, backfill });
  }));

  router.post('/history/backfill/stop', ...manager, handle(log, async (req, res) => {
    res.json({ ok: true, backfill: await stopBackfill(db) });
  }));

  router.get('/history/ledger', ...signedIn, handle(log, async (req, res) => {
    const { state = null, limit, offset } = req.query;
    res.json({ ok: true, ...(await listHistoryJobs(db, await organisation(), { state: state || null, limit, offset })) });
  }));

  router.post('/history/ledger/:obligationId/release', ...manager, handle(log, async (req, res) => {
    const row = await releaseHistoryJob(db, await organisation(), req.params.obligationId, { actor: actor(req) });
    log.info?.(`[seazona] history import: job ${row.sourceJobRef} released by ${actor(req)}`);
    res.json({ ok: true, job: { id: row.id, holdState: row.holdState } });
  }));

  return router;
}
