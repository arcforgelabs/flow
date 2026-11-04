import { and, desc, eq, sql } from 'drizzle-orm';
import { normaliseEmail } from '../auth/people.js';
import { isPlainEmail } from '../auth/settings.js';
import { FlowError } from '../core/errors.js';
import { portalAccessRequests, practiceMembers } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { addMember } from './members.js';

// Join asks the lab for access and stores nothing the person can read.
// Approve links the request to a customer contact and makes the member.
// The first member of a practice is its owner.

function textOf(value, label, max, { required = true } = {}) {
  const text = String(value ?? '').trim();
  if (!text) {
    if (!required) return null;
    throw new FlowError('invalid', `${label} is required`);
  }
  if (text.length > max) throw new FlowError('invalid', `${label} must be ${max} characters or fewer`);
  return text;
}

export function publicRequest(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    practiceName: row.practiceName,
    phone: row.phone,
    status: row.status,
    contactId: row.contactId,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

export async function createJoinRequest(db, { organisationId, name, email, practiceName, phone, ip }) {
  const cleanEmail = normaliseEmail(email);
  if (!isPlainEmail(cleanEmail)) throw new FlowError('invalid', 'email must be a plain (ASCII) email address');
  const values = {
    name: textOf(name, 'Name', 120),
    practiceName: textOf(practiceName, 'Practice', 160),
    phone: textOf(phone, 'Phone', 40, { required: false }),
  };
  const [open] = await db.select().from(portalAccessRequests).where(and(
    eq(portalAccessRequests.organisationId, organisationId),
    eq(portalAccessRequests.email, cleanEmail),
    eq(portalAccessRequests.status, 'open'),
  )).limit(1);
  if (open) return open;
  const [row] = await db.insert(portalAccessRequests).values({
    organisationId, email: cleanEmail, ...values,
  }).returning();
  await recordAudit(db, {
    organisationId,
    actorKind: 'anonymous',
    action: 'create',
    recordType: 'request',
    recordId: row.id,
    ip,
  });
  return row;
}

export async function openRequestForEmail(db, email) {
  const [row] = await db.select().from(portalAccessRequests).where(and(
    eq(portalAccessRequests.email, normaliseEmail(email)),
    eq(portalAccessRequests.status, 'open'),
  )).limit(1);
  return row ?? null;
}

export async function listRequests(db, organisationId, { contactId = null, status = null } = {}) {
  const where = [eq(portalAccessRequests.organisationId, organisationId)];
  if (contactId) where.push(eq(portalAccessRequests.contactId, contactId));
  if (status) where.push(eq(portalAccessRequests.status, status));
  return db.select().from(portalAccessRequests).where(and(...where)).orderBy(desc(portalAccessRequests.createdAt));
}

async function openRequest(db, organisationId, id) {
  const [row] = await db.select().from(portalAccessRequests).where(and(
    eq(portalAccessRequests.id, id),
    eq(portalAccessRequests.organisationId, organisationId),
  ));
  if (!row) throw new FlowError('not_found', 'request not found');
  if (row.status !== 'open') throw new FlowError('conflict', 'that request is already decided');
  return row;
}

export async function approveRequest(db, { organisationId, id, contactId, personId, ip }) {
  const request = await openRequest(db, organisationId, id);
  const [owners] = await db.select({ id: practiceMembers.id }).from(practiceMembers).where(and(
    eq(practiceMembers.organisationId, organisationId),
    eq(practiceMembers.contactId, contactId),
    eq(practiceMembers.role, 'owner'),
    sql`${practiceMembers.status} in ('active', 'invited')`,
  )).limit(1);
  const member = await addMember(db, {
    organisationId,
    contactId,
    email: request.email,
    name: request.name,
    role: owners ? 'staff' : 'owner',
    invitedByPerson: personId,
    actorKind: 'person',
    actorId: personId,
    ip,
  });
  const [row] = await db.update(portalAccessRequests).set({
    status: 'approved',
    contactId,
    decidedBy: personId,
    decidedAt: sql`now()`,
    updatedAt: sql`now()`,
  }).where(eq(portalAccessRequests.id, id)).returning();
  await recordAudit(db, {
    organisationId,
    actorKind: 'person',
    actorId: personId,
    practiceContactId: contactId,
    action: 'change',
    recordType: 'request',
    recordId: row.id,
    ip,
  });
  return { request: row, member };
}

export async function declineRequest(db, { organisationId, id, personId, ip }) {
  const request = await openRequest(db, organisationId, id);
  const [row] = await db.update(portalAccessRequests).set({
    status: 'declined',
    decidedBy: personId,
    decidedAt: sql`now()`,
    updatedAt: sql`now()`,
  }).where(eq(portalAccessRequests.id, id)).returning();
  await recordAudit(db, {
    organisationId,
    actorKind: 'person',
    actorId: personId,
    practiceContactId: request.contactId,
    action: 'change',
    recordType: 'request',
    recordId: row.id,
    ip,
  });
  return row;
}
