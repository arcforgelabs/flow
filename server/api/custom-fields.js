import express from 'express';
import {
  CUSTOM_FIELD_TYPES, GROUPABLE_TYPES, OPTION_COLORS, archiveField, choosablePeople, createField, ensureAssignee, jobFieldHistory, listFields,
  listJobFieldValues, orderFields, setJobFieldValue, updateField,
} from '../core/custom-fields.js';
import { FlowError } from '../core/errors.js';
import { resolveOrganisation } from './invoicing.js';

// Custom fields for jobs (server/core/custom-fields.js, docs/CUSTOM_FIELDS.md).
//
//   GET  /api/custom-fields[?archived=1]          the lab's fields, the work systems' own fields (read only),
//        and the people a person field can name
//   POST /api/custom-fields { name, type[, options] }        owner or admin: make a field
//   PUT  /api/custom-fields/order { ids }                   owner or admin: the field order
//   PUT  /api/custom-fields/:id { name?, options? }         owner or admin: rename, change options
//   POST /api/custom-fields/:id/archive { archived }        owner or admin: archive or bring back
//   GET  /api/custom-fields/values                          every job's values
//   PUT  /api/custom-fields/values { sourceSystem, sourceJobRef, fieldId, value[, expectedUpdatedAt] }
//        set one job's value; a stale expectedUpdatedAt gives 409 with the current value
//   GET  /api/custom-fields/history?sourceSystem=&sourceJobRef=   one job's changes, newest first
//
// Every route also takes `organisationId` (query or body) when the
// installation has more than one organisation. A value lives only in Flow:
// no route here writes to an integration.
//
// `work()` is the work system adapters that offer listWork; their job
// statuses show as a read-only Stage field.
const ERROR_STATUS = { not_found: 404, conflict: 409, organisation_required: 409 };

export function createCustomFieldsRouter({ db, personAuth, work = () => [], log = console }) {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  const signedIn = [personAuth.requireSession];
  const manager = [...signedIn, personAuth.requireRole('owner', 'admin')];

  const handle = (fn) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (error) {
      if (!(error instanceof FlowError)) {
        log.error?.(`[custom-fields] ${error.message}`);
        return res.status(500).json({ ok: false, code: 'internal', error: 'Something went wrong.' });
      }
      const body = { ok: false, code: error.code, error: error.message };
      if (error.details !== undefined) body.details = error.details;
      return res.status(ERROR_STATUS[error.code] ?? 400).json(body);
    }
  };
  const organisationOf = (req) => resolveOrganisation(db, req.body?.organisationId ?? req.query.organisationId);

  // The work systems' own fields: their job statuses, as the Stage lanes on
  // the Jobs board. Read from Flow's copy; a work system that fails to answer
  // is left out, not an error.
  async function systemFields() {
    const fields = [];
    for (const adapter of work()) {
      try {
        const { statuses = [] } = await adapter.capabilities.listWork();
        fields.push({
          id: `${adapter.id}:stage`, source: adapter.id, sourceLabel: adapter.name ?? adapter.id, name: 'Stage',
          type: 'dropdown', readOnly: true, options: statuses.map((s) => ({ id: s.label, name: s.label, final: Boolean(s.final) })),
        });
      } catch (error) {
        log.warn?.(`[custom-fields] ${adapter.id} stages: ${error.message}`);
      }
    }
    return fields;
  }

  router.get('/', ...signedIn, handle(async (req, res) => {
    const organisationId = await organisationOf(req);
    const archived = req.query.archived === '1' || req.query.archived === 'true';
    await ensureAssignee(db, organisationId);
    const [fields, system, chosen] = await Promise.all([listFields(db, organisationId, { archived }), systemFields(), choosablePeople(db)]);
    res.json({ ok: true, fields, systemFields: system, people: chosen, types: CUSTOM_FIELD_TYPES, groupable: GROUPABLE_TYPES, colors: OPTION_COLORS });
  }));

  router.post('/', ...manager, handle(async (req, res) => {
    const field = await createField(db, await organisationOf(req), req.body, { personId: req.person.id });
    res.status(201).json({ ok: true, field });
  }));

  router.put('/order', ...manager, handle(async (req, res) => {
    const fields = await orderFields(db, await organisationOf(req), req.body?.ids, { personId: req.person.id });
    res.json({ ok: true, fields });
  }));

  router.get('/values', ...signedIn, handle(async (req, res) => {
    res.json({ ok: true, values: await listJobFieldValues(db, await organisationOf(req)) });
  }));

  router.put('/values', ...signedIn, handle(async (req, res) => {
    const value = await setJobFieldValue(db, await organisationOf(req), req.body, { personId: req.person.id });
    res.json({ ok: true, value });
  }));

  router.get('/history', ...signedIn, handle(async (req, res) => {
    const history = await jobFieldHistory(db, await organisationOf(req), req.query);
    res.json({ ok: true, history });
  }));

  router.put('/:id', ...manager, handle(async (req, res) => {
    const field = await updateField(db, await organisationOf(req), req.params.id, req.body, { personId: req.person.id });
    res.json({ ok: true, field });
  }));

  router.post('/:id/archive', ...manager, handle(async (req, res) => {
    const archived = req.body?.archived ?? true;
    if (typeof archived !== 'boolean') throw new FlowError('invalid', 'archived must be true or false');
    const field = await archiveField(db, await organisationOf(req), req.params.id, { archived, personId: req.person.id });
    res.json({ ok: true, field });
  }));

  return router;
}
