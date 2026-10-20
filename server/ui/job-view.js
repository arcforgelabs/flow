// A person's own view of the Jobs page: layout, group, sort and filter. It is
// saved with their account (PUT /api/me/views/jobs, server/auth/people.js),
// so it follows them to every device. The rules are here, with no page code,
// so the server can check a saved view and tests can read them
// (test/job-view.test.js). server/ui/jobs.js draws the page.

export const LAYOUTS = ['board', 'list'];
export const GROUPS = { status: 'Status', stage: 'Invoice stage', client: 'Client', practitioner: 'Practitioner' };
export const SORTS = { board: 'Lab system order', due: 'Date', client: 'Client', practitioner: 'Practitioner', total: 'Total' };
export const DIRS = ['asc', 'desc'];
export const DEFAULT_VIEW = Object.freeze({ layout: 'board', group: 'status', sort: 'board', dir: 'asc', hide: [], late: false, problems: false });

const MAX_HIDDEN = 100;
const MAX_LABEL = 120;

// A view as Flow stores it: only the known keys, each checked. Anything else
// falls back to the default, so a bad saved view never breaks the page.
export function normaliseJobsView(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const pick = (key, allowed) => (allowed.includes(value[key]) ? value[key] : DEFAULT_VIEW[key]);
  const hide = Array.isArray(value.hide)
    ? [...new Set(value.hide.filter((label) => typeof label === 'string' && label.length > 0 && label.length <= MAX_LABEL))].slice(0, MAX_HIDDEN)
    : [];
  return {
    layout: pick('layout', LAYOUTS),
    group: pick('group', Object.keys(GROUPS)),
    sort: pick('sort', Object.keys(SORTS)),
    dir: pick('dir', DIRS),
    hide,
    late: value.late === true,
    problems: value.problems === true,
  };
}

// How many filters are on: shown on the Filter button.
export function filterCount(view) {
  return view.hide.length + (view.late ? 1 : 0) + (view.problems ? 1 : 0);
}

// The jobs the filter keeps. `status` is a job's status label; `late` and
// `problem` say if a job is late or has a problem (jobs.js knows how).
export function filterJobs(jobs, view, { status, late, problem }) {
  const hidden = new Set(view.hide);
  return jobs.filter((job) => !hidden.has(status(job))
    && (!view.late || late(job))
    && (!view.problems || problem(job)));
}

const dayOf = (job) => job.dueOn ?? job.orderedOn ?? job.jobDate ?? null;
const text = (value) => (value ?? '').toString().toLowerCase();
const KEYS = {
  due: dayOf,
  client: (job) => text(job.clientName) || null,
  practitioner: (job) => text(job.practitioner) || null,
  total: (job) => job.totalCents ?? null,
};

// The jobs in the view's order. "Lab system order" keeps the order the API
// gives. A job with no value for the key goes last, in either direction.
export function sortJobs(jobs, view) {
  const key = KEYS[view.sort];
  if (!key) return view.dir === 'desc' ? [...jobs].reverse() : [...jobs];
  const sign = view.dir === 'desc' ? -1 : 1;
  return jobs.map((job, i) => [job, key(job), i]).sort(([, a, i], [, b, j]) => {
    if (a == null || b == null) return (a == null) - (b == null) || i - j;
    const order = typeof a === 'number' ? a - b : String(a).localeCompare(String(b));
    return order * sign || i - j;
  }).map(([job]) => job);
}

// The jobs in groups: one board column, or one block of the list, per group,
// in order. `columns` is the group labels in order (all of them, so an empty
// status still shows); `labelOf` gives a job's label.
export function groupJobs(jobs, columns, labelOf) {
  const groups = new Map(columns.map((label) => [label, []]));
  for (const job of jobs) {
    const label = labelOf(job);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(job);
  }
  return [...groups].map(([label, inGroup]) => ({ label, jobs: inGroup }));
}
