import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { listAutomations } from '../../core/automations.js';
import { getContact, updateContact } from '../../core/contacts.js';
import { FlowError } from '../../core/errors.js';
import { openReview, resolveReviewFor } from '../../core/review.js';
import { isCallsStopped } from '../call-guard.js';
import { mapContact, upsertContact } from './catalogue.js';
import { readConnection } from './connections.js';
import { withXeroLane } from './governor.js';
import { writesAllowed } from './settings.js';

// Two-way contact edits (docs/CONTACTS.md), when "Two-way edits"
// (sync_contact_edits) is on. For each Flow contact linked to a Xero contact,
// Flow compares three versions of each field: Flow's, Flow's copy of Xero
// (catalogue.js), and the base, the value both sides last agreed on
// (xero_contact_sync). The side that changed a field since the base wins:
//
//   only Flow changed it   Flow writes it to Xero (read the live contact first)
//   only Xero changed it   Flow takes it from the copy (no Xero call)
//   both changed it        a clash: neither side changes. A review item says
//                          which fields differ, alert only; it closes when a
//                          person makes the two sides the same.
//
// The first time a pair is compared there is no base: a field blank on one
// side takes the other side's value, and a field set on both sides to
// different values is a clash. Practitioners, the tax rate and Active stay
// Flow's own. Writes to Xero follow XERO_ALLOW_LIVE_WRITES; while they are
// not allowed, a Flow change waits and Xero's changes still come in.

export const CONTACT_FIELDS = Object.freeze(['name', 'firstName', 'lastName', 'email', 'phone', 'mobile', 'accountNumber', 'taxNumber', 'address']);
export const CONTACT_DIFFERS = 'contact.accounting_differs';
export const ACTOR = 'system:xero-contacts';
const AUTOMATION = 'sync_contact_edits';
const ADDRESS_KEYS = ['line1', 'line2', 'city', 'region', 'postalCode', 'country'];
// Xero writes in one pass, so a long list of edits spreads over passes.
const PUSHES_PER_PASS = 20;

// One field's value in the form both sides compare: text trimmed or null, an
// address with its keys in order or null.
export function fieldValue(field, value) {
  if (field === 'address') {
    if (!value || typeof value !== 'object') return null;
    const kept = {};
    for (const key of ADDRESS_KEYS) {
      const text = String(value[key] ?? '').trim();
      if (text) kept[key] = text;
    }
    return Object.keys(kept).length ? kept : null;
  }
  const text = String(value ?? '').trim();
  return text || null;
}

export const fieldsOf = (record) => Object.fromEntries(CONTACT_FIELDS.map((field) => [field, fieldValue(field, record?.[field])]));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// What to change on each side, from the three versions. `base` null is the
// first compare of a pair.
export function planContactSync(flow, xero, base) {
  const toFlow = {};
  const toXero = {};
  const clashes = [];
  const next = {};
  for (const field of CONTACT_FIELDS) {
    const mine = flow[field];
    const theirs = xero[field];
    if (same(mine, theirs)) {
      next[field] = mine;
      continue;
    }
    const was = base ? base[field] ?? null : null;
    const flowChanged = base ? !same(mine, was) : mine !== null;
    const xeroChanged = base ? !same(theirs, was) : theirs !== null;
    if (flowChanged && !xeroChanged) {
      toXero[field] = mine;
      next[field] = mine;
    } else if (xeroChanged && !flowChanged) {
      toFlow[field] = theirs;
      next[field] = theirs;
    } else {
      clashes.push({ field, flow: mine, xero: theirs });
      next[field] = was;
    }
  }
  return { toFlow, toXero, clashes, base: next };
}

// The Xero body for the fields Flow changed. A blank clears the field.
export function xeroContactChanges(changes) {
  const body = {};
  const simple = { name: 'Name', firstName: 'FirstName', lastName: 'LastName', email: 'EmailAddress', accountNumber: 'AccountNumber', taxNumber: 'TaxNumber' };
  for (const [field, key] of Object.entries(simple)) {
    if (field in changes) body[key] = changes[field] ?? '';
  }
  const phones = [];
  for (const [field, type] of [['phone', 'DEFAULT'], ['mobile', 'MOBILE']]) {
    if (field in changes) phones.push({ PhoneType: type, PhoneNumber: changes[field] ?? '', PhoneAreaCode: '', PhoneCountryCode: '' });
  }
  if (phones.length) body.Phones = phones;
  if ('address' in changes) {
    const address = changes.address ?? {};
    const lines = {
      AddressLine1: address.line1 || '', AddressLine2: address.line2 || '', City: address.city || '',
      Region: address.region || '', PostalCode: address.postalCode || '', Country: address.country || '',
    };
    body.Addresses = [{ AddressType: 'POBOX', ...lines }, { AddressType: 'STREET', ...lines }];
  }
  return body;
}

