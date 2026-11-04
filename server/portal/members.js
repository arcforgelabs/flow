import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { normaliseEmail } from '../auth/people.js';
import { isPlainEmail } from '../auth/settings.js';
import { FlowError } from '../core/errors.js';
import { contacts, practiceMembers } from '../db/schema.js';
import { recordAudit } from './audit.js';

// A practice's people. Owners and admins invite and remove their own team.
// An admin cannot change an owner. The practice keeps one owner.

const ROLES = ['owner', 'admin', 'dentist', 'staff'];
const KEEPS_OWNER = ['active', 'invited'];

export function publicMember(row) {
  return {
    id: row.id,
    contactId: row.contactId,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    practitionerName: row.practitionerName,
    invited: row.status === 'invited',
  };
}

export function managesTeam(member) {
  return member?.role === 'owner' || member?.role === 'admin';
}

function textOf(value, label, max, { required = true } = {}) {
  const text = String(value ?? '').trim();
  if (!text) {
    if (!required) return null;
    throw new FlowError('invalid', `${label} is required`);
  }
  if (text.length > max) throw new FlowError('invalid', `${label} must be ${max} characters or fewer`);
  return text;
}

function roleOf(role) {
  if (!ROLES.includes(role)) throw new FlowError('invalid', 'role must be owner, admin, dentist or staff');
  return role;
}

export async function membersForClerk(db, clerkUserId) {
  return db.select().from(practiceMembers).where(and(
    eq(practiceMembers.clerkUserId, clerkUserId),
    eq(practiceMembers.status, 'active'),
  ));
}

export async function linkInvitedMembers(db, { email, clerkUserId }) {
  const rows = await db.select().from(practiceMembers).where(and(
    eq(practiceMembers.email, normaliseEmail(email)),
    eq(practiceMembers.status, 'invited'),
  ));
  const linked = [];
  for (const row of rows) {
    if (row.clerkUserId && row.clerkUserId !== clerkUserId) continue;
    const [next] = await db.update(practiceMembers).set({
      clerkUserId,
      status: 'active',
      linkedAt: sql`now()`,
      updatedAt: sql`now()`,
    }).where(eq(practiceMembers.id, row.id)).returning();
    if (next) linked.push(next);
  }
  return linked;
}

export async function listMembers(db, { organisationId, contactId }) {
  return db.select().from(practiceMembers).where(and(
    eq(practiceMembers.organisationId, organisationId),
    eq(practiceMembers.contactId, contactId),
    inArray(practiceMembers.status, ['active', 'invited']),
  )).orderBy(practiceMembers.createdAt);
}

async function assertAnotherOwner(db, { organisationId, contactId, id }) {
  const [other] = await db.select({ id: practiceMembers.id }).from(practiceMembers).where(and(
    eq(practiceMembers.organisationId, organisationId),
    eq(practiceMembers.contactId, contactId),
    eq(practiceMembers.role, 'owner'),
    inArray(practiceMembers.status, KEEPS_OWNER),
    ne(practiceMembers.id, id),
  )).limit(1);
  if (!other) throw new FlowError('conflict', 'The practice needs at least one owner');
}

async function requireCustomer(db, organisationId, contactId) {
  const [contact] = await db.select({ id: contacts.id, kind: contacts.kind, name: contacts.name }).from(contacts)
    .where(and(eq(contacts.organisationId, organisationId), eq(contacts.id, contactId)));
  if (!contact) throw new FlowError('not_found', 'contact not found');
  if (contact.kind !== 'customer') throw new FlowError('invalid', 'a practice is a customer contact');
  return contact;
}

