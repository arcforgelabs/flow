import express from 'express';
import { CAPTURE_SETTINGS, captureMonthCost, captureReaderEnabled } from '../core/capture-settings.js';
import { saveSettings } from '../integrations/setup.js';
import { resolveOrganisation } from './invoicing.js';
import { FlowError } from '../core/errors.js';

export function createCaptureSettingsRouter({ db, personAuth, storage, reader }) {
  const router = express.Router();
  const describe = async (req) => ({
    enabled: await captureReaderEnabled(db),
    storageReady: Boolean(storage), readerReady: Boolean(reader?.on),
    cost: await captureMonthCost(db, await resolveOrganisation(db, req.query.organisationId)),
  });
  const handle = (fn) => async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { await fn(req, res); } catch (error) {
      if (error instanceof FlowError) return res.status(400).json({ ok: false, error: error.message });
      next(error);
    }
  };
  router.get('/', personAuth.requireSession, personAuth.requireRole('owner'), handle(async (req, res) => {
    res.json({ ok: true, settings: await describe(req) });
  }));
  router.put('/', personAuth.requireSession, personAuth.requireOwner, express.json({ limit: '1kb' }), handle(async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw new FlowError('invalid', 'enabled must be true or false');
    await resolveOrganisation(db, req.query.organisationId);
    await saveSettings(db, { adapter: CAPTURE_SETTINGS, actor: req.person.id, values: { CAPTURE_READER: req.body.enabled ? 'on' : 'off' } });
    res.json({ ok: true, settings: await describe(req) });
  }));
  return router;
}