function idempotencyKey(organisationId, xeroContactId, body) {
  const digest = createHash('sha256').update([organisationId, xeroContactId, JSON.stringify(body)].join('\u0000')).digest('hex');
  return `flow-xero-contact-edit-${digest.slice(0, 40)}`;
}

// Each Flow contact linked to an active Xero contact in the copy, with the
// pair's base when there is one.
async function linkedPairs(db, organisationId) {
  const { rows } = await db.execute(sql`
    select l.flow_id, x.*, s.contact_id as base_contact_id, s.base, s.clashes as saved_clashes
    from external_links l
    join xero_contacts x on x.organisation_id = l.organisation_id and x.xero_contact_id = l.external_id
    join contacts c on c.organisation_id = l.organisation_id and c.id = l.flow_id
    left join xero_contact_sync s on s.organisation_id = l.organisation_id and s.xero_contact_id = l.external_id
    where l.organisation_id = ${organisationId} and l.system = 'xero' and l.entity = 'contact' and l.state = 'active'
      and x.status = 'ACTIVE'
    order by x.name`);
  return rows;
}

const copyFields = (row) => fieldsOf({
  name: row.name, firstName: row.first_name, lastName: row.last_name, email: row.email, phone: row.phone,
  mobile: row.mobile, accountNumber: row.account_number, taxNumber: row.tax_number, address: row.address,
});

async function saveBase(db, organisationId, { xeroContactId, contactId, base, clashes, error = null, pushed = false }) {
  await db.execute(sql`insert into xero_contact_sync (organisation_id, xero_contact_id, contact_id, base, clashes, last_error, checked_at, pushed_at)
    values (${organisationId}, ${xeroContactId}, ${contactId}, ${JSON.stringify(base)}::jsonb, ${JSON.stringify(clashes)}::jsonb, ${error}, now(),
      case when ${pushed} then now() else null end)
    on conflict (organisation_id, xero_contact_id) do update set
      contact_id = excluded.contact_id, base = excluded.base, clashes = excluded.clashes, last_error = excluded.last_error,
      checked_at = now(), pushed_at = case when ${pushed} then now() else xero_contact_sync.pushed_at end`);
}

// Takes Xero's values into the Flow contact. A value Flow cannot keep (too
// long for the field) stays a clash.
async function takeFromXero(db, organisationId, contactId, changes) {
  const taken = {};
  const refused = [];
  const attempt = async (patch) => {
    await updateContact(db, organisationId, contactId, patch);
    Object.assign(taken, patch);
  };
  try {
    await attempt(changes);
  } catch (error) {
    if (!(error instanceof FlowError)) throw error;
    for (const [field, value] of Object.entries(changes)) {
      try {
        await attempt({ [field]: value });
      } catch (inner) {
        if (!(inner instanceof FlowError)) throw inner;
        refused.push(field);
      }
    }
  }
  return { taken, refused };
}

// Writes Flow's changed fields to one Xero contact. Reads the live contact
// first: when Xero changed one of those fields since the copy, the copy takes
// it and nothing is written; the next pass compares again.
async function pushToXero(db, runtime, organisationId, xeroContactId, changes, copy) {
  return runtime.serial(organisationId, () => withXeroLane('writes', async () => {
    const { client } = await runtime.clientFor(db, organisationId);
    await runtime.assertEnvironment(client);
    const live = await client.getContact(xeroContactId);
    if (!live) return { outcome: 'gone' };
    const now = fieldsOf(mapContact(live));
    if (Object.keys(changes).some((field) => !same(now[field], copy[field]))) {
      await upsertContact(db, organisationId, mapContact(live));
      return { outcome: 'moved' };
    }
    const body = xeroContactChanges(changes);
    const updated = await client.updateContact(xeroContactId, body, { idempotencyKey: idempotencyKey(organisationId, xeroContactId, body) });
    await upsertContact(db, organisationId, mapContact(updated));
    return { outcome: 'written' };
  }));
}

async function noteClashes(db, organisationId, contactId, xeroContactId, clashes) {
  if (clashes.length) {
    await openReview(db, organisationId, {
      kind: CONTACT_DIFFERS, entity: 'contact', flowId: contactId, systems: ['flow', 'xero'],
      evidence: { xeroContactId, fields: clashes },
    });
  } else {
    await resolveReviewFor(db, organisationId, { kind: CONTACT_DIFFERS, entity: 'contact', flowId: contactId, resolution: 'contacts_agree', actor: ACTOR });
  }
}

