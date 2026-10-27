import express from 'express';
import {
  MAX_PHOTO_BYTES, captureView, decideCapture, readCapture, readCapturePhoto, typeProposal, uploadCapture,
} from '../core/captures.js';
import { FlowError } from '../core/errors.js';
import { resolveOrganisation } from './invoicing.js';

// Photo capture (server/core/captures.js). No model call. A signed-in person
// uploads one photo; Flow stores it and answers a capture in state `ready`
// with an empty proposal. The signed link is how the photo is read back.
// Logs from this router are a capture id and an error code, never the photo
// or the fields someone typed.

const ERROR_STATUS = {
  not_found: 404,
  conflict: 409,
  organisation_required: 409,
  unsupported_media: 415,
  photo_too_large: 413,
  link_invalid: 403,
  link_expired: 403,
  storage_unavailable: 503,
};

function respond(res, error) {
  return res.status(ERROR_STATUS[error.code] ?? 400).json({ ok: false, code: error.code, error: error.message });
}

export function createCapturesRouter({ db, storage, personAuth, log = console, publicOrigin = null }) {
  const router = express.Router();
  const signedIn = [personAuth.requireSession];

  const handle = (fn) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (error) {
      if (!(error instanceof FlowError)) {
        log.error?.('[captures] - error');
        return res.status(500).json({ ok: false, code: 'internal', error: 'Something went wrong.' });
      }
      if (error.code === 'hash_mismatch' || error.code === 'storage_unavailable') {
        log.error?.(`[captures] ${error.captureId ?? '-'} ${error.code}`);
      }
      if (error.code === 'hash_mismatch') {
        return res.status(404).json({ ok: false, code: 'not_found', error: 'photo not found' });
      }
      return respond(res, error);
    }
  };

  const origin = (req) => {
    const configured = String(publicOrigin ?? '').trim().replace(/\/$/, '');
    if (configured) return configured;
    return `${req.protocol}://${req.get('host')}`;
  };
  const organisationOf = (req) => resolveOrganisation(db, req.body?.organisationId ?? req.query.organisationId);

  router.get('/file', handle(async (req, res) => {
    const photo = await readCapturePhoto(db, storage, req.query.token);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', photo.contentType);
    res.end(photo.body);
  }));

  router.post('/', ...signedIn, express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }), handle(async (req, res) => {
    const organisationId = await organisationOf(req);
    const result = await uploadCapture(db, storage, organisationId, {
      bytes: typeof req.body === 'string' || Array.isArray(req.body) || !Buffer.isBuffer(req.body) ? Buffer.alloc(0) : req.body,
      contentType: req.get('content-type'),
      idempotencyKey: req.get('idempotency-key'),
      source: req.get('x-flow-capture-source') ?? req.query.source,
      personId: req.person.id,
      baseUrl: origin(req),
    });
    res.status(result.created ? 201 : 200).json({ ok: true, capture: captureView(result.capture, result.link) });
  }));

  router.use(express.json({ limit: '32kb' }));

  router.get('/:id', ...signedIn, handle(async (req, res) => {
    const result = await readCapture(db, storage, await organisationOf(req), req.params.id, origin(req));
    res.json({ ok: true, capture: captureView(result.capture, result.link) });
  }));

  router.post('/:id/proposal', ...signedIn, handle(async (req, res) => {
    const result = await typeProposal(db, storage, await organisationOf(req), req.params.id, req.body, { baseUrl: origin(req) });
    res.json({ ok: true, capture: captureView(result.capture, result.link) });
  }));

  router.post('/:id/decision', ...signedIn, handle(async (req, res) => {
    const result = await decideCapture(db, storage, await organisationOf(req), req.params.id, req.body?.decision, {
      personId: req.person.id,
      baseUrl: origin(req),
    });
    res.json({ ok: true, capture: captureView(result.capture, result.link) });
  }));

  router.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large' || error?.status === 413) {
      return respond(res, new FlowError('photo_too_large', 'photo is too large'));
    }
    if (error instanceof FlowError) return respond(res, error);
    return next(error);
  });

  return router;
}
