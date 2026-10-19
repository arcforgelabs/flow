import { createHash } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { errorEvents, problemReports, PROBLEM_STATES } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';

// Problems (docs/PROBLEMS.md): what people report from the app, and the
// errors the server logs. Both stay in this installation's own database;
// nothing here sends them anywhere else.

const MAX_MESSAGE = 4000;
const MAX_PAGE = 500;
const MAX_USER_AGENT = 400;
const MAX_ERROR = 2000;
const LIST_LIMIT = 200;

// The running build as one short label: the release, else the commit.
export function buildLabel(build) {
  return build?.release ?? (build?.revision ? build.revision.slice(0, 12) : null);
}

const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
};

// Takes credentials out of an error message before it is stored: bearer
// tokens, Clerk and similar keys, passwords in URLs, key=value secrets and
// long opaque tokens.
export function redact(text) {
  return String(text ?? '')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]+/g, '[redacted key]')
    .replace(/(\/\/[^/\s:@]+):[^@\s/]+@/g, '$1:[redacted]@')
    .replace(/\b((?:api[_-]?)?key|token|secret|password|passwd|dsn)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9_\-+/]{40,}={0,2}/g, '[redacted]');
}

// Errors that differ only in ids, numbers or quoted values share a
// fingerprint, so a repeat adds to one row.
export function errorFingerprint(source, message) {
  const shape = String(message)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/"[^"]*"|'[^']*'/g, '<value>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '<n>');
  return createHash('sha256').update(`${source}\n${shape}`).digest('hex').slice(0, 32);
}

function checkStatus(status) {
  if (!PROBLEM_STATES.includes(status)) throw new FlowError('invalid', `status must be one of ${PROBLEM_STATES.join(', ')}`);
  return status;
}

const iso = (value) => value?.toISOString?.() ?? value ?? null;

export function publicReport(row) {
  return {
    id: row.id,
    message: row.message,
    page: row.page,
    reporterEmail: row.reporterEmail,
    userAgent: row.userAgent,
    build: row.build,
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function publicError(row) {
  return {
    id: row.id,
    source: row.source,
    message: row.message,
    build: row.build,
    count: row.count,
    status: row.status,
    firstSeenAt: iso(row.firstSeenAt),
    lastSeenAt: iso(row.lastSeenAt),
  };
}

export async function createProblemReport(db, { person = null, message, page = null, userAgent = null, build = null }) {
  const text = clip(message, MAX_MESSAGE + 1);
  if (!text) throw new FlowError('invalid', 'say what went wrong');
  if (text.length > MAX_MESSAGE) throw new FlowError('invalid', `keep the report under ${MAX_MESSAGE} characters`);
  const [row] = await db.insert(problemReports).values({
    reportedBy: person?.id ?? null,
    reporterEmail: person?.email ?? null,
    message: text,
    page: clip(page, MAX_PAGE),
    userAgent: clip(userAgent, MAX_USER_AGENT),
    build: clip(build, 100),
  }).returning();
  return row;
}

// Newest first, with the count in each status.
export async function listProblemReports(db, { status = null, limit = LIST_LIMIT } = {}) {
  if (status) checkStatus(status);
  const rows = await db.select().from(problemReports)
    .where(status ? eq(problemReports.status, status) : undefined)
    .orderBy(desc(problemReports.createdAt))
    .limit(Math.min(Math.max(Number(limit) || LIST_LIMIT, 1), LIST_LIMIT));
  const counts = await countByStatus(db, problemReports);
  return { reports: rows, counts };
}

export async function setProblemReportStatus(db, id, status) {
  checkStatus(status);
  const [row] = await db.update(problemReports)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(problemReports.id, id))
    .returning();
  if (!row) throw notFound('report');
  return row;
}

// One error: a new row, or one more on the row with its fingerprint. A
// closed error that comes back is new again.
export async function recordError(db, { source = 'server', message, build = null }) {
  const text = clip(redact(message), MAX_ERROR);
  if (!text) return null;
  const fingerprint = errorFingerprint(source, text);
  const [row] = await db.insert(errorEvents)
    .values({ fingerprint, source, message: text, build: clip(build, 100) })
    .onConflictDoUpdate({
      target: errorEvents.fingerprint,
      set: {
        count: sql`${errorEvents.count} + 1`,
        message: text,
        build: clip(build, 100),
        lastSeenAt: sql`now()`,
        status: sql`case when ${errorEvents.status} = 'closed' then 'new' else ${errorEvents.status} end`,
      },
    })
    .returning();
  return row;
}

export async function listErrors(db, { status = null, limit = LIST_LIMIT } = {}) {
  if (status) checkStatus(status);
  const rows = await db.select().from(errorEvents)
    .where(status ? eq(errorEvents.status, status) : undefined)
    .orderBy(desc(errorEvents.lastSeenAt))
    .limit(Math.min(Math.max(Number(limit) || LIST_LIMIT, 1), LIST_LIMIT));
  const counts = await countByStatus(db, errorEvents);
  return { errors: rows, counts };
}

export async function setErrorStatus(db, id, status) {
  checkStatus(status);
  const [row] = await db.update(errorEvents).set({ status }).where(eq(errorEvents.id, id)).returning();
  if (!row) throw notFound('error');
  return row;
}

async function countByStatus(db, table) {
  const rows = await db.select({ status: table.status, n: sql`count(*)::int` }).from(table).groupBy(table.status);
  const counts = Object.fromEntries(PROBLEM_STATES.map((state) => [state, 0]));
  for (const { status, n } of rows) counts[status] = n;
  return counts;
}

// A logger that also keeps each error it logs in the error log. It passes
// every line to `log` first, so the host's own log is unchanged. A line's
// leading "[tag]" is its source. At most `limitPerMinute` errors are stored
// each minute, so a storm of failures cannot flood the database; the host
// log still has every line. A failed write is logged once a minute, never
// stored, so it cannot loop.
export function createErrorRecorder({ db, log = console, build = null, limitPerMinute = 60, now = Date.now }) {
  let windowStart = now();
  let stored = 0;
  let lastFailure = 0;
  const label = buildLabel(build);

  function error(...args) {
    log.error?.(...args);
    const line = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ');
    const match = /^\[([a-z0-9_-]+)\]\s*/i.exec(line);
    const at = now();
    if (at - windowStart >= 60_000) {
      windowStart = at;
      stored = 0;
    }
    if (stored >= limitPerMinute) return;
    stored += 1;
    recordError(db, { source: match ? match[1].toLowerCase() : 'server', message: line, build: label }).catch((failure) => {
      if (at - lastFailure < 60_000) return;
      lastFailure = at;
      log.warn?.(`[problems] could not keep an error in the error log: ${failure.message}`);
    });
  }

  return {
    info: (...args) => log.info?.(...args),
    warn: (...args) => log.warn?.(...args),
    error,
  };
}