// One pass for one organisation. Answers counts.
export async function syncContactEdits(db, runtime, organisationId) {
  const result = { compared: 0, toFlow: 0, toXero: 0, waiting: 0, clashes: 0, errors: 0 };
  const canWrite = writesAllowed(runtime.settings);
  let pushes = 0;
  for (const row of await linkedPairs(db, organisationId)) {
    result.compared += 1;
    const contactId = row.flow_id;
    const xeroContactId = row.xero_contact_id;
    // A base belongs to one pair: a link to another Flow contact starts again.
    const base = row.base && row.base_contact_id === contactId ? row.base : null;
    const copy = copyFields(row);
    const flow = fieldsOf(await getContact(db, organisationId, contactId));
    const plan = planContactSync(flow, copy, base);
    if (Object.keys(plan.toFlow).length) {
      const { taken, refused } = await takeFromXero(db, organisationId, contactId, plan.toFlow);
      if (Object.keys(taken).length) result.toFlow += 1;
      for (const field of refused) {
        plan.clashes.push({ field, flow: flow[field], xero: copy[field] });
        plan.base[field] = base?.[field] ?? null;
      }
    }
    let error = null;
    let pushed = false;
    if (Object.keys(plan.toXero).length) {
      if (!canWrite || pushes >= PUSHES_PER_PASS) {
        // Not written yet: the base keeps the old value, so the change stays Flow's.
        for (const field of Object.keys(plan.toXero)) plan.base[field] = base?.[field] ?? copy[field];
        result.waiting += 1;
      } else {
        pushes += 1;
        try {
          const sent = await pushToXero(db, runtime, organisationId, xeroContactId, plan.toXero, copy);
          if (sent.outcome === 'written') {
            pushed = true;
            result.toXero += 1;
          } else {
            for (const field of Object.keys(plan.toXero)) plan.base[field] = base?.[field] ?? copy[field];
            result.waiting += 1;
          }
        } catch (failure) {
          // A stop (budget, a refused token) ends the pass; it is not this contact's fault.
          if (isCallsStopped(failure)) throw failure;
          error = `${failure.code ?? 'error'}: ${String(failure.message).slice(0, 300)}`;
          for (const field of Object.keys(plan.toXero)) {
            plan.clashes.push({ field, flow: flow[field], xero: copy[field], error: failure.message });
            plan.base[field] = base?.[field] ?? copy[field];
          }
          result.errors += 1;
        }
      }
    }
    if (plan.clashes.length) result.clashes += 1;
    await saveBase(db, organisationId, { xeroContactId, contactId, base: plan.base, clashes: plan.clashes, error, pushed });
    await noteClashes(db, organisationId, contactId, xeroContactId, plan.clashes);
  }
  return result;
}

// The fields of one Flow contact that differ from Xero and wait for a person
// (the contact page). No Xero calls.
export async function contactClashes(db, organisationId, contactId) {
  const { rows } = await db.execute(sql`select clashes from xero_contact_sync
    where organisation_id = ${organisationId} and contact_id = ${contactId}`);
  return rows.flatMap((row) => row.clashes ?? []);
}

// Every connected organisation whose "Two-way edits" is on. The import worker
// runs this on its tick. A stop of Xero calls skips that organisation.
export async function syncContactsForAll(db, runtime, { log = console } = {}) {
  const { rows } = await db.execute(sql`select organisation_id from xero_connections where mode = ${runtime.settings.mode}`);
  for (const { organisation_id: organisationId } of rows) {
    const setting = (await listAutomations(db, organisationId)).find((a) => a.key === AUTOMATION);
    if (!setting?.enabled) continue;
    const connection = await readConnection(db, organisationId);
    if (!connection) continue;
    try {
      const result = await syncContactEdits(db, runtime, organisationId);
      if (result.toFlow || result.toXero || result.errors) {
        log.info?.(`[xero] contact edits for organisation ${organisationId}: ${result.toFlow} from Xero, ${result.toXero} to Xero, ${result.clashes} differ, ${result.errors} refused`);
      }
    } catch (error) {
      if (isCallsStopped(error)) continue;
      log.error?.(`[xero] contact edits for organisation ${organisationId} failed: ${error?.code ?? 'error'}: ${error?.message ?? error}`);
    }
  }
}
