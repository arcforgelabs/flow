import { and, eq, sql } from 'drizzle-orm';
import { FlowError } from '../core/errors.js';
import { permissionEvents, PERSON_ROLES, personPermissions, rolePermissions } from '../db/schema.js';
import { findPersonById } from './people.js';

// What a person may do, besides being signed in. One list for the server and
// the Settings page (docs/PERMISSIONS.md). A fresh installation has no rows:
// each role's answer is the default below, which is today's role gates
// (owner and admin do the manager actions, staff do none, and only an owner
// connects an integration or manages people).

export const PERMISSIONS = Object.freeze([
  { key: 'invoices.send', label: 'Send', group: 'Invoices' },
  { key: 'invoices.approve', label: 'Approve', group: 'Invoices' },
  { key: 'invoices.void', label: 'Void', group: 'Invoices' },
  { key: 'invoices.draft', label: 'Draft', group: 'Invoices' },
  { key: 'priceList.edit', label: 'Edit', group: 'Price list' },
  { key: 'rules.edit', label: 'Edit', group: 'Rules' },
  { key: 'customFields.edit', label: 'Edit', group: 'Fields' },
  { key: 'integrations.run', label: 'Run', group: 'Integrations' },
  { key: 'integrations.connect', label: 'Connect', group: 'Integrations' },
  // Not on the grid and not grantable. The people routes stay owner-only.
  { key: 'people.manage', label: 'People', group: 'People', locked: true },
]);

const BY_KEY = new Map(PERMISSIONS.map((permission) => [permission.key, permission]));
const LOCKED = new Set(PERMISSIONS.filter((permission) => permission.locked).map((permission) => permission.key));

// Owner and admin: every key except the two that stay with the owner.
// Staff: none. This is the whole of today's access.
function defaultsFor(role) {
  const ownerOnly = role === 'owner';
  const manager = role === 'owner' || role === 'admin';
  return Object.fromEntries(PERMISSIONS.map((permission) => [
    permission.key,
    permission.locked || permission.key === 'integrations.connect' ? ownerOnly : manager,
  ]));
}

export const ROLE_DEFAULTS = Object.freeze({
  owner: Object.freeze(defaultsFor('owner')),
  admin: Object.freeze(defaultsFor('admin')),
  staff: Object.freeze(defaultsFor('staff')),
});

export function permissionGroups() {
  const groups = [];
  for (const permission of PERMISSIONS) {
    if (permission.locked) continue;
    let group = groups.find((item) => item.label === permission.group);
    if (!group) {
      group = { label: permission.group, permissions: [] };
      groups.push(group);
    }
    group.permissions.push({ key: permission.key, label: permission.label });
  }
  return groups;
}

function known(key) {
  if (!BY_KEY.has(key)) throw new FlowError('invalid', 'Unknown permission.');
  return BY_KEY.get(key);
}

// The answer for one person and one key. `roleAllowed` null means no role
// row (use the default). `personEffect` null means inherit. A person allow
// or deny beats the role. The owner role cannot be turned off. people.manage
// is the owner role and nothing else, whatever the rows say.
export function resolvePermission(person, key, { roleAllowed = null, personEffect = null } = {}) {
  if (!BY_KEY.has(key)) return false;
  const role = person?.role;
  if (!ROLE_DEFAULTS[role]) return false;
  if (LOCKED.has(key)) return role === 'owner';
  if (personEffect === 'deny') return false;
  if (personEffect === 'allow') return true;
  if (role === 'owner') return true;
  if (typeof roleAllowed === 'boolean') return roleAllowed;
  return ROLE_DEFAULTS[role][key];
}

function word(allowed) {
  return allowed ? 'allow' : 'deny';
}

export async function permissionsFor(db, person) {
  const roleRows = await db.select().from(rolePermissions).where(eq(rolePermissions.role, person.role));
  const ownRows = await db.select().from(personPermissions).where(eq(personPermissions.personId, person.id));
  const roleAllowed = new Map(roleRows.map((row) => [row.key, row.allowed]));
  const effects = new Map(ownRows.map((row) => [row.key, row.effect]));
  return Object.fromEntries(PERMISSIONS.map((permission) => [permission.key, resolvePermission(person, permission.key, {
    roleAllowed: roleAllowed.has(permission.key) ? roleAllowed.get(permission.key) : null,
    personEffect: effects.get(permission.key) ?? null,
  })]));
}

export async function can(db, person, key) {
  if (!person || !BY_KEY.has(key)) return false;
  const granted = await permissionsFor(db, person);
  return Boolean(granted[key]);
}

