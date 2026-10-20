import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { CUSTOM_FIELD_TYPES, jobFieldEvents, jobFields, jobFieldValues, people } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';

// Custom fields (docs/CUSTOM_FIELDS.md): fields a lab makes for its jobs in
// Flow, like ClickUp's custom fields. An owner or admin makes them in
// Settings, Custom fields; everyone can set a job's value. A job is the work
// system's job (sourceSystem, sourceJobRef). A value lives only in Flow: a
// change never writes to the work system or the accounting system.

export { CUSTOM_FIELD_TYPES };
// The types that make lanes on the Jobs board: one lane per option, per
// person, or yes and no.
export const GROUPABLE_TYPES = ['dropdown', 'person', 'checkbox'];
export const OPTION_COLORS = ['gray', 'blue', 'teal', 'green', 'amber', 'red', 'purple', 'pink'];

const MAX_FIELDS = 50;
const MAX_OPTIONS = 50;
const MAX_NAME = 60;
const MAX_OPTION_NAME = 40;
const MAX_TEXT = 500;
const MAX_NUMBER = 1e12;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM = /^[a-z][a-z0-9-]{1,31}$/;

const invalid = (message) => new FlowError('invalid', message);

function readName(raw, what, max) {
  if (typeof raw !== 'string' || !raw.trim()) throw invalid(`${what} is required`);
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length > max) throw invalid(`${what} is too long (${max} characters at most)`);
  return name;
}

// A dropdown's options as a person sends them: [{ id?, name, color? }], in
// lane order. An option with no id is new. An earlier option that is not in
// the list is kept as archived, so its old values still read.
export function readOptions(raw, previous = []) {
  if (!Array.isArray(raw)) throw invalid('options must be a list');
  if (!raw.length) throw invalid('a dropdown needs at least one option');
  if (raw.length > MAX_OPTIONS) throw invalid(`a dropdown has ${MAX_OPTIONS} options at most`);
  const known = new Map(previous.map((o) => [o.id, o]));
  const names = new Set();
  const active = raw.map((option, i) => {
    if (!option || typeof option !== 'object') throw invalid(`option ${i + 1} must be an object`);
    const name = readName(option.name, `option ${i + 1} name`, MAX_OPTION_NAME);
    const key = name.toLowerCase();
    if (names.has(key)) throw invalid(`two options are named ${name}`);
    names.add(key);
    const color = option.color === undefined || option.color === null ? 'gray' : option.color;
    if (!OPTION_COLORS.includes(color)) throw invalid(`option ${name}: color must be one of ${OPTION_COLORS.join(', ')}`);
    if (option.id !== undefined && option.id !== null) {
      if (!known.has(option.id)) throw invalid(`option ${name}: unknown id`);
      return { id: option.id, name, color };
    }
    return { id: randomUUID(), name, color };
  });
  const kept = new Set(active.map((o) => o.id));
  const archived = previous.filter((o) => !kept.has(o.id)).map((o) => ({ ...o, archived: true }));
  return [...active, ...archived];
}

// A new field, or the part of one a person changes. The type is fixed once
// the field exists.
export function readField(raw, { partial = false, previous = null } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (!partial || input.name !== undefined) out.name = readName(input.name, 'name', MAX_NAME);
  if (!partial) {
    if (!CUSTOM_FIELD_TYPES.includes(input.type)) throw invalid(`type must be one of ${CUSTOM_FIELD_TYPES.join(', ')}`);
    out.type = input.type;
  } else if (input.type !== undefined && input.type !== previous?.type) {
    throw invalid('the type of a field cannot change; make a new field instead');
  }
  const type = out.type ?? previous?.type;
  if (type === 'dropdown' && (!partial || input.options !== undefined)) out.options = readOptions(input.options, previous?.options ?? []);
  else if (type !== 'dropdown' && input.options !== undefined && input.options !== null && !(Array.isArray(input.options) && !input.options.length)) {
    throw invalid('only a dropdown has options');
  }
  return out;
}

