import express from 'express';
import { FlowError } from '../core/errors.js';

// Jobs board moves that belong to the work system (docs/JOB_BOARD_MOVES.md).
//
//   POST /api/work/moves { sourceSystem, sourceJobRef, toStatus }
//        a person moved a job to another stage: the work system answers what
//        happens. Seazona's API cannot change a stage, so it answers a
//        hand-off: what to do in Seazona, and how long Flow waits.
//   POST /api/work/moves/cancel { sourceSystem, sourceJobRef }   take back a waiting move
//   GET  /api/work/my-settings[?integration=]                    this person's own integration choices
//   PUT  /api/work/my-settings { integration, key, value }        change one
//
// A move of a Flow custom field never comes here: that is
// PUT /api/custom-fields/values, and it stays in Flow.
//
// `adapters(capability)` is the enabled, ready adapters that offer it.
const ERROR_STATUS = { not_found: 404, conflict: 409, not_supported: 409 };
const SYSTEM = /^[a-z][a-z0-9-]{1,31}$/;

export function createWorkMovesRouter({ adapters = () => [], personAuth, log = console }) {
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));
  const signedIn = [personAuth.requireSession];

  const handle = (fn) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (error) {
      if (!(error instanceof FlowError)) {
        log.error?.(`[work-moves] ${error.message}`);
        return res.status(500).json({ ok: false, code: 'internal', error: 'Something went wrong.' });
      }
      return res.status(ERROR_STATUS[error.code] ?? 400).json({ ok: false, code: error.code, error: error.message });
    }
  };

  // The enabled adapter `id` that offers `capability`.
  const adapterFor = (id, capability) => {
    if (typeof id !== 'string' || !SYSTEM.test(id)) throw new FlowError('invalid', 'name an integration');
    const adapter = adapters(capability).find((a) => a.id === id) ?? null;
    if (!adapter) throw new FlowError('not_supported', 'that integration is not on, or cannot do that');
    return adapter;
  };
  const jobRef = (raw) => {
    const ref = typeof raw === 'string' ? raw.trim() : '';
    if (!ref || ref.length > 200) throw new FlowError('invalid', 'sourceJobRef is required');
    return ref;
  };

  router.post('/moves', ...signedIn, handle(async (req, res) => {
    const adapter = adapterFor(req.body?.sourceSystem, 'moveWork');
    const move = await adapter.capabilities.moveWork({ sourceJobRef: jobRef(req.body?.sourceJobRef), toStatus: req.body?.toStatus, personId: req.person.id });
    res.json({ ok: true, move });
  }));

  router.post('/moves/cancel', ...signedIn, handle(async (req, res) => {
    const adapter = adapterFor(req.body?.sourceSystem, 'cancelMove');
    res.json({ ok: true, ...(await adapter.capabilities.cancelMove({ sourceJobRef: jobRef(req.body?.sourceJobRef) })) });
  }));

  router.get('/my-settings', ...signedIn, handle(async (req, res) => {
    const wanted = typeof req.query.integration === 'string' ? req.query.integration : null;
    const out = [];
    for (const adapter of adapters('personSettings')) {
      if (wanted && adapter.id !== wanted) continue;
      out.push({ integration: adapter.id, name: adapter.name, settings: await adapter.capabilities.personSettings({ personId: req.person.id }) });
    }
    res.json({ ok: true, integrations: out });
  }));

  router.put('/my-settings', ...signedIn, handle(async (req, res) => {
    const adapter = adapterFor(req.body?.integration, 'setPersonSetting');
    const settings = await adapter.capabilities.setPersonSetting({ personId: req.person.id, key: req.body?.key, value: req.body?.value });
    res.json({ ok: true, integration: adapter.id, settings });
  }));

  return router;
}
