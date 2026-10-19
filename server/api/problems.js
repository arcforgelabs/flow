import express from 'express';
import { FlowError } from '../core/errors.js';
import {
  buildLabel, createProblemReport, listErrors, listProblemReports, publicError, publicReport, setErrorStatus, setProblemReportStatus,
} from '../core/problems.js';
import { rateLimit } from '../rate-limit.js';

// Problems for signed-in people, mounted at /api/problems (docs/PROBLEMS.md).
//
//   POST  /reports              anyone signed in: report a problem
//   GET   /reports?status=      owner or admin: the reports, newest first
//   PATCH /reports/:id          owner or admin: { status: new | seen | closed }
//   GET   /errors?status=       owner or admin: the error log, latest first
//   PATCH /errors/:id           owner or admin: { status }
//
// A report carries what the person typed and the page they were on; the
// server adds who they are, their browser and the running build. Nothing is
// sent outside this installation.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_STATUS = { invalid: 400, not_found: 404 };

function sendError(res, error, log) {
  if (error instanceof FlowError) {
    return res.status(ERROR_STATUS[error.code] ?? 400).json({ ok: false, code: error.code, error: error.message });
  }
  log.error?.(`[problems] ${error.message}`);
  return res.status(500).json({ ok: false, code: 'internal', error: 'Something went wrong.' });
}

const handle = (log, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    sendError(res, error, log);
  }
};

export function createProblemsRouter({ db, personAuth, build = null, reportsPerMinute = 10, log = console }) {
  const router = express.Router();
  const { requireSession, requireRole } = personAuth;
  const triage = requireRole('owner', 'admin');
  router.use(requireSession, express.json({ limit: '16kb' }));
  router.param('id', (_req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ ok: false, code: 'not_found', error: 'not found' })));
  const statusOf = (req) => (typeof req.query.status === 'string' && req.query.status ? req.query.status : null);

  router.post('/reports', rateLimit({ limit: reportsPerMinute, windowMs: 60_000 }), handle(log, async (req, res) => {
    const report = await createProblemReport(db, {
      person: req.person,
      message: req.body?.message,
      page: req.body?.page,
      userAgent: req.get('user-agent'),
      build: buildLabel(build),
    });
    log.info?.(`[problems] ${req.person.id} reported a problem (${report.id})`);
    res.status(201).json({ ok: true, report: { id: report.id } });
  }));

  router.get('/reports', triage, handle(log, async (req, res) => {
    const { reports, counts } = await listProblemReports(db, { status: statusOf(req) });
    res.json({ ok: true, reports: reports.map(publicReport), counts });
  }));

  router.patch('/reports/:id', triage, handle(log, async (req, res) => {
    res.json({ ok: true, report: publicReport(await setProblemReportStatus(db, req.params.id, req.body?.status)) });
  }));

  router.get('/errors', triage, handle(log, async (req, res) => {
    const { errors, counts } = await listErrors(db, { status: statusOf(req) });
    res.json({ ok: true, errors: errors.map(publicError), counts });
  }));

  router.patch('/errors/:id', triage, handle(log, async (req, res) => {
    res.json({ ok: true, error: publicError(await setErrorStatus(db, req.params.id, req.body?.status)) });
  }));

  return router;
}