export const publicField = (row) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  options: row.options ?? [],
  position: row.position,
  groupable: GROUPABLE_TYPES.includes(row.type),
  archived: Boolean(row.archivedAt),
  createdBy: row.createdBy ?? null,
  createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
  updatedAt: row.updatedAt?.toISOString?.() ?? row.updatedAt,
});

export async function listFields(db, organisationId, { archived = false } = {}) {
  const where = [eq(jobFields.organisationId, organisationId)];
  if (!archived) where.push(isNull(jobFields.archivedAt));
  const rows = await db.select().from(jobFields).where(and(...where)).orderBy(asc(jobFields.position), asc(jobFields.createdAt));
  return rows.map(publicField);
}

async function readRow(db, organisationId, id) {
  if (!UUID.test(id ?? '')) throw notFound('field');
  const [row] = await db.select().from(jobFields).where(and(eq(jobFields.organisationId, organisationId), eq(jobFields.id, id)));
  if (!row) throw notFound('field');
  return row;
}

async function checkNameFree(db, organisationId, name, exceptId = null) {
  const rows = await db.select({ id: jobFields.id }).from(jobFields).where(and(
    eq(jobFields.organisationId, organisationId), isNull(jobFields.archivedAt),
    sql`lower(${jobFields.name}) = ${name.toLowerCase()}`,
  ));
  if (rows.some((r) => r.id !== exceptId)) throw new FlowError('conflict', `a field named ${name} already exists`);
}

export async function createField(db, organisationId, raw, { personId = null } = {}) {
  const field = readField(raw);
  return db.transaction(async (tx) => {
    const [{ count, last }] = await tx.select({
      count: sql`count(*) filter (where ${jobFields.archivedAt} is null)`.mapWith(Number),
      last: sql`coalesce(max(${jobFields.position}), -1)`.mapWith(Number),
    }).from(jobFields).where(eq(jobFields.organisationId, organisationId));
    if (count >= MAX_FIELDS) throw invalid(`an organisation has ${MAX_FIELDS} fields at most`);
    await checkNameFree(tx, organisationId, field.name);
    const [row] = await tx.insert(jobFields).values({
      organisationId, ...field, options: field.options ?? [], position: last + 1, createdBy: personId, updatedBy: personId,
    }).returning();
    return publicField(row);
  });
}

// Every lab gets an Assignee: a person field, made once, the first time
// the lab's fields are read and it has no person field at all (live or
// archived). The lab can then rename it or archive it like any field, and
// Flow does not make it again. A field already named Assignee of another
// type is left alone.
export const ASSIGNEE = { name: 'Assignee', type: 'person' };
export async function ensureAssignee(db, organisationId) {
  const [{ count }] = await db.select({ count: sql`count(*)`.mapWith(Number) }).from(jobFields)
    .where(and(eq(jobFields.organisationId, organisationId), eq(jobFields.type, 'person')));
  if (count > 0) return null;
  try {
    return await createField(db, organisationId, ASSIGNEE);
  } catch (error) {
    if (error.code === 'conflict' || error.code === 'invalid' || error.code === '23505') return null;
    throw error;
  }
}

export async function updateField(db, organisationId, id, raw, { personId = null } = {}) {
  const previous = await readRow(db, organisationId, id);
  if (previous.archivedAt) throw new FlowError('conflict', 'the field is archived; bring it back first');
  const change = readField(raw, { partial: true, previous });
  if (change.name) await checkNameFree(db, organisationId, change.name, id);
  const [row] = await db.update(jobFields).set({ ...change, updatedBy: personId, updatedAt: new Date() })
    .where(and(eq(jobFields.organisationId, organisationId), eq(jobFields.id, id))).returning();
  return publicField(row);
}

// Archive a field, or bring it back. Its values stay, so bringing it back
// restores them.
export async function archiveField(db, organisationId, id, { archived = true, personId = null } = {}) {
  const previous = await readRow(db, organisationId, id);
  if (!archived) await checkNameFree(db, organisationId, previous.name, id);
  const [row] = await db.update(jobFields).set({ archivedAt: archived ? new Date() : null, updatedBy: personId, updatedAt: new Date() })
    .where(and(eq(jobFields.organisationId, organisationId), eq(jobFields.id, id))).returning();
  return publicField(row);
}

