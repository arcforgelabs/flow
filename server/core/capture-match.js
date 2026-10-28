// The capture matcher (docs/DATA_MODEL.md, "Storage"). Flow code, not the
// model, picks the job a form is about. It scores each job on the Jobs board
// against the read or typed fields, in the style of the accounting link
// suggestions: a score, a rank and the signals behind it. A person always
// confirms the job before anything is applied.
//
// Points: case number 60 exact, 50 for a common misread (O for 0, l for 1),
// practice and dentist 20, due date within 3 days 10, work or teeth found in
// the job's lines 10.

export const MATCH_POINTS = Object.freeze({ caseNumber: 60, caseMisread: 50, practice: 12, dentist: 8, date: 10, work: 10 });
// A job at or above this, with no other job within SURE_GAP, is the one sure job.
export const SURE_SCORE = 60;
export const SURE_GAP = 20;
// A job below this is not shown.
export const SHOWN_SCORE = 20;
const SHOWN_MAX = 5;
const DATE_DAYS = 3;

// Fields that find the job (the work is its lines). They are not proposed as
// changes to a job that exists.
const IDENTITY = new Set(['case_number', 'practice', 'work']);
const MISREAD = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
const NAME_NOISE = new Set(['dr', 'dental', 'dentist', 'dentistry', 'clinic', 'surgery', 'practice', 'centre', 'center', 'pty', 'ltd', 'the', 'and', 'of']);

export const jobKey = (job) => `${job.sourceSystem}:${job.sourceJobRef}`;

const plain = (value) => String(value ?? '').trim();
const caseText = (value) => plain(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
const misread = (value) => caseText(value).replace(/[OQDILSBZG]/g, (ch) => MISREAD[ch]);

function words(value) {
  return plain(value).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((word) => word.length > 1 && !NAME_NOISE.has(word));
}

// Edit distance, for close spelling of a name.
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}

const closeWord = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && distance(a, b) <= Math.floor(Math.max(a.length, b.length) / 4));

// Half or more of the shorter name's words appear, by close spelling, in the other.
export function sameName(read, known) {
  const a = words(read);
  const b = words(known);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const found = short.filter((word) => long.some((other) => closeWord(word, other))).length;
  return found * 2 >= short.length;
}

// A date as a lab writes it: 2026-10-31, 31/10/2026, 31/10/26 or 31/10 (day
// first, as in Australia). A date with no year takes the year nearest `now`.
export function readDate(value, now = new Date()) {
  const text = plain(value);
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) return utc(+match[1], +match[2], +match[3]);
  match = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(text);
  if (!match) return null;
  const [, day, month, year] = match;
  if (year) return utc(year.length === 2 ? 2000 + +year : +year, +month, +day);
  const near = [-1, 0, 1].map((step) => utc(now.getUTCFullYear() + step, +month, +day)).filter(Boolean);
  return near.sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0] ?? null;
}

function utc(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

function teethOf(value) {
  return plain(value).match(/\b[1-8][1-8]\b/g) ?? [];
}

function workFound(fields, job) {
  const lines = (job.lines ?? []).map((line) => plain(line.description).toLowerCase()).join(' ');
  if (!lines) return false;
  const work = words(fields.work).filter((word) => word.length >= 4);
  if (work.some((word) => lines.includes(word))) return true;
  return teethOf(fields.teeth).some((tooth) => new RegExp(`\\b${tooth}\\b`).test(lines));
}

function score(fields, job, now) {
  const signals = [];
  const readCase = caseText(fields.case_number);
  const jobCase = caseText(job.caseRef);
  if (readCase && jobCase) {
    if (readCase === jobCase) signals.push({ signal: 'case_number', points: MATCH_POINTS.caseNumber });
    else if (misread(readCase) === misread(jobCase)) signals.push({ signal: 'case_number_misread', points: MATCH_POINTS.caseMisread });
  }
  if (sameName(fields.practice, job.clientName) || sameName(fields.practice, job.workClientName)) {
    signals.push({ signal: 'practice', points: MATCH_POINTS.practice });
  }
  if (sameName(fields.dentist, job.practitioner)) signals.push({ signal: 'dentist', points: MATCH_POINTS.dentist });
  const due = readDate(fields.due_date, now);
  const jobDue = readDate(job.dueOn ?? job.jobDate, now);
  if (due && jobDue && Math.abs(due - jobDue) <= DATE_DAYS * 86_400_000) signals.push({ signal: 'date', points: MATCH_POINTS.date });
  if (workFound(fields, job)) signals.push({ signal: 'work', points: MATCH_POINTS.work });
  return { score: signals.reduce((sum, s) => sum + s.points, 0), signals };
}

// `fields` is { key: value }. `jobs` is the Jobs board's jobs
// (server/core/job-board.js). Answers { outcome, jobs }: outcome `sure` (one
// job), `close` (a short pick list) or `none` (offer a new job).
export function matchJobs(fields, jobs, { now = new Date() } = {}) {
  const ranked = (jobs ?? [])
    .map((job) => ({ job, ...score(fields, job, now) }))
    .filter((entry) => entry.score >= SHOWN_SCORE)
    .sort((a, b) => b.score - a.score || plain(a.job.sourceJobRef).localeCompare(plain(b.job.sourceJobRef)))
    .slice(0, SHOWN_MAX);
  const [top, next] = ranked;
  const outcome = !top ? 'none'
    : top.score >= SURE_SCORE && (!next || top.score - next.score >= SURE_GAP) ? 'sure' : 'close';
  return {
    outcome,
    jobs: ranked.map(({ job, score: points, signals }) => ({
      jobId: jobKey(job), caseRef: job.caseRef ?? null, clientName: job.clientName ?? null, score: points, signals,
    })),
  };
}

// What the job holds now for a read field, where the board shows it.
function current(job, key) {
  if (!job) return '';
  if (key === 'dentist') return plain(job.practitioner);
  if (key === 'due_date') return plain(job.dueOn);
  return '';
}

// The proposed change from the fields and the match. One sure job: update it
// with each field that differs. Close jobs: update, and the person picks the
// job. No job: create one from the fields. A field the reader was not sure
// of keeps its sure score, so the screen can mark it.
export function proposeChange(read, match, jobs) {
  const sure = match.outcome === 'sure' ? match.jobs[0] : null;
  const job = sure ? (jobs ?? []).find((entry) => jobKey(entry) === sure.jobId) ?? null : null;
  const changes = read
    .filter((field) => plain(field.value) && (match.outcome === 'none' || !IDENTITY.has(field.key)))
    .map((field) => ({ field: field.key, from: current(job, field.key), to: plain(field.value), sure: field.sure }))
    .filter((change) => change.from !== change.to);
  return {
    action: match.outcome === 'none' ? 'create' : 'update',
    jobId: sure?.jobId ?? null,
    changes,
  };
}
