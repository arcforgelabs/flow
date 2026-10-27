import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { isPlainEmail } from '../auth/settings.js';
import { normaliseEmail } from '../auth/people.js';
import { FlowError } from '../core/errors.js';
import { contacts, PRACTICE_ROLES, practiceMembers } from '../db/schema.js';

// Practice team rows (docs/PORTAL.md). Every read and write names the
// practice (organisation and contact). A caller cannot pass a different one.

export function publicMember(row, practiceName = null) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    practitionerName: row.practitionerName,
    invited: !row.clerkUserId,
    contactId: row.contactId,
    practiceName,
  };
}

const ROLE_ORDER = { owner: 0, admin: 1, dentist: 2, staff: 3 };

export async function listMembers(db, { organisationId, contactId }) {
  const rows = await db.select().from(practiceMembers).where(and(
    eq(practiceMembers.organisationId, organisationId),
    eq(practiceMembers.contactId, contactId),
  )).orderBy(asc(practiceMembers.email));
  return rows
    .filter((row) => row.organisationId === organisationId && row.contactId === contactId)
    .sort((a, b) => (a.status === 'removed') - (b.status === 'removed')
      || (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9)
      || String(a.name ?? a.email).localeCompare(String(b.name ?? b.email)));
}

// The first person at a practice is its owner. Anyone approved after an
// owner exists joins as staff; the team can change that.
export async function openingRole(db, { organisationId, contactId }) {
  const [owner] = await db.select({ id: practiceMembers.id }).from(practiceMembers).where(and(
    eq(practiceMembers.organisationId, organisationId),
    eq(practiceMembers.contactId, contactId),
    eq(practiceMembers.role, 'owner'),
    inArray(practiceMembers.status, ['invited', 'active']),
  )).limit(1);
  return owner ? 'staff' : 'owner';
}

async function requireCustomer(db, organisationId, contactId) {
  const [contact] = await db.select({ id: contacts.id, name: contacts.name }).from(contacts).where(and(
    eq(contacts.organisationId, organisationId),
    eq(contacts.id, contactId),
    eq(contacts.kind, 'customer'),
  ));
  if (!contact) throw new FlowError('not_found', 'practice not found');
  return contact;
}

export async function addMember(db, { organisationId, contactId, email, name, role, practitionerName = null, invitedBy = null }) {
  if (!PRACTICE_ROLES.includes(role)) throw new FlowError('invalid', `role must be one of ${PRACTICE_ROLES.join(', ')}`);
  const address = normaliseEmail(email);
  if (!isPlainEmail(address)) throw new FlowError('invalid', 'email must be a plain (ASCII) email address');
  await requireCustomer(db, organisationId, contactId);
  const label = String(name ?? '').trim() || null;
  const dentist = String(practitionerName ?? '').trim() || null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${practiceMembers} in share row exclusive mode`);
    const [existing] = await tx.select().from(practiceMembers).where(and(
      eq(practiceMembers.organisationId, organisationId),
      eq(practiceMembers.contactId, contactId),
      eq(practiceMembers.email, address),
    ));
    if (existing && existing.status !== 'removed') throw new FlowError('conflict', 'that email address is already on the team');
    const values = {
      name: label,
      role,
      status: existing?.clerkUserId ? 'active' : 'invited',
      practitionerName: dentist,
      invitedBy,
      updatedAt: new Date(),
    };
    if (existing) {
      const [row] = await tx.update(practiceMembers).set(values).where(and(
        eq(practiceMembers.id, existing.id),
        eq(practiceMembers.contactId, contactId),
      )).returning();
      return row;
    }
    const [row] = await tx.insert(practiceMembers).values({ organisationId, contactId, email: address, ...values }).returning();
    return row;
  });
}

function assertManager(actor, contactId) {
  if (!actor || actor.contactId !== contactId || actor.status !== 'active' || !['owner', 'admin'].includes(actor.role)) {
    throw new FlowError('forbidden', 'Only an owner or an admin can change the team.');
  }
}

async function assertAnotherOwner(tx, { organisationId, contactId, id }) {
  const [other] = await tx.select({ id: practiceMembers.id }).from(practiceMembers).where(and(
    eq(practiceMembers.organisationId, organisationId),
    eq(practiceMembers.contactId, contactId),
    eq(practiceMembers.role, 'owner'),
    eq(practiceMembers.status, 'active'),
    ne(practiceMembers.id, id),
  )).limit(1);
  if (!other) throw new FlowError('conflict', 'The practice needs at least one active owner');
}

async function memberInPractice(tx, { organisationId, contactId, id }) {
  const [current] = await tx.select().from(practiceMembers).where(and(
    eq(practiceMembers.organisationId, organisationId),
    eq(practiceMembers.contactId, contactId),
    eq(practiceMembers.id, id),
  ));
  if (!current || current.status === 'removed') throw new FlowError('not_found', 'member not found');
  return current;
}

export async function changeMember(db, { organisationId, contactId, id, actor, role, practitionerName }) {
  assertManager(actor, contactId);
  if (role !== undefined && !PRACTICE_ROLES.includes(role)) {
    throw new FlowError('invalid', `role must be one of ${PRACTICE_ROLES.join(', ')}`);
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${practiceMembers} in share row exclusive mode`);
    const current = await memberInPractice(tx, { organisationId, contactId, id });
    if (current.id === actor.id) throw new FlowError('forbidden', 'you cannot change your own role or access');
    const nextRole = role ?? current.role;
    if (actor.role !== 'owner' && (current.role === 'owner' || nextRole === 'owner')) {
      throw new FlowError('forbidden', 'An admin cannot change an owner');
    }
    if (current.role === 'owner' && current.status === 'active' && nextRole !== 'owner') {
      await assertAnotherOwner(tx, { organisationId, contactId, id });
    }
    const patch = { role: nextRole, updatedAt: new Date() };
    if (practitionerName !== undefined) patch.practitionerName = String(practitionerName ?? '').trim() || null;
    const [row] = await tx.update(practiceMembers).set(patch).where(and(
      eq(practiceMembers.id, current.id),
      eq(practiceMembers.contactId, contactId),
    )).returning();
    return row;
  });
}

export async function removeMember(db, { organisationId, contactId, id, actor }) {
  assertManager(actor, contactId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${practiceMembers} in share row exclusive mode`);
    const current = await memberInPractice(tx, { organisationId, contactId, id });
    if (current.id === actor.id) throw new FlowError('forbidden', 'you cannot change your own role or access');
    if (actor.role !== 'owner' && current.role === 'owner') throw new FlowError('forbidden', 'An admin cannot change an owner');
    if (current.role === 'owner' && current.status === 'active') await assertAnotherOwner(tx, { organisationId, contactId, id });
    const [row] = await tx.update(practiceMembers).set({ status: 'removed', updatedAt: new Date() }).where(and(
      eq(practiceMembers.id, current.id),
      eq(practiceMembers.contactId, contactId),
    )).returning();
    return row;
  });
}
