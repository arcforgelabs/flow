import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { people, PERSON_ROLES } from '../db/schema.js';
import { FlowError } from '../core/errors.js';
import { isPlainEmail } from './settings.js';

// The people who may sign in, and their roles. Only an owner changes this
// table (server/auth/routes.js); sign-in only reads it and links a row to its
// Clerk user on the first verified sign-in.

export function normaliseEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function publicPerson(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    // An invitation the person has not taken up yet.
    invited: !row.clerkUserId,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
  };
}

export async function findPersonById(db, id) {
  const [row] = await db.select().from(people).where(eq(people.id, id));
  return row ?? null;
}

export async function findPersonByClerkId(db, clerkUserId) {
  const [row] = await db.select().from(people).where(eq(people.clerkUserId, clerkUserId));
  return row ?? null;
}

export async function findPersonByEmail(db, email) {
  const [row] = await db.select().from(people).where(eq(people.email, normaliseEmail(email)));
  return row ?? null;
}

export function listPeople(db) {
  return db.select().from(people).orderBy(asc(people.status), asc(people.email));
}

function checkRole(role) {
  if (!PERSON_ROLES.includes(role)) throw new FlowError('invalid', `role must be one of ${PERSON_ROLES.join(', ')}`);
}

// An owner invites someone by email. They get in on their first sign-in with
// a verified Clerk account on that address.
export async function invitePerson(db, { email, name = null, role, invitedBy = null }) {
  const address = normaliseEmail(email);
  if (!isPlainEmail(address)) throw new FlowError('invalid', 'email must be a plain (ASCII) email address');
  checkRole(role);
  const [row] = await db.insert(people)
    .values({ email: address, name: name?.trim() || null, role, status: 'active', invitedBy })
    .onConflictDoNothing({ target: people.email })
    .returning();
  if (!row) throw new FlowError('conflict', 'that email address is already on the people list');
  return row;
}

// Public sign-up only: someone Flow does not know, waiting for an owner.
export async function recordPendingPerson(db, { email, name, clerkUserId }) {
  const [row] = await db.insert(people)
    .values({ email: normaliseEmail(email), name: name || null, role: 'staff', status: 'pending', clerkUserId, linkedAt: new Date() })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

// Links an invitation to the Clerk user who signed in with its verified
// email. Only an unlinked row links, so a concurrent sign-in cannot take it.
export async function linkPerson(db, { id, clerkUserId }) {
  const [row] = await db.update(people)
    .set({ clerkUserId, linkedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(people.id, id), isNull(people.clerkUserId)))
    .returning();
  return row ?? null;
}

// While the installation has no owner, invite `email` as its owner (or make
// that person the owner if they are already listed). Returns the row, or null
// when an owner already exists.
export async function seedFirstOwner(db, email) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${people} in share row exclusive mode`);
    const [owner] = await tx.select({ id: people.id }).from(people).where(eq(people.role, 'owner')).limit(1);
    if (owner) return null;
    const address = normaliseEmail(email);
    const [row] = await tx.insert(people)
      .values({ email: address, role: 'owner', status: 'active' })
      .onConflictDoUpdate({ target: people.email, set: { role: 'owner', status: 'active', updatedAt: new Date() } })
      .returning();
    return row;
  });
}

// Changes made by an owner. Flow always keeps one active owner, and an owner
// never changes or removes themself (so nobody locks themself out by mistake).
export async function updatePerson(db, { id, actorId, role, status }) {
  if (role !== undefined) checkRole(role);
  if (status !== undefined && !['active', 'disabled'].includes(status)) {
    throw new FlowError('invalid', 'status must be active or disabled');
  }
  if (id === actorId) throw new FlowError('forbidden', 'you cannot change your own role or access');
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${people} in share row exclusive mode`);
    const current = await findPersonById(tx, id);
    if (!current) throw new FlowError('not_found', 'person not found');
    const next = { role: role ?? current.role, status: status ?? current.status };
    if (current.role === 'owner' && current.status === 'active' && (next.role !== 'owner' || next.status !== 'active')) {
      await assertAnotherOwner(tx, id);
    }
    const [row] = await tx.update(people).set({ ...next, updatedAt: new Date() }).where(eq(people.id, id)).returning();
    return row;
  });
}

export async function removePerson(db, { id, actorId }) {
  if (id === actorId) throw new FlowError('forbidden', 'you cannot remove yourself');
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${people} in share row exclusive mode`);
    const current = await findPersonById(tx, id);
    if (!current) throw new FlowError('not_found', 'person not found');
    if (current.role === 'owner' && current.status === 'active') await assertAnotherOwner(tx, id);
    await tx.delete(people).where(eq(people.id, id));
    return current;
  });
}

async function assertAnotherOwner(tx, id) {
  const [other] = await tx.select({ id: people.id }).from(people)
    .where(and(eq(people.role, 'owner'), eq(people.status, 'active'), ne(people.id, id)))
    .limit(1);
  if (!other) throw new FlowError('conflict', 'Flow needs at least one active owner');
}