export async function roleGrantMap(db) {
  const rows = await db.select().from(rolePermissions);
  const byRole = new Map();
  for (const row of rows) {
    if (!byRole.has(row.role)) byRole.set(row.role, new Map());
    byRole.get(row.role).set(row.key, row.allowed);
  }
  const grants = {};
  for (const role of PERSON_ROLES) {
    const stored = byRole.get(role) ?? new Map();
    grants[role] = {};
    for (const permission of PERMISSIONS) {
      if (permission.locked) continue;
      grants[role][permission.key] = resolvePermission({ role }, permission.key, {
        roleAllowed: stored.has(permission.key) ? stored.get(permission.key) : null,
      });
    }
  }
  return grants;
}

export async function personPermissionView(db, person) {
  const roleRows = await db.select().from(rolePermissions).where(eq(rolePermissions.role, person.role));
  const ownRows = await db.select().from(personPermissions).where(eq(personPermissions.personId, person.id));
  const roleAllowed = new Map(roleRows.map((row) => [row.key, row.allowed]));
  const effects = new Map(ownRows.map((row) => [row.key, row.effect]));
  return PERMISSIONS.filter((permission) => !permission.locked).map((permission) => ({
    key: permission.key,
    label: permission.label,
    group: permission.group,
    effect: effects.get(permission.key) ?? 'inherit',
    effective: resolvePermission(person, permission.key, {
      roleAllowed: roleAllowed.has(permission.key) ? roleAllowed.get(permission.key) : null,
      personEffect: effects.get(permission.key) ?? null,
    }),
  }));
}

// A role switch. Setting the default removes the row, so a fresh install and
// a reset look the same. The owner column cannot be turned off, and
// people.manage cannot be changed.
export async function setRolePermission(db, { role, key, allowed, actorId }) {
  known(key);
  if (!PERSON_ROLES.includes(role)) throw new FlowError('invalid', 'role must be owner, admin or staff');
  if (typeof allowed !== 'boolean') throw new FlowError('invalid', 'allowed must be true or false');
  if (LOCKED.has(key)) throw new FlowError('forbidden', 'People stays with the owner.');
  if (role === 'owner' && !allowed) throw new FlowError('forbidden', 'The owner role stays allowed.');
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(rolePermissions)
      .where(and(eq(rolePermissions.role, role), eq(rolePermissions.key, key)));
    const before = resolvePermission({ role }, key, { roleAllowed: row ? row.allowed : null });
    if (before === allowed) return { changed: false, allowed: before };
    const where = and(eq(rolePermissions.role, role), eq(rolePermissions.key, key));
    if (allowed === ROLE_DEFAULTS[role][key]) {
      if (row) await tx.delete(rolePermissions).where(where);
    } else {
      await tx.insert(rolePermissions).values({ role, key, allowed, updatedBy: actorId })
        .onConflictDoUpdate({ target: [rolePermissions.role, rolePermissions.key], set: { allowed, updatedBy: actorId, updatedAt: sql`now()` } });
    }
    await tx.insert(permissionEvents).values({
      actorId, targetRole: role, key, fromValue: word(before), toValue: word(allowed),
    });
    return { changed: true, allowed };
  });
}

// Inherit, allow or deny for one person. Inherit removes the row.
export async function setPersonPermission(db, { personId, key, effect, actorId }) {
  known(key);
  if (!['allow', 'deny', 'inherit'].includes(effect)) throw new FlowError('invalid', 'effect must be allow, deny or inherit');
  if (LOCKED.has(key)) throw new FlowError('forbidden', 'People stays with the owner.');
  const person = await findPersonById(db, personId);
  if (!person) throw new FlowError('not_found', 'person not found');
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(personPermissions)
      .where(and(eq(personPermissions.personId, personId), eq(personPermissions.key, key)));
    const current = row?.effect ?? 'inherit';
    if (current === effect) return { changed: false, effect };
    const where = and(eq(personPermissions.personId, personId), eq(personPermissions.key, key));
    if (effect === 'inherit') {
      if (row) await tx.delete(personPermissions).where(where);
    } else {
      await tx.insert(personPermissions).values({ personId, key, effect, updatedBy: actorId })
        .onConflictDoUpdate({
          target: [personPermissions.personId, personPermissions.key],
          set: { effect, updatedBy: actorId, updatedAt: sql`now()` },
        });
    }
    await tx.insert(permissionEvents).values({
      actorId, targetPersonId: personId, key, fromValue: current, toValue: effect,
    });
    return { changed: true, effect };
  });
}
