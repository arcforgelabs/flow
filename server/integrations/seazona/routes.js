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
// None of these call Seazona.

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

export function createSeazonaRouter({ db, personAuth, settings, log = console }) {
  const router = express.Router();
  // Sign-in off: every route answers 503, as the Xero routes do.
  const signedIn = personAuth
    ? [personAuth.requireSession]
    : [(_req, res) => res.status(503).json({ ok: false, code: 'sign_in_not_configured', error: 'Sign-in is not configured on this installation (FLOW_AUTH is unset).' })];
  const run = personAuth ? [...signedIn, personAuth.requirePermission('integrations.run')] : signedIn;
  const actor = (req) => (req.person?.id ? `person:${req.person.id}` : 'person:unknown');
  const json = express.json({ limit: MAX_UPLOAD });
  const csv = express.text({ type: ['text/csv', 'text/plain', 'application/csv'], limit: MAX_UPLOAD });

  if (!db) {
    router.use((req, res) => res.status(503).json({ ok: false, code: 'no_database', error: 'Flow has no database' }));
    return router;
  }

  router.get('/history', ...signedIn, handle(log, async (req, res) => {
    res.json({ ok: true, history: await historySummary(db), backfill: await readBackfill(db), batches: await listBatches(db) });
  }));

  router.get('/history/columns', ...signedIn, (req, res) => res.json({ ok: true, profile: 'invoice_lines', columns: describeColumns() }));

  router.post('/history/batches', ...run, csv, json, handle(log, async (req, res) => {
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

  router.post('/history/batches/:id/reconcile', ...run, handle(log, async (req, res) => {
    res.json({ ok: true, batch: await reconcileBatch(db, req.params.id) });
  }));

  router.post('/history/batches/:id/decisions', ...run, json, handle(log, async (req, res) => {
    res.json({ ok: true, batch: await decideJobs(db, req.params.id, req.body?.decisions, { by: actor(req) }) });
  }));

  router.post('/history/batches/:id/apply', ...run, handle(log, async (req, res) => {
    const batch = await applyBatch(db, req.params.id, { by: actor(req) });
    log.info?.(`[seazona] history import: batch ${batch.id} applied by ${actor(req)}: ${batch.applied} new, ${batch.updated} updated`);
    res.json({ ok: true, batch });
  }));

  router.post('/history/batches/:id/cancel', ...run, handle(log, async (req, res) => {
    res.json({ ok: true, batch: await cancelBatch(db, req.params.id) });
  }));

  const organisation = async () => {
    const id = await soleOrganisation(db);
    if (!id) throw Object.assign(new FlowError('invalid', 'the installation needs exactly one organisation'), { status: 409 });
    return id;
  };

  router.post('/history/backfill', ...run, json, handle(log, async (req, res) => {
    const backfill = await startBackfill(db, { from: req.body?.from, through: req.body?.through ?? null, createdBy: actor(req), settings });
    log.info?.(`[seazona] history backfill from ${backfill.from} to ${backfill.through} started by ${actor(req)}`);
    res.status(201).json({ ok: true, backfill });
  }));

  router.post('/history/backfill/stop', ...run, handle(log, async (req, res) => {
    res.json({ ok: true, backfill: await stopBackfill(db) });
  }));

  router.get('/history/ledger', ...signedIn, handle(log, async (req, res) => {
    const { state = null, limit, offset } = req.query;
    res.json({ ok: true, ...(await listHistoryJobs(db, await organisation(), { state: state || null, limit, offset })) });
  }));

  router.post('/history/ledger/:obligationId/release', ...run, handle(log, async (req, res) => {
    const row = await releaseHistoryJob(db, await organisation(), req.params.obligationId, { actor: actor(req) });
    log.info?.(`[seazona] history import: job ${row.sourceJobRef} released by ${actor(req)}`);
    res.json({ ok: true, job: { id: row.id, holdState: row.holdState } });
  }));

  return router;
}
