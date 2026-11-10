import express from 'express';
import { keysFromEnv, verifyConnectorSignature } from '../core/connector-auth.js';
import { FlowError } from '../core/errors.js';
import { setJobFieldValue } from '../core/custom-fields.js';
import { getInvoice, listInvoices, updateDraftInvoice } from '../core/invoices.js';
import { listObligations } from '../core/ledger.js';
import { FLOW_VERSION, OPERATIONS, decideOperation, operationRevision } from '../core/operations.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The Flow API (`/api/flow/v1`, issue #9) is for one OpenClaw Gateway.
// Callers authenticate with a signed connector key, never a Clerk session.
// Until a key is configured, every request is refused.
export function createConnectorApi({
  keys = null,
  db = null,
  pool = null,
  findPerson = null,
  execute = null,
  now = () => Date.now(),
  log = console,
} = {}) {
  const router = express.Router();
  router.use(express.json({
    limit: '64kb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));

  router.use(async (req, res) => {
    let configured;
    try {
      configured = keys ?? keysFromEnv();
    } catch (error) {
      log.error?.(`[connector] ${error.message}`);
      return refuse(res);
    }
    if (!configured.length) return refuse(res);

    const path = req.originalUrl.split('?')[0];
    const key = verifyConnectorSignature({
      method: req.method,
      path,
      body: req.rawBody ?? '',
      headers: req.headers,
      keys: configured,
      now: now(),
    });
    if (!key) return refuse(res);

    try {
      const person = await (findPerson ?? defaultPerson(pool))(key.personId);
      if (req.method === 'GET' && path === '/api/flow/v1') {
        const decision = decideOperation(person, 'jobs.list', { surface: 'connector' });
        if (!decision.ok) return fail(res, 403, decision);
        return res.json({
          ok: true,
          flowVersion: FLOW_VERSION,
          operationRevision: operationRevision(),
          operations: OPERATIONS.filter((item) => item.connector).map((item) => item.id),
          personId: person.id,
        });
      }
      const match = path.match(/^\/api\/flow\/v1\/operations\/([a-z]+\.[a-zA-Z]+)$/);
      if (req.method !== 'POST' || !match) {
        return fail(res, 404, { code: 'not_found', error: 'That Flow API route does not exist.' });
      }
      const decision = decideOperation(person, match[1], { surface: 'connector' });
      if (!decision.ok) return fail(res, decision.code === 'not_found' ? 404 : 403, decision);
      const run = execute ?? ((id, actor, input) => executeBuiltIn(db, id, actor, input));
      const result = await run(match[1], person, req.body ?? {});
      res.json({ ok: true, flowVersion: FLOW_VERSION, operationRevision: operationRevision(), result });
    } catch (error) {
      if (error instanceof FlowError) return fail(res, error.code === 'not_found' ? 404 : 400, error);
      log.error?.(`[connector] ${error.message}`);
      return fail(res, 500, { code: 'connector_failed', error: 'Flow could not run that operation.' });
    }
  });
  return router;
}

function refuse(res) {
  return res.status(401).json({
    ok: false,
    code: 'connector_signature_required',
    error: 'The Flow API needs a signed connector request. Connector keys are not available yet.',
  });
}

function fail(res, status, error) {
  return res.status(status).json({ ok: false, code: error.code, error: error.error ?? error.message });
}

function defaultPerson(pool) {
  return async (personId) => {
    if (!pool) throw new FlowError('connector_failed', 'Flow has no database for this connector.');
    const found = await pool.query('select id, role, status from people where id = $1', [personId]);
    return found.rows[0] ?? null;
  };
}

async function executeBuiltIn(db, id, person, input) {
  if (!db) throw new FlowError('connector_failed', 'Flow has no database for this connector.');
  const organisationId = requiredId(input.organisationId, 'organisationId');
  if (id === 'jobs.list') {
    const jobs = await listObligations(db, organisationId, {});
    return { jobs: jobs.slice(0, limitOf(input.limit)) };
  }
  if (id === 'jobs.setField') {
    return setJobFieldValue(db, organisationId, input, { personId: person.id });
  }
  if (id === 'invoices.list') {
    return { invoices: await listInvoices(db, organisationId, { status: input.status }) };
  }
  if (id === 'invoices.get') {
    return { invoice: await getInvoice(db, organisationId, requiredId(input.invoiceId, 'invoiceId')) };
  }
  if (id === 'invoices.updateDraft') {
    const invoiceId = requiredId(input.invoiceId, 'invoiceId');
    const changes = {};
    if (input.contactId !== undefined) changes.contactId = requiredId(input.contactId, 'contactId');
    if (input.reference !== undefined) changes.reference = input.reference;
    if (input.dueDate !== undefined) changes.dueDate = input.dueDate;
    if (input.lines !== undefined) changes.lines = input.lines;
    if (!Object.keys(changes).length) throw new FlowError('invalid', 'nothing to change: send contactId, reference, dueDate or lines');
    return { invoice: await updateDraftInvoice(db, organisationId, invoiceId, changes) };
  }
  throw new FlowError('not_found', 'That operation does not exist.');
}

function requiredId(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FlowError('invalid', `${name} must be an id`);
  return value;
}

function limitOf(value) {
  const number = value == null ? 50 : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 100) {
    throw new FlowError('invalid', 'limit must be a whole number from 1 to 100');
  }
  return number;
}
