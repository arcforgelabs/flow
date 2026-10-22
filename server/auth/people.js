import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { people, PERSON_ROLES } from '../db/schema.js';
import { FlowError } from '../core/errors.js';
import { isThemeFamily, normalizeAccent } from '../theme/themes.js';
import { invoiceColumnsView, normaliseJobsView, normaliseListView, PRICE_COLUMNS, RECONCILE_COLUMNS } from '../ui/job-view.js';
import { normaliseSavedViews, SAVED_VIEW_PAGES } from '../ui/list-views.js';
import { normaliseNavPins } from '../ui/nav-pins.js';
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

const COLOR_MODES = ['light', 'dark', 'system'];

// A person's appearance as Flow stores it: only the known keys, each checked.
// A family Flow does not have, or a malformed accent, is dropped, so the page
// falls back to the installation's default.
export function normaliseAppearance(input) {
  const value = input && typeof input === 'object' ? input : {};
  const out = { colorMode: COLOR_MODES.includes(value.colorMode) ? value.colorMode : 'system' };
  if (isThemeFamily(value.themeFamily)) out.themeFamily = value.themeFamily;
  const accent = typeof value.accent === 'string' ? value.accent.trim().toLowerCase() : '';
  if (normalizeAccent(accent)) out.accent = accent;
  return out;
}

// Each person keeps their own appearance, so people who share a browser or
// move between devices each see theirs.
export async function setPersonAppearance(db, { id, appearance }) {
  const [row] = await db.update(people)
    .set({ appearance: normaliseAppearance(appearance), updatedAt: new Date() })
    .where(eq(people.id, id))
    .returning();
  if (!row) throw new FlowError('not_found', 'person not found');
  return row.appearance;
}

// The pages a person can keep their own view of, each with its check.
// Each page is named in a switch, never looked up by the name a request
// sends, so a name such as "constructor" can only be refused.
function viewCheck(page) {
  switch (page) {
    case 'jobs': return normaliseJobsView;
    case 'invoices': return invoiceColumnsView;
    case 'reconcile': return (view) => normaliseListView(view, RECONCILE_COLUMNS);
    case 'price-list': return (view) => normaliseListView(view, PRICE_COLUMNS);
    case 'nav': return normaliseNavPins;
    default: return null;
  }
}
const VIEW_PAGE_NAMES = ['jobs', 'invoices', 'reconcile', 'price-list', 'nav'];

// A person's saved views as Flow sends them: only the known pages, each
// checked, so a view saved by an older Flow still loads.
export function normaliseViews(input) {
  const value = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const page of VIEW_PAGE_NAMES) if (value[page]) out[page] = viewCheck(page)(value[page]);
  // The named views a person saved on each page, and their default
  // (ui/list-views.js), kept under `saved`.
  const saved = value.saved && typeof value.saved === 'object' ? value.saved : {};
  const lists = {};
  for (const page of SAVED_VIEW_PAGES) if (saved[page]) lists[page] = normaliseSavedViews(page, saved[page]);
  if (Object.keys(lists).length) out.saved = lists;
  return out;
}

// Each person keeps their own named views of a page and picks their
// default; saving one page's list leaves the other pages as they were.
export async function setPersonSavedViews(db, { id, page, saved }) {
  if (!SAVED_VIEW_PAGES.includes(page)) throw new FlowError('not_found', 'no such page');
  const value = normaliseSavedViews(page, saved);
  const [row] = await db.update(people)
    .set({
      views: sql`coalesce(${people.views}, '{}'::jsonb) || jsonb_build_object('saved', coalesce(${people.views}->'saved', '{}'::jsonb) || ${JSON.stringify({ [page]: value })}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(people.id, id))
    .returning();
  if (!row) throw new FlowError('not_found', 'person not found');
  return value;
}

// Each person keeps their own view of a page; saving one page leaves the
// others as they were.
export async function setPersonView(db, { id, page, view }) {
  const normalise = viewCheck(page);
  if (typeof normalise !== 'function') throw new FlowError('not_found', 'no such page');
  const value = normalise(view);
  const [row] = await db.update(people)
    .set({ views: sql`coalesce(${people.views}, '{}'::jsonb) || ${JSON.stringify({ [page]: value })}::jsonb`, updatedAt: new Date() })
    .where(eq(people.id, id))
    .returning();
  if (!row) throw new FlowError('not_found', 'person not found');
  return value;
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

// Fills a person's name from their sign-in account (Clerk) when Flow has
// none, so pickers show "Jane Citizen", not an email. A name Flow already
// holds stays.
export async function fillPersonName(db, { id, name }) {
  const value = String(name ?? '').trim();
  if (!value) return null;
  const [row] = await db.update(people)
    .set({ name: value, updatedAt: new Date() })
    .where(and(eq(people.id, id), isNull(people.name)))
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
