import { and, desc, eq } from 'drizzle-orm';
import { auditEvents } from '../db/schema.js';

// One append-only row per read or change of practice data (issue #363).
// The database trigger refuses updates and deletes.

const ACTIONS = new Set(['read', 'create', 'change', 'delete', 'download']);
const ACTORS = new Set(['member', 'person', 'anonymous']);

export async function recordAudit(db, {
  organisationId,
  actorKind,
  actorId = null,
  practiceContactId = null,
  action,
  recordType,
  recordId = null,
  ip = null,
}) {
  if (!ACTORS.has(actorKind)) throw new Error(`audit actor: ${actorKind}`);
  if (!ACTIONS.has(action)) throw new Error(`audit action: ${action}`);
  const [row] = await db.insert(auditEvents).values({
    organisationId,
    actorKind,
    actorId,
    practiceContactId,
    action,
    recordType: String(recordType).slice(0, 40),
    recordId: recordId == null ? null : String(recordId).slice(0, 80),
    ip: ip == null ? null : String(ip).slice(0, 64),
  }).returning();
  return row;
}

export async function listAuditEvents(db, organisationId, contactId, { limit = 50 } = {}) {
  return db.select().from(auditEvents).where(and(
    eq(auditEvents.organisationId, organisationId),
    eq(auditEvents.practiceContactId, contactId),
  )).orderBy(desc(auditEvents.createdAt)).limit(limit);
}

export function publicAuditEvent(row) {
  return {
    id: row.id,
    actorKind: row.actorKind,
    actorId: row.actorId,
    action: row.action,
    recordType: row.recordType,
    recordId: row.recordId,
    at: row.createdAt,
  };
}
