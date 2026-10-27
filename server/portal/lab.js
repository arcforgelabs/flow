import { and, desc, eq, sql } from 'drizzle-orm';
import { normaliseEmail } from '../auth/people.js';
import { isPlainEmail } from '../auth/settings.js';
import { FlowError } from '../core/errors.js';
import { billingObligations, contacts, invoicingSettings, portalAccessRequests, PORTAL_STAGES } from '../db/schema.js';
import { resolveOrganisation } from '../api/invoicing.js';
import { addMember, listMembers, openingRole, publicMember } from './members.js';
import { normaliseStatusNames, portalScope, readPortalSettings } from './scope.js';

// The lab's side of the portal: join requests, Settings > Portal, and a
// read-only view of one practice. Practice routes do not use this module.

function requestOf(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    practiceName: row.practiceName,
    phone: row.phone,
    status: row.status,
    contactId: row.contactId,
    decidedAt: row.decidedAt?.toISOString?.() ?? row.decidedAt ?? null,
  };
}

export async function workStatuses(db, organisationId, work) {
  const labels = [];
  for (const adapter of work()) {
    if (typeof adapter?.capabilities?.listWork !== 'function') continue;
    try {
      const report = await adapter.capabilities.listWork({ organisationId });
      for (const status of report?.statuses ?? []) {
        const label = String(status?.label ?? status ?? '').trim();
        if (label) labels.push(label);
      }
    } catch {
      // The settings page still lists statuses Flow has already stored.
    }
  }
  if (!labels.length) {
    const rows = await db.select({ status: billingObligations.sourceStatus }).from(billingObligations)
      .where(eq(billingObligations.organisationId, organisationId));
    for (const row of rows) if (row.status) labels.push(row.status);
  }
  return [...new Set(labels)];
}

export async function portalSettingsView(db, organisationId, work) {
  const settings = await readPortalSettings(db, organisationId);
  const requests = await db.select().from(portalAccessRequests).where(and(
    eq(portalAccessRequests.organisationId, organisationId),
    eq(portalAccessRequests.status, 'open'),
  )).orderBy(desc(portalAccessRequests.createdAt));
  return {
    enabled: settings.enabled,
    names: settings.names,
    statuses: await workStatuses(db, organisationId, work),
    stages: PORTAL_STAGES,
    requests: requests.map(requestOf),
  };
}

export async function savePortalSettings(db, organisationId, { enabled, names }, personId) {
  if (typeof enabled !== 'boolean') throw new FlowError('invalid', 'enabled must be true or false');
  const portalStatusNames = normaliseStatusNames(names);
  await db.insert(invoicingSettings)
    .values({ organisationId, portalEnabled: enabled, portalStatusNames, updatedBy: personId })
    .onConflictDoUpdate({
      target: invoicingSettings.organisationId,
      set: { portalEnabled: enabled, portalStatusNames, updatedBy: personId, updatedAt: new Date() },
    });
  return readPortalSettings(db, organisationId);
}

export async function createJoinRequest(db, { name, email, practiceName, phone }) {
  const organisationId = await resolveOrganisation(db);
  const settings = await readPortalSettings(db, organisationId);
  if (!settings.enabled) throw new FlowError('portal_off', 'The practice portal is turned off.');
  const address = normaliseEmail(email);
  if (!isPlainEmail(address)) throw new FlowError('invalid', 'email must be a plain (ASCII) email address');
  const person = String(name ?? '').trim();
  const practice = String(practiceName ?? '').trim();
  const tel = String(phone ?? '').trim();
  if (!person || person.length > 120) throw new FlowError('invalid', 'name is required');
  if (!practice || practice.length > 160) throw new FlowError('invalid', 'practice name is required');
  if (tel.length > 40) throw new FlowError('invalid', 'phone is too long');
  const [existing] = await db.select().from(portalAccessRequests).where(and(
    eq(portalAccessRequests.organisationId, organisationId),
    eq(portalAccessRequests.email, address),
    eq(portalAccessRequests.practiceName, practice),
    eq(portalAccessRequests.status, 'open'),
  )).limit(1);
  if (existing) return existing;
  const [row] = await db.insert(portalAccessRequests).values({
    organisationId,
    name: person,
    email: address,
    practiceName: practice,
    phone: tel || null,
  }).returning();
  return row;
}

async function openRequest(tx, organisationId, id) {
  const [row] = await tx.select().from(portalAccessRequests).where(and(
    eq(portalAccessRequests.organisationId, organisationId),
    eq(portalAccessRequests.id, id),
  ));
  if (!row) throw new FlowError('not_found', 'request not found');
  if (row.status !== 'open') throw new FlowError('conflict', 'that request is already decided');
  return row;
}

export async function approveRequest(db, { organisationId, id, contactId, actorId }) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${portalAccessRequests} in share row exclusive mode`);
    const request = await openRequest(tx, organisationId, id);
    const role = await openingRole(tx, { organisationId, contactId });
    const member = await addMember(tx, {
      organisationId,
      contactId,
      email: request.email,
      name: request.name,
      role,
      invitedBy: actorId,
    });
    const [row] = await tx.update(portalAccessRequests).set({
      status: 'approved',
      contactId,
      decidedBy: actorId,
      decidedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(portalAccessRequests.id, request.id), eq(portalAccessRequests.organisationId, organisationId))).returning();
    return { request: row, member };
  });
}

export async function declineRequest(db, { organisationId, id, actorId }) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${portalAccessRequests} in share row exclusive mode`);
    const request = await openRequest(tx, organisationId, id);
    const [row] = await tx.update(portalAccessRequests).set({
      status: 'declined',
      decidedBy: actorId,
      decidedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(portalAccessRequests.id, request.id), eq(portalAccessRequests.organisationId, organisationId))).returning();
    return row;
  });
}

export async function contactPortal(db, organisationId, contactId) {
  const [contact] = await db.select({ id: contacts.id, name: contacts.name, kind: contacts.kind }).from(contacts).where(and(
    eq(contacts.organisationId, organisationId),
    eq(contacts.id, contactId),
  ));
  if (!contact) throw new FlowError('not_found', 'contact not found');
  const members = await listMembers(db, { organisationId, contactId });
  const requests = await db.select().from(portalAccessRequests).where(and(
    eq(portalAccessRequests.organisationId, organisationId),
    eq(portalAccessRequests.status, 'open'),
  )).orderBy(desc(portalAccessRequests.createdAt));
  const related = requests.filter((row) => row.contactId === contactId || row.practiceName.trim().toLowerCase() === contact.name.trim().toLowerCase());
  return {
    members: members.map((row) => publicMember(row, contact.name)),
    requests: related.map(requestOf),
  };
}

export function previewScope(db, { organisationId, contactId, work, log }) {
  return portalScope(db, { organisationId, contactId, work, log, readOnly: true, requireEnabled: false });
}
