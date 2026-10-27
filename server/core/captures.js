import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { CAPTURE_DECISIONS, captures } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';

// A capture is one photo of a handwritten lab form (docs/DATA_MODEL.md,
// "Storage"). This slice does not call a model and does not change a job.
// A new capture is `ready` with an empty proposal. A person can type the
// proposal. Apply or Discard records that decision and deletes the photo.
// A capture nobody decides is deleted after 7 days, photo included.
//
// Nothing here writes the photo, the typed fields or a patient name to a log.
// Callers log a capture id and an error code only.

export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
export const CAPTURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const EMPTY_PROPOSAL = Object.freeze({ action: null, jobId: null, changes: [] });

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['update', 'create', 'note']);
const FIELD_MAX = 60;
const VALUE_MAX = 2000;
const CHANGES_MAX = 40;

const invalid = (message) => new FlowError('invalid', message);

export function readPhoto(bytes, contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const fileType = type === 'image/jpg' ? 'image/jpeg' : type;
  if (!PHOTO_TYPES.has(fileType)) throw new FlowError('unsupported_media', 'photo must be a jpeg, png, webp or heic');
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw invalid('photo is required');
  if (bytes.length > MAX_PHOTO_BYTES) throw new FlowError('photo_too_large', 'photo is too large');
  if (!looksLikePhoto(fileType, bytes)) throw new FlowError('not_a_photo', 'photo could not be read');
  return { fileType, fileSize: bytes.length, fileSha256: createHash('sha256').update(bytes).digest('hex') };
}

function looksLikePhoto(type, bytes) {
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = bytes.toString('ascii', 8, 12);
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'heif', 'mif1', 'msf1'].includes(brand);
}

export function readIdempotencyKey(raw) {
  const key = String(raw ?? '').trim();
  if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) throw invalid('idempotency key is required');
  return key;
}

export function readSource(raw) {
  const source = String(raw ?? 'api').trim().toLowerCase() || 'api';
  if (!['phone', 'desk', 'api'].includes(source)) throw invalid('source must be phone, desk or api');
  return source;
}

function readText(value, max) {
  if (typeof value !== 'string') throw invalid('a change must be text');
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid('a change is too long');
  return trimmed;
}

// What a person typed. The values are stored on the capture and returned to
// that person. They are not written to a log.
export function readProposal(input) {
  if (input == null) return { ...EMPTY_PROPOSAL, changes: [] };
  const action = input.action ?? null;
  if (action !== null && !ACTIONS.has(action)) throw invalid('action must be update, create or note');
  const jobId = input.jobId ?? null;
  if (jobId !== null && !UUID.test(String(jobId))) throw invalid('jobId must be a job id');
  if (!Array.isArray(input.changes)) throw invalid('changes must be a list');
  if (input.changes.length > CHANGES_MAX) throw invalid('too many changes');
  const changes = input.changes.map((change) => ({
    field: readText(change?.field, FIELD_MAX),
    from: readText(change?.from ?? '', VALUE_MAX),
    to: readText(change?.to ?? '', VALUE_MAX),
  }));
  if (changes.some((change) => !change.field)) throw invalid('a change needs a field');
  if (changes.length > 0 && !action) throw invalid('action is required');
  return { action, jobId, changes };
}

export function captureView(row, link = null) {
  return {
    id: row.id,
    organisationId: row.organisationId,
    state: row.state,
    source: row.source,
    fileType: row.fileType,
    fileSize: row.fileSize,
    fileSha256: row.fileSha256,
    proposal: row.proposal ?? { ...EMPTY_PROPOSAL, changes: [] },
    problem: row.problem,
    decision: row.decision,
    decidedAt: row.decidedAt,
    photoDeletedAt: row.photoDeletedAt,
    createdAt: row.createdAt,
    link,
  };
}

function linkFor(storage, row, baseUrl) {
  if (!row || row.photoDeletedAt) return null;
  return storage.signedLink({ key: row.fileKey, baseUrl });
}

async function byId(db, organisationId, id) {
  if (!UUID.test(String(id ?? ''))) throw notFound('capture');
  const [row] = await db.select().from(captures).where(and(
    eq(captures.organisationId, organisationId),
    eq(captures.id, id),
  ));
  if (!row) throw notFound('capture');
  return row;
}

async function byIdempotency(db, organisationId, idempotencyKey) {
  const [row] = await db.select().from(captures).where(and(
    eq(captures.organisationId, organisationId),
    eq(captures.idempotencyKey, idempotencyKey),
  ));
  return row ?? null;
}