// Put the fields in this order. `ids` lists every field that is not archived.
export async function orderFields(db, organisationId, ids, { personId = null } = {}) {
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw invalid('ids must be a list of field ids');
  const current = await listFields(db, organisationId);
  const want = new Set(ids);
  if (want.size !== ids.length || current.length !== ids.length || current.some((f) => !want.has(f.id))) {
    throw invalid('ids must list every field that is not archived, once each');
  }
  await db.transaction(async (tx) => {
    for (const [position, id] of ids.entries()) {
      await tx.update(jobFields).set({ position, updatedBy: personId, updatedAt: new Date() })
        .where(and(eq(jobFields.organisationId, organisationId), eq(jobFields.id, id)));
    }
  });
  return listFields(db, organisationId);
}

function readJob(raw) {
  const sourceSystem = typeof raw?.sourceSystem === 'string' ? raw.sourceSystem.trim() : '';
  const sourceJobRef = typeof raw?.sourceJobRef === 'string' ? raw.sourceJobRef.trim() : '';
  if (!SYSTEM.test(sourceSystem)) throw invalid('sourceSystem must be an integration id');
  if (!sourceJobRef || sourceJobRef.length > 200) throw invalid('sourceJobRef is required (200 characters at most)');
  return { sourceSystem, sourceJobRef };
}

function isRealDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// A value checked against its field. null clears the value.
export async function readValue(db, field, raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (field.type) {
    case 'dropdown': {
      const option = (field.options ?? []).find((o) => o.id === raw && !o.archived);
      if (!option) throw invalid(`${field.name}: choose one of its options`);
      return option.id;
    }
    case 'person': {
      if (typeof raw !== 'string' || !UUID.test(raw)) throw invalid(`${field.name}: choose a person`);
      const [row] = await db.select({ id: people.id }).from(people).where(and(eq(people.id, raw), eq(people.status, 'active')));
      if (!row) throw invalid(`${field.name}: that person cannot be chosen`);
      return row.id;
    }
    case 'checkbox':
      if (typeof raw !== 'boolean') throw invalid(`${field.name} must be true or false`);
      return raw;
    case 'date':
      if (!isRealDate(raw)) throw invalid(`${field.name} must be a date, YYYY-MM-DD`);
      return raw;
    case 'number':
      if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) >= MAX_NUMBER) throw invalid(`${field.name} must be a number`);
      return raw;
    default:
      if (typeof raw !== 'string') throw invalid(`${field.name} must be text`);
      if (raw.length > MAX_TEXT) throw invalid(`${field.name} is too long (${MAX_TEXT} characters at most)`);
      return raw.trim() || null;
  }
}

const publicValue = (row) => ({
  fieldId: row.fieldId,
  sourceSystem: row.sourceSystem,
  sourceJobRef: row.sourceJobRef,
  value: row.value,
  updatedBy: row.updatedBy ?? null,
  updatedAt: row.updatedAt?.toISOString?.() ?? row.updatedAt,
});