// Inserts or reopens a member row. The route sends the Clerk invitation.
export async function addMember(db, {
  organisationId, contactId, email, name, role, practitionerName = null,
  invitedByPerson = null, invitedByMember = null, actorKind, actorId, ip,
}) {
  await requireCustomer(db, organisationId, contactId);
  const cleanEmail = normaliseEmail(email);
  if (!isPlainEmail(cleanEmail)) throw new FlowError('invalid', 'email must be a plain (ASCII) email address');
  const cleanRole = roleOf(role);
  const cleanName = textOf(name, 'Name', 120, { required: false });
  const practitioner = textOf(practitionerName, 'Dentist', 120, { required: false });
  const [existing] = await db.select().from(practiceMembers).where(and(
    eq(practiceMembers.organisationId, organisationId),
    eq(practiceMembers.contactId, contactId),
    eq(practiceMembers.email, cleanEmail),
  ));
  if (existing && existing.status !== 'removed') throw new FlowError('conflict', 'that email is already on this practice');
  const values = {
    name: cleanName,
    role: cleanRole,
    status: 'invited',
    practitionerName: practitioner,
    invitedByPerson,
    invitedByMember,
    updatedAt: sql`now()`,
  };
  const [row] = existing
    ? await db.update(practiceMembers).set(values).where(eq(practiceMembers.id, existing.id)).returning()
    : await db.insert(practiceMembers).values({
      organisationId, contactId, email: cleanEmail, ...values,
    }).returning();
  await recordAudit(db, {
    organisationId,
    actorKind,
    actorId,
    practiceContactId: contactId,
    action: 'create',
    recordType: 'member',
    recordId: row.id,
    ip,
  });
  return row;
}

export async function updateMember(db, { organisationId, contactId, id, actor, role, practitionerName, ip }) {
  if (!managesTeam(actor)) throw new FlowError('forbidden', 'Your role does not manage the team');
  const [target] = await db.select().from(practiceMembers).where(and(
    eq(practiceMembers.id, id),
    eq(practiceMembers.organisationId, organisationId),
    eq(practiceMembers.contactId, contactId),
    inArray(practiceMembers.status, ['active', 'invited']),
  ));
  if (!target) throw new FlowError('not_found', 'member not found');
  if (target.role === 'owner' && actor.role !== 'owner') throw new FlowError('forbidden', 'An admin cannot change an owner');
  const nextRole = role == null ? target.role : roleOf(role);
  if (nextRole === 'owner' && actor.role !== 'owner') throw new FlowError('forbidden', 'An admin cannot add an owner');
  if (target.role === 'owner' && nextRole !== 'owner') {
    await assertAnotherOwner(db, { organisationId, contactId, id });
  }
  const practitioner = practitionerName === undefined ? target.practitionerName : textOf(practitionerName, 'Dentist', 120, { required: false });
  const [row] = await db.update(practiceMembers).set({
    role: nextRole,
    practitionerName: practitioner,
    updatedAt: sql`now()`,
  }).where(eq(practiceMembers.id, id)).returning();
  await recordAudit(db, {
    organisationId,
    actorKind: 'member',
    actorId: actor.id,
    practiceContactId: contactId,
    action: 'change',
    recordType: 'member',
    recordId: row.id,
    ip,
  });
  return row;
}

export async function removeMember(db, { organisationId, contactId, id, actor, ip }) {
  if (!managesTeam(actor)) throw new FlowError('forbidden', 'Your role does not manage the team');
  if (id === actor.id) throw new FlowError('conflict', 'You cannot remove yourself');
  const [target] = await db.select().from(practiceMembers).where(and(
    eq(practiceMembers.id, id),
    eq(practiceMembers.organisationId, organisationId),
    eq(practiceMembers.contactId, contactId),
    inArray(practiceMembers.status, ['active', 'invited']),
  ));
  if (!target) throw new FlowError('not_found', 'member not found');
  if (target.role === 'owner' && actor.role !== 'owner') throw new FlowError('forbidden', 'An admin cannot change an owner');
  if (target.role === 'owner') await assertAnotherOwner(db, { organisationId, contactId, id });
  const [row] = await db.update(practiceMembers).set({
    status: 'removed',
    updatedAt: sql`now()`,
  }).where(eq(practiceMembers.id, id)).returning();
  await recordAudit(db, {
    organisationId,
    actorKind: 'member',
    actorId: actor.id,
    practiceContactId: contactId,
    action: 'delete',
    recordType: 'member',
    recordId: row.id,
    ip,
  });
  return row;
}