// The first body stored for an idempotency key wins. A repeat upload, even
// with different bytes, returns that capture and stores nothing else. If the
// process stops after the bytes are stored and before the row is inserted,
// the object is orphaned: its key is a random id and it is not a capture.
export async function uploadCapture(db, storage, organisationId, {
  bytes, contentType, idempotencyKey, source = 'api', personId, baseUrl,
}) {
  const photo = readPhoto(bytes, contentType);
  const key = readIdempotencyKey(idempotencyKey);
  const from = readSource(source);
  const existing = await byIdempotency(db, organisationId, key);
  if (existing) return { capture: existing, created: false, link: linkFor(storage, existing, baseUrl) };

  const id = randomUUID();
  const fileKey = `captures/${String(organisationId).toLowerCase()}/${id}`;
  try {
    await storage.put({ key: fileKey, body: bytes, contentType: photo.fileType });
  } catch (error) {
    if (error instanceof FlowError) throw error;
    throw new FlowError('storage_unavailable', 'the photo could not be stored');
  }
  try {
    const [row] = await db.insert(captures).values({
      id,
      organisationId,
      state: 'ready',
      source: from,
      fileKey,
      fileType: photo.fileType,
      fileSize: photo.fileSize,
      fileSha256: photo.fileSha256,
      idempotencyKey: key,
      proposal: { ...EMPTY_PROPOSAL, changes: [] },
      createdBy: personId ?? null,
    }).onConflictDoNothing({ target: [captures.organisationId, captures.idempotencyKey] }).returning();
    if (row) return { capture: row, created: true, link: linkFor(storage, row, baseUrl) };
  } catch (error) {
    await storage.delete(fileKey).catch(() => {});
    if (error instanceof FlowError) throw error;
    throw new FlowError('storage_unavailable', 'the photo could not be stored');
  }
  // Another request stored this key first. Drop the bytes we just wrote.
  // Their key is this attempt's id, not the winner's.
  await storage.delete(fileKey).catch(() => {});
  const winner = await byIdempotency(db, organisationId, key);
  if (!winner) throw new FlowError('conflict', 'this upload was already stored');
  return { capture: winner, created: false, link: linkFor(storage, winner, baseUrl) };
}

export async function readCapture(db, storage, organisationId, id, baseUrl) {
  const row = await byId(db, organisationId, id);
  return { capture: row, link: linkFor(storage, row, baseUrl) };
}

export async function typeProposal(db, storage, organisationId, id, input, { baseUrl } = {}) {
  const proposal = readProposal(input);
  await byId(db, organisationId, id);
  const [row] = await db.update(captures).set({
    state: 'ready',
    problem: null,
    proposal,
    updatedAt: sql`now()`,
  }).where(and(
    eq(captures.organisationId, organisationId),
    eq(captures.id, id),
    sql`${captures.state} in ('ready', 'problem')`,
  )).returning();
  if (!row) throw new FlowError('conflict', 'this capture is not ready');
  return { capture: row, link: linkFor(storage, row, baseUrl) };
}

async function deletePhoto(db, storage, row) {
  if (row.photoDeletedAt) return row;
  try {
    await storage.delete(row.fileKey);
  } catch (error) {
    const failure = error instanceof FlowError ? error : new FlowError('storage_unavailable', 'the photo could not be deleted');
    failure.captureId = row.id;
    if (!failure.code) failure.code = 'storage_unavailable';
    throw failure;
  }
  const [next] = await db.update(captures).set({
    photoDeletedAt: sql`now()`,
    updatedAt: sql`now()`,
  }).where(and(
    eq(captures.organisationId, row.organisationId),
    eq(captures.id, row.id),
    isNull(captures.photoDeletedAt),
  )).returning();
  return next ?? row;
}

// Records the person's decision and deletes the photo. It does not change a
// job: matching and applying a change are later slices. The same decision
// again deletes the photo if that was still waiting.
export async function decideCapture(db, storage, organisationId, id, decision, { personId, baseUrl } = {}) {
  if (!CAPTURE_DECISIONS.includes(decision)) throw invalid('decision must be applied or discarded');
  const current = await byId(db, organisationId, id);
  if (current.state === 'done') {
    if (current.decision !== decision) throw new FlowError('conflict', 'this capture already has a decision');
    const row = await deletePhoto(db, storage, current);
    return { capture: row, link: null };
  }
  if (current.state !== 'ready') throw new FlowError('conflict', 'this capture is not ready');
  const [row] = await db.update(captures).set({
    state: 'done',
    decision,
    decidedBy: personId ?? null,
    decidedAt: sql`now()`,
    updatedAt: sql`now()`,
  }).where(and(
    eq(captures.organisationId, organisationId),
    eq(captures.id, id),
    eq(captures.state, 'ready'),
  )).returning();
  if (!row) {
    const again = await byId(db, organisationId, id);
    if (again.state === 'done' && again.decision === decision) {
      return { capture: await deletePhoto(db, storage, again), link: null };
    }
    throw new FlowError('conflict', again.state === 'done' ? 'this capture already has a decision' : 'this capture is not ready');
  }
  const deleted = await deletePhoto(db, storage, row);
  return { capture: deleted, link: null };
}