// Set one job's value for one field, as a drag between lanes does.
// `expectedUpdatedAt` is the updatedAt of the value the person last saw
// (null when they saw none). When someone changed it since, nothing changes
// and the error carries the current value, so the board can show it.
export async function setJobFieldValue(db, organisationId, raw, { personId = null } = {}) {
  const job = readJob(raw);
  const field = await readRow(db, organisationId, raw?.fieldId);
  if (field.archivedAt) throw new FlowError('conflict', 'the field is archived');
  const value = await readValue(db, field, raw?.value);
  const checkVersion = raw && Object.hasOwn(raw, 'expectedUpdatedAt');
  const expected = checkVersion && raw.expectedUpdatedAt ? new Date(raw.expectedUpdatedAt) : null;
  if (expected && Number.isNaN(expected.getTime())) throw invalid('expectedUpdatedAt must be a time');
  const key = and(
    eq(jobFieldValues.organisationId, organisationId), eq(jobFieldValues.fieldId, field.id),
    eq(jobFieldValues.sourceSystem, job.sourceSystem), eq(jobFieldValues.sourceJobRef, job.sourceJobRef),
  );
  return db.transaction(async (tx) => {
    // One change at a time per job and field, also while no row exists yet.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${organisationId}:${field.id}:${job.sourceSystem}:${job.sourceJobRef}`}))`);
    const [current] = await tx.select().from(jobFieldValues).where(key);
    if (checkVersion) {
      const seen = current?.updatedAt?.getTime() ?? null;
      if (seen !== (expected?.getTime() ?? null)) {
        throw new FlowError('conflict', 'someone changed this value since you saw it', { current: current ? publicValue(current) : null });
      }
    }
    const from = current?.value ?? null;
    if (JSON.stringify(from) === JSON.stringify(value)) return current ? publicValue(current) : { fieldId: field.id, ...job, value: null, updatedBy: null, updatedAt: null };
    let saved = null;
    if (value === null) {
      await tx.delete(jobFieldValues).where(key);
    } else {
      [saved] = await tx.insert(jobFieldValues).values({ organisationId, fieldId: field.id, ...job, value, updatedBy: personId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [jobFieldValues.organisationId, jobFieldValues.fieldId, jobFieldValues.sourceSystem, jobFieldValues.sourceJobRef],
          set: { value, updatedBy: personId, updatedAt: new Date() },
        }).returning();
    }
    await tx.insert(jobFieldEvents).values({ organisationId, fieldId: field.id, ...job, fromValue: from, toValue: value, actor: personId });
    return saved ? publicValue(saved) : { fieldId: field.id, ...job, value: null, updatedBy: personId, updatedAt: null };
  });
}

// Every value of the fields that are not archived, optionally for some jobs
// only (`jobs`: [{ sourceSystem, sourceJobRef }]).
export async function listJobFieldValues(db, organisationId, { jobs = null } = {}) {
  const where = [eq(jobFieldValues.organisationId, organisationId), isNull(jobFields.archivedAt)];
  if (jobs) {
    if (!jobs.length) return [];
    const refs = [...new Set(jobs.map((j) => j.sourceJobRef))];
    where.push(inArray(jobFieldValues.sourceJobRef, refs));
  }
  const rows = await db.select({
    fieldId: jobFieldValues.fieldId, sourceSystem: jobFieldValues.sourceSystem, sourceJobRef: jobFieldValues.sourceJobRef,
    value: jobFieldValues.value, updatedBy: jobFieldValues.updatedBy, updatedAt: jobFieldValues.updatedAt,
  }).from(jobFieldValues)
    .innerJoin(jobFields, and(eq(jobFields.organisationId, jobFieldValues.organisationId), eq(jobFields.id, jobFieldValues.fieldId)))
    .where(and(...where));
  const wanted = jobs ? new Set(jobs.map((j) => `${j.sourceSystem}\u0000${j.sourceJobRef}`)) : null;
  return rows.filter((r) => !wanted || wanted.has(`${r.sourceSystem}\u0000${r.sourceJobRef}`)).map(publicValue);
}

// The people a person field can name: every active person, by id and name
// (the part of the email before @ when they have no name), A to Z.
export async function choosablePeople(db) {
  const rows = await db.select({ id: people.id, name: people.name, email: people.email }).from(people).where(eq(people.status, 'active'));
  return rows.map((r) => ({ id: r.id, name: r.name?.trim() || r.email.replace(/@.*/, '') }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// What happened to one job's custom field values, newest first.
export async function jobFieldHistory(db, organisationId, raw, { limit = 50 } = {}) {
  const job = readJob(raw);
  const rows = await db.select().from(jobFieldEvents).where(and(
    eq(jobFieldEvents.organisationId, organisationId),
    eq(jobFieldEvents.sourceSystem, job.sourceSystem), eq(jobFieldEvents.sourceJobRef, job.sourceJobRef),
  )).orderBy(sql`${jobFieldEvents.createdAt} desc`).limit(limit);
  return rows.map((r) => ({
    fieldId: r.fieldId, from: r.fromValue, to: r.toValue, actor: r.actor ?? null,
    at: r.createdAt?.toISOString?.() ?? r.createdAt,
  }));
}
