import { createHash } from 'node:crypto';
import { FlowError } from './errors.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// One list owns the first native slice. Express and the connector both ask
// this module who may run an operation. Financial send stays off the connector.
const ROLES = ['owner', 'admin', 'staff'];

export const FLOW_VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')).version;

export const OPERATIONS = [
  { id: 'jobs.list', roles: ROLES, access: 'read', connector: true },
  { id: 'jobs.setField', roles: ROLES, access: 'write', connector: true },
  { id: 'invoices.list', roles: ROLES, access: 'read', connector: true },
  { id: 'invoices.get', roles: ROLES, access: 'read', connector: true },
  { id: 'invoices.updateDraft', roles: ROLES, access: 'write', connector: true },
  { id: 'invoices.issue', roles: ['owner', 'admin'], access: 'write', connector: false },
  { id: 'invoices.revise', roles: ['owner', 'admin'], access: 'write', connector: false },
  { id: 'invoices.void', roles: ['owner', 'admin'], access: 'write', connector: false },
  { id: 'invoices.send', roles: ['owner', 'admin'], access: 'write', connector: false },
];

export function operationRevision(operations = OPERATIONS) {
  return createHash('sha256').update(JSON.stringify(operations)).digest('hex');
}

export function roleAllowed(person, roles) {
  return Boolean(person && person.status === 'active' && roles.includes(person.role));
}

export function findOperation(id, operations = OPERATIONS) {
  return operations.find((operation) => operation.id === id) ?? null;
}

// `surface` is `web` or `connector`. A financial operation stays in the web app.
export function decideOperation(person, id, { surface = 'web', operations = OPERATIONS } = {}) {
  const operation = findOperation(id, operations);
  if (!operation) return { ok: false, code: 'not_found', error: 'That operation does not exist.' };
  if (surface === 'connector' && !operation.connector) {
    return { ok: false, code: 'operation_not_in_slice', error: 'A person approves that action in Flow.' };
  }
  if (!person || person.status !== 'active') {
    return { ok: false, code: 'access_disabled', error: 'This person cannot use Flow.' };
  }
  if (!roleAllowed(person, operation.roles)) {
    return { ok: false, code: 'role_required', error: 'This person cannot run that operation.' };
  }
  return { ok: true, operation };
}

export function assertOperation(person, id, options) {
  const decision = decideOperation(person, id, options);
  if (!decision.ok) throw new FlowError(decision.code, decision.error);
  return decision.operation;
}
