import { FlowError } from '../core/errors.js';

const ERROR_STATUS = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409 };

export function sendError(res, error, log, tag) {
  if (error instanceof FlowError) {
    return res.status(ERROR_STATUS[error.code] ?? 400).json({ ok: false, code: error.code, error: error.message });
  }
  log.error?.(`[${tag}] ${error.message}`);
  return res.status(500).json({ ok: false, code: 'internal', error: 'Something went wrong.' });
}

export function clientIp(req) {
  return req.ip || null;
}
