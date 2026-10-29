import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { callCostMicros } from './ai.js';
import { captures, jobFields } from '../db/schema.js';
import { FlowError } from './errors.js';
import { enqueueJob, runNextJob } from './queue.js';
import { JOB_FIELDS } from '../ui/capture-fields.js';

// The vision reader. A small model reads every capture. A larger model reads
// again only when case number, practice or work is below the sure line.
// Flow code decides that; the model does not see the jobs list and does not
// write. The photo and the fields stay out of the log: a failure is a
// capture id and an error code.
//
// A failed call is tried twice more (three calls). The capture is then
// `problem` with a short reason. Type it still works. The module being off,
// or the keys missing, is "reader turned off" and is set when the photo is
// stored (server/core/captures.js), not here.

export const CAPTURE_READ_KIND = 'capture.read';
const CALLS = 3;
const VALUE_MAX = 2000;


const NEEDED = new Set(JOB_FIELDS.filter((field) => field.needed).map((field) => field.key));

// One object, every property required. Bedrock rejects a schema that leaves
// a property optional past its limit, or that omits additionalProperties: false.
const FIELD_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          seen: { type: 'string' },
          sure: { type: 'number' },
        },
        required: ['key', 'value', 'seen', 'sure'],
        additionalProperties: false,
      },
    },
  },
  required: ['fields'],
  additionalProperties: false,
});

const PROBLEM = new Set([
  'the reader did not answer',
  'could not read the form',
  'photo type cannot be read',
  'the photo is missing',
]);

const READABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function problemText(error) {
  return PROBLEM.has(error?.message) ? error.message : 'the reader did not answer';
}

function blank(key) {
  return { key, value: '', seen: '', sure: 0 };
}

function clip(value) {
  return value.trim().slice(0, VALUE_MAX);
}

function sureOf(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

// One field per key the lab asked for, in that order. A key that was not
// asked for is dropped, so a patient name the model adds is not stored.
// A value that is not text is empty: an unreadable field is never a guess.
function parseFields(text, fieldList) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const error = new FlowError('reader_unreadable', 'could not read the form');
    error.retry = true;
    throw error;
  }
  const rows = Array.isArray(parsed?.fields) ? parsed.fields : null;
  if (!rows) {
    const error = new FlowError('reader_unreadable', 'could not read the form');
    error.retry = true;
    throw error;
  }
  const byKey = new Map();
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || !row.key) continue;
    if (typeof row.value !== 'string' || typeof row.seen !== 'string') {
      byKey.set(row.key, blank(row.key));
      continue;
    }
    byKey.set(row.key, { key: row.key, value: clip(row.value), seen: clip(row.seen), sure: sureOf(row.sure) });
  }
  return fieldList.map((field) => byKey.get(field.key) ?? blank(field.key));
}

function belowLine(fields, line) {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  for (const key of NEEDED) {
    if ((byKey.get(key)?.sure ?? 0) < line) return true;
  }
  return false;
}

function recorded(fields, calls, model = calls.at(-1).model) {
  const inputTokens = calls.reduce((sum, call) => sum + call.inputTokens, 0);
  const outputTokens = calls.reduce((sum, call) => sum + call.outputTokens, 0);
  const costMicros = calls.some((call) => call.costMicros == null)
    ? null
    : calls.reduce((sum, call) => sum + call.costMicros, 0);
  return { fields, model, inputTokens, outputTokens, costMicros, calls };
}

function instructionFor(fieldList) {
  const lines = fieldList.map((field) => `- ${field.key}: ${field.label}`).join('\n');
  return [
    'Read this photo of a handwritten lab form.',
    'Return one field for each key below.',
    'value is what should be stored. Use an empty string when you cannot read it. Never guess a name, a number or a date.',
    'seen is the exact text you saw, or an empty string when nothing was written.',
    'sure is a number from 0 to 1: how sure you are that value matches what was written.',
    'Ignore printed lab branding.',
    'Do not add a key that is not in this list.',
    lines,
  ].join('\n');
}

async function captureFields(db, organisationId) {
  const rows = await db.select({ id: jobFields.id, name: jobFields.name }).from(jobFields).where(and(
    eq(jobFields.organisationId, organisationId),
    isNull(jobFields.archivedAt),
  )).orderBy(asc(jobFields.position), asc(jobFields.name));
  const labels = new Set(JOB_FIELDS.map((field) => field.label.toLowerCase()));
  const custom = rows
    .filter((row) => row.name && !labels.has(row.name.trim().toLowerCase()))
    .map((row) => ({ key: `custom_${row.id}`, label: row.name.trim(), needed: false }));
  return [...JOB_FIELDS, ...custom];
}

// Three calls at most. A call that returned token counts is kept on the
// error when every attempt fails, so the capture still records the cost.
async function ask(port, { model, price, fieldList, mediaType, bytes, instruction }) {
  const spent = [];
  let last = new FlowError('reader_unavailable', 'the reader did not answer');
  for (let attempt = 0; attempt < CALLS; attempt += 1) {
    try {
      const result = await port.readImage({
        model, mediaType, bytes, instruction, schema: FIELD_SCHEMA, maxTokens: 4096,
      });
      spent.push({
        model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicros: callCostMicros({ inputTokens: result.inputTokens, outputTokens: result.outputTokens, price }),
      });
      return { fields: parseFields(result.text, fieldList), spent };
    } catch (error) {
      last = error;
      if (error?.retry === false) break;
    }
  }
  last.spent = spent;
  throw last;
}