// Serves a signed Flow link. The checksum is checked before any byte is
// returned. An S3 link is not served here; S3 honours that URL itself.
export async function readCapturePhoto(db, storage, token) {
  const opened = storage.openLink(String(token ?? ''));
  if (!opened.ok) {
    const error = new FlowError(opened.code, opened.code === 'link_expired' ? 'this link has expired' : 'this link is not valid');
    throw error;
  }
  const [row] = await db.select().from(captures).where(eq(captures.fileKey, opened.key));
  if (!row || row.photoDeletedAt) throw notFound('photo');
  let stored;
  try {
    stored = await storage.get(row.fileKey);
  } catch (error) {
    const failure = error instanceof FlowError ? error : new FlowError('storage_unavailable', 'the file store could not be reached');
    failure.captureId = row.id;
    throw failure;
  }
  if (!stored) throw notFound('photo');
  const sha = createHash('sha256').update(stored.body).digest('hex');
  if (sha !== row.fileSha256) {
    const error = new FlowError('hash_mismatch', 'the photo did not match its record');
    error.captureId = row.id;
    throw error;
  }
  return { body: stored.body, contentType: row.fileType, captureId: row.id };
}

// Deletes photos that are still here after a decision, and deletes captures
// that nobody decided and that are older than the retention window. A delete
// that fails leaves the row, so the next pass tries again. Two passes at once
// are safe: deleting a missing object and deleting a row that is already gone
// both do nothing.
export async function sweepCaptures(db, storage, { now = new Date(), retentionMs = CAPTURE_RETENTION_MS, limit = 100 } = {}) {
  const cutoff = new Date(now.getTime() - retentionMs);
  const open = { id: captures.id, organisationId: captures.organisationId, fileKey: captures.fileKey };
  const stale = await db.select(open).from(captures).where(and(
    isNull(captures.decision),
    isNull(captures.photoDeletedAt),
    lt(captures.createdAt, cutoff),
  )).limit(limit);
  const failed = [];
  let removed = 0;
  for (const row of stale) {
    try {
      await storage.delete(row.fileKey);
      await db.delete(captures).where(and(
        eq(captures.organisationId, row.organisationId),
        eq(captures.id, row.id),
        isNull(captures.decision),
      ));
      removed += 1;
    } catch {
      failed.push(row.id);
    }
  }
  const stuck = await db.select(open).from(captures).where(and(
    isNotNull(captures.decision),
    isNull(captures.photoDeletedAt),
  )).limit(limit);
  let photos = 0;
  for (const row of stuck) {
    try {
      await storage.delete(row.fileKey);
      await db.update(captures).set({ photoDeletedAt: sql`now()`, updatedAt: sql`now()` }).where(and(
        eq(captures.organisationId, row.organisationId),
        eq(captures.id, row.id),
        isNull(captures.photoDeletedAt),
      ));
      photos += 1;
    } catch {
      failed.push(row.id);
    }
  }
  return { removed, photos, failed };
}

export function createCaptureRetentionWorker({
  db, storage, log = console, retentionMs = CAPTURE_RETENTION_MS, everyMs = 60 * 60 * 1000, firstDelayMs = 60_000,
  timers = globalThis,
}) {
  let timer = null;
  let stopped = true;
  let running = null;

  async function tick() {
    try {
      const result = await sweepCaptures(db, storage, { retentionMs });
      for (const id of result.failed) log.error?.(`[captures] ${id} storage_unavailable`);
    } catch {
      log.error?.('[captures] - sweep_failed');
    }
  }

  function schedule(delay) {
    if (stopped) return;
    timer = timers.setTimeout(async () => {
      timer = null;
      running = tick();
      await running;
      running = null;
      schedule(everyMs);
    }, delay);
    timer?.unref?.();
  }

  return {
    start() {
      stopped = false;
      schedule(firstDelayMs);
    },
    async stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}
