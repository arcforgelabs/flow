import express from 'express';
import { ALERT_PAGES, alertForBrowser, alertsFor, dismissAlert } from '../core/alerts.js';
import { FlowError } from '../core/errors.js';
import { resolveOrganisation } from './invoicing.js';

// Quiet alerts for signed-in people (server/core/alerts.js, docs/ALERTS.md).
//
//   GET  /api/alerts?page=invoices[&organisationId=]   what needs this person on that page
//   POST /api/alerts/dismiss { key[, organisationId] }  hide one alert for this person
//
// `sources` maps each page to the functions that find its alerts.
export function createAlertsRouter({ db, personAuth, sources, log = console }) {
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));

  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (!(error instanceof FlowError)) {
        log.error?.(`[alerts] ${error.message}`);
        return res.status(500).json({ ok: false, code: 'internal', error: 'Something went wrong.' });
      }
      const status = { not_found: 404, organisation_required: 409 }[error.code] ?? 400;
      return res.status(status).json({ ok: false, code: error.code, error: error.message });
    }
  };

  router.get('/', personAuth.requireSession, handle(async (req, res) => {
    const page = typeof req.query.page === 'string' ? req.query.page : '';
    if (!ALERT_PAGES.includes(page)) throw new FlowError('invalid', `page must be one of ${ALERT_PAGES.join(', ')}`);
    const organisationId = await resolveOrganisation(db, req.query.organisationId);
    const alerts = await alertsFor(db, organisationId, req.person, { page, sources });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, alerts: alerts.map(alertForBrowser) });
  }));

  router.post('/dismiss', personAuth.requireSession, handle(async (req, res) => {
    const organisationId = await resolveOrganisation(db, req.body?.organisationId ?? req.query.organisationId);
    const result = await dismissAlert(db, organisationId, req.person, { key: req.body?.key, sources });
    res.json({ ok: true, ...result });
  }));

  return router;
}