async function mark(db, row, fields) {
  const [next] = await db.update(captures).set({ ...fields, updatedAt: sql`now()` }).where(and(
    eq(captures.organisationId, row.organisationId),
    eq(captures.id, row.id),
    eq(captures.state, 'reading'),
  )).returning();
  return next ?? row;
}

// Reads one capture that is still `reading`. A capture that has moved on
// (typed, decided) is left as it is. The model's answer is stored on the
// row and is not written to the log.
export async function readStoredCapture(db, storage, port, settings, { organisationId, captureId, log = console }) {
  const [row] = await db.select().from(captures).where(and(
    eq(captures.organisationId, organisationId),
    eq(captures.id, captureId),
  ));
  if (!row || row.state !== 'reading') return row ?? null;

  let stored;
  try {
    stored = await storage.get(row.fileKey);
  } catch {
    const error = new FlowError('reader_unavailable', 'the reader did not answer');
    error.retry = true;
    throw error;
  }
  if (!stored) {
    log.error?.(`[reader] ${row.id} reader_missing`);
    return mark(db, row, { state: 'problem', problem: 'the photo is missing' });
  }
  const sha = createHash('sha256').update(stored.body).digest('hex');
  if (sha !== row.fileSha256) {
    log.error?.(`[reader] ${row.id} hash_mismatch`);
    return mark(db, row, { state: 'problem', problem: 'could not read the form' });
  }
  if (!READABLE.has(row.fileType)) {
    log.error?.(`[reader] ${row.id} reader_type`);
    return mark(db, row, { state: 'problem', problem: 'photo type cannot be read' });
  }

  const fieldList = await captureFields(db, organisationId);
  const instruction = instructionFor(fieldList);
  const photo = { fieldList, mediaType: row.fileType, bytes: stored.body, instruction };
  const calls = [];
  let fields = null;
  try {
    const first = await ask(port, { ...photo, model: settings.model, price: settings.prices.small });
    calls.push(...first.spent);
    fields = first.fields;
    if (belowLine(fields, settings.sureLine)) {
      const second = await ask(port, { ...photo, model: settings.large, price: settings.prices.large });
      calls.push(...second.spent);
      fields = second.fields;
    }
    return mark(db, row, { state: 'ready', problem: null, read: recorded(fields, calls) });
  } catch (error) {
    log.error?.(`[reader] ${row.id} ${error?.code ?? 'reader_unavailable'}`);
    calls.push(...(error?.spent ?? []));
    return mark(db, row, {
      state: 'problem',
      problem: problemText(error),
      read: calls.length ? recorded(fields ?? [], calls, fields ? settings.model : calls.at(-1).model) : null,
    });
  }
}

// Queues the read, or runs it in the request when background jobs are off
// (a Replit workspace). The worker only claims `capture.read` jobs. Two
// processes can run: the lease keeps a capture to one of them.
export function createCaptureReader({
  db, storage, port, settings, log = console, jobsOn = true, timers = globalThis,
}) {
  async function handle(job) {
    const captureId = job.payload?.captureId ?? null;
    try {
      await readStoredCapture(db, storage, port, settings, { organisationId: job.organisationId, captureId, log });
      return { captureId };
    } catch (error) {
      log.error?.(`[reader] ${captureId ?? '-'} ${error?.code ?? 'reader_unavailable'}`);
      const safe = new FlowError('reader_unavailable', 'the reader did not answer');
      safe.retry = error?.retry !== false;
      throw safe;
    }
  }

  async function schedule(row) {
    if (!settings?.on) return row;
    if (!jobsOn) {
      return readStoredCapture(db, storage, port, settings, { organisationId: row.organisationId, captureId: row.id, log });
    }
    await enqueueJob(db, row.organisationId, {
      kind: CAPTURE_READ_KIND,
      dedupeKey: row.id,
      payload: { captureId: row.id },
      maxAttempts: 2,
    });
    return row;
  }

  const workerId = `reader-${randomUUID()}`;
  let timer = null;
  let stopped = true;
  let running = null;

  function arm(delay) {
    if (stopped) return;
    timer = timers.setTimeout(async () => {
      timer = null;
      running = tick();
      const again = await running;
      running = null;
      arm(again ? 0 : 1000);
    }, delay);
    timer?.unref?.();
  }

  async function tick() {
    try {
      const ran = await runNextJob(db, {
        workerId,
        leaseMs: 15 * 60 * 1000,
        handlers: { [CAPTURE_READ_KIND]: handle },
      });
      return Boolean(ran);
    } catch {
      log.error?.('[reader] - reader_unavailable');
      return false;
    }
  }

  return {
    schedule,
    handle,
    worker: {
      start() {
        stopped = false;
        arm(1000);
      },
      async stop() {
        stopped = true;
        if (timer) timers.clearTimeout(timer);
        timer = null;
        await running;
      },
    },
  };
}
