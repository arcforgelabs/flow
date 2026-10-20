// A person's own view of the Jobs page: layout, group, sort and filter. It is
// saved with their account (PUT /api/me/views/jobs, server/auth/people.js),
// so it follows them to every device. The rules are here, with no page code,
// so the server can check a saved view and tests can read them
// (test/job-view.test.js). server/ui/jobs.js draws the page.

export const LAYOUTS = ['board', 'list'];
// 'none' is one plain list with no group heads. The board has a lane per
// group, so there it shows the status lanes.
export const GROUPS = { status: 'Status', stage: 'Invoice stage', client: 'Client', practitioner: 'Practitioner', none: 'None' };
// What a job can be sorted by. A custom field can sort too ('field:<id>').
// No sort keeps the order the lab system gives.
export const SORTS = { due: 'Due', ordered: 'Requested', shipped: 'Shipped', client: 'Client', practitioner: 'Practitioner', total: 'Total' };
export const DIRS = ['asc', 'desc'];
// The list's columns, in order. Client is always the first column. One
// column holds one field: each date has its own column. A custom field is
// a column too ('field:<field id>'). Patient shows only when the
// installation keeps patient names; Assignee only when the lab has a
// person field.
export const COLUMNS = {
  case: 'Case', practitioner: 'Practitioner', patient: 'Patient', stage: 'Stage', assignee: 'Assignee',
  ordered: 'Requested', due: 'Due', shipped: 'Shipped', total: 'Total',
};
export const DEFAULT_COLUMNS = Object.freeze(['practitioner', 'patient', 'stage', 'assignee', 'due', 'total']);

// Filters, like ClickUp's: rows of field, operator and value, all of them
// ('all') or any of them ('any') must match. A custom field filters too
// ('field:<id>'); its kind comes from its type. Each kind has its
// operators, in the order the menu shows them.
export const FILTER_FIELDS = {
  status: { label: 'Status', kind: 'choice' },
  stage: { label: 'Invoice stage', kind: 'choice' },
  client: { label: 'Client', kind: 'choice' },
  practitioner: { label: 'Practitioner', kind: 'choice' },
  assignee: { label: 'Assignee', kind: 'person' },
  due: { label: 'Due', kind: 'date' },
  ordered: { label: 'Requested', kind: 'date' },
  shipped: { label: 'Shipped', kind: 'date' },
  total: { label: 'Total', kind: 'number' },
  problem: { label: 'Problem', kind: 'check' },
};
const CHOICE_OPS = { is: 'is', not: 'is not', set: 'is set', unset: 'is not set' };
export const OPERATORS = {
  choice: CHOICE_OPS,
  person: CHOICE_OPS,
  date: {
    overdue: 'is overdue', today: 'is today', next7: 'is in the next 7 days', last7: 'was in the last 7 days',
    before: 'is before', after: 'is after', on: 'is on', set: 'is set', unset: 'is not set',
  },
  number: { eq: 'is', gt: 'is more than', lt: 'is less than', set: 'is set', unset: 'is not set' },
  check: { yes: 'is ticked', no: 'is not ticked' },
  text: { has: 'contains', is: 'is', set: 'is set', unset: 'is not set' },
};
export const KIND_OF_TYPE = { dropdown: 'choice', person: 'person', checkbox: 'check', date: 'date', number: 'number', text: 'text' };
export const MATCHES = ['all', 'any'];
// Operators that need no value.
const NO_VALUE = new Set(['set', 'unset', 'overdue', 'today', 'next7', 'last7', 'yes', 'no']);
const ALL_OPS = new Set(Object.values(OPERATORS).flatMap(Object.keys));

export const DEFAULT_VIEW = Object.freeze({
  layout: 'board', group: 'status', groupDir: 'asc', sorts: Object.freeze([]), match: 'all', filters: Object.freeze([]), columns: DEFAULT_COLUMNS,
});

// Group by one of the lab's custom fields (docs/CUSTOM_FIELDS.md):
// 'field:<field id>'. Only dropdown, person and checkbox fields make lanes.
const FIELD_GROUP = /^field:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const fieldGroup = (fieldId) => `field:${fieldId}`;
export const fieldIdOf = (group) => (FIELD_GROUP.test(group ?? '') ? group.slice(6) : null);

const MAX_VALUES = 100;
const MAX_COLUMNS = 40;
const MAX_LABEL = 120;
const MAX_FILTERS = 20;
const MAX_SORTS = 5;

const cleanLabels = (list) => [...new Set(list.filter((label) => typeof label === 'string' && label.length > 0 && label.length <= MAX_LABEL))].slice(0, MAX_VALUES);
// A filter's value: a list of choices, a word or date, or a number.
function cleanValue(value) {
  if (Array.isArray(value)) return cleanLabels(value);
  if (typeof value === 'string') return value.length <= MAX_LABEL ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function cleanFilter(filter) {
  if (!filter || typeof filter !== 'object') return null;
  const builtIn = Object.hasOwn(FILTER_FIELDS, filter.field ?? '') ? FILTER_FIELDS[filter.field] : null;
  if (!builtIn && !FIELD_GROUP.test(filter.field ?? '')) return null;
  // A custom field's type is not known here, so any operator stands; the
  // page skips one that does not fit.
  const ok = builtIn ? Object.hasOwn(OPERATORS[builtIn.kind], filter.op ?? '') : ALL_OPS.has(filter.op);
  return ok ? { field: filter.field, op: filter.op, value: NO_VALUE.has(filter.op) ? null : cleanValue(filter.value) } : null;
}

// A view saved before filter rows had fixed filters: hidden statuses, late
// jobs, jobs with a problem, and "Assignee: me". They become rows.
function oldFilters(value) {
  const filters = [];
  const hide = Array.isArray(value.hide) ? cleanLabels(value.hide) : [];
  if (hide.length) filters.push({ field: 'status', op: 'not', value: hide });
  if (value.late === true) filters.push({ field: 'due', op: 'overdue', value: null });
  if (value.problems === true) filters.push({ field: 'problem', op: 'yes', value: null });
  if (value.mine === true) filters.push({ field: 'assignee', op: 'is', value: ['me'] });
  return filters;
}

function cleanSorts(value) {
  // A view saved before sort rows had one sort and a direction.
  const list = Array.isArray(value.sorts) ? value.sorts
    : Object.hasOwn(SORTS, value.sort ?? '') ? [{ by: value.sort, dir: value.dir }] : [];
  const seen = new Set();
  return list.filter((s) => s && typeof s === 'object' && (Object.hasOwn(SORTS, s.by ?? '') || FIELD_GROUP.test(s.by ?? '')) && !seen.has(s.by) && seen.add(s.by))
    .map((s) => ({ by: s.by, dir: DIRS.includes(s.dir) ? s.dir : 'asc' })).slice(0, MAX_SORTS);
}

// A view as Flow stores it: only the known keys, each checked. Anything else
// falls back to the default, so a bad saved view never breaks the page.
export function normaliseJobsView(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const pick = (key, allowed) => (allowed.includes(value[key]) ? value[key] : DEFAULT_VIEW[key]);
  return {
    layout: pick('layout', LAYOUTS),
    group: FIELD_GROUP.test(value.group ?? '') ? value.group : pick('group', Object.keys(GROUPS)),
    groupDir: pick('groupDir', DIRS),
    sorts: cleanSorts(value),
    match: pick('match', MATCHES),
    filters: (Array.isArray(value.filters) ? value.filters.map(cleanFilter).filter(Boolean) : oldFilters(value)).slice(0, MAX_FILTERS),
    columns: Array.isArray(value.columns)
      ? [...new Set(value.columns.filter((c) => Object.hasOwn(COLUMNS, c) || FIELD_GROUP.test(c ?? '')))].slice(0, MAX_COLUMNS)
      : [...DEFAULT_COLUMNS],
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// A row filters only once it is complete: a row still being filled in
// (no value yet) keeps every job.
export function filterIsOn(filter) {
  if (NO_VALUE.has(filter.op)) return true;
  if (['before', 'after', 'on'].includes(filter.op)) return ISO_DAY.test(filter.value ?? '');
  if (['eq', 'gt', 'lt'].includes(filter.op)) return typeof filter.value === 'number';
  return Array.isArray(filter.value) ? filter.value.length > 0 : typeof filter.value === 'string' && filter.value.trim().length > 0;
}

// How many filters are on: shown on the Filter button.
export function filterCount(view) {
  return view.filters.filter(filterIsOn).length;
}

const text = (value) => (value ?? '').toString().toLowerCase();
const addDays = (iso, days) => {
  const at = new Date(`${iso}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

// Does one value pass one filter row? `late` says if the job is late (for
// "is overdue" on a job's due date); `me` is the person looking (for "me"
// in a person filter); `today` is yyyy-mm-dd.
export function matchesFilter(filter, value, { today, me = null, late = null } = {}) {
  const want = filter.value;
  const empty = value == null || value === '' || value === false;
  switch (filter.op) {
    case 'set': return !empty;
    case 'unset': return empty;
    case 'yes': return value === true;
    case 'no': return value !== true;
    case 'is': return Array.isArray(want) ? want.map((w) => (w === 'me' ? me : w)).includes(value) : !empty && text(value) === text(want).trim();
    case 'not': return !want.map((w) => (w === 'me' ? me : w)).includes(value);
    case 'has': return text(value).includes(text(want).trim());
    case 'eq': return typeof value === 'number' && value === want;
    case 'gt': return typeof value === 'number' && value > want;
    case 'lt': return typeof value === 'number' && value < want;
    case 'overdue': return late ? late() : !empty && value < today;
    case 'today': return value === today;
    case 'next7': return !empty && value >= today && value <= addDays(today, 7);
    case 'last7': return !empty && value < today && value >= addDays(today, -7);
    case 'before': return !empty && value < want;
    case 'after': return !empty && value > want;
    case 'on': return value === want;
    default: return true;
  }
}

// The jobs the filter keeps. `valueOf(job, field)` reads a job's value for
// a filter field; `kindOf(field)` gives its kind, or null when the field is
// gone (its rows are skipped); `late(job)` says if a job is late.
export function filterJobs(jobs, view, { valueOf, kindOf = (field) => FILTER_FIELDS[field]?.kind ?? null, late = () => false, me = null, today }) {
  const rows = view.filters.filter((f) => filterIsOn(f) && kindOf(f.field) && Object.hasOwn(OPERATORS[kindOf(f.field)], f.op));
  if (!rows.length) return [...jobs];
  const pass = (job) => (f) => matchesFilter(f, valueOf(job, f.field), { today, me, late: f.field === 'due' ? () => late(job) : null });
  return jobs.filter((job) => (view.match === 'any' ? rows.some(pass(job)) : rows.every(pass(job))));
}

// The status lanes to show: a status filter hides the lanes it leaves out,
// even empty ones. With "any" a lane can still match another row, so all
// lanes show.
export function keptStatuses(view, labels) {
  if (view.match === 'any') return labels;
  return view.filters.filter((f) => f.field === 'status' && filterIsOn(f) && Array.isArray(f.value)).reduce((kept, f) => (f.op === 'is'
    ? kept.filter((label) => f.value.includes(label))
    : f.op === 'not' ? kept.filter((label) => !f.value.includes(label)) : kept), labels);
}

const dayOf = (job) => job.dueOn ?? job.orderedOn ?? job.jobDate ?? null;
const KEYS = {
  due: dayOf,
  ordered: (job) => job.orderedOn ?? null,
  shipped: (job) => job.shippedOn ?? null,
  client: (job) => text(job.clientName) || null,
  practitioner: (job) => text(job.practitioner) || null,
  total: (job) => job.totalCents ?? null,
};

// The jobs in the view's order: by each sort in turn. No sort keeps the
// order the API gives. A job with no value for a key goes last, in either
// direction. `keyOf(job, by)` reads a custom field's sort key.
export function sortJobs(jobs, view, keyOf = () => null) {
  const keys = view.sorts.map((s) => ({ read: KEYS[s.by] ?? ((job) => keyOf(job, s.by)), sign: s.dir === 'desc' ? -1 : 1 }));
  if (!keys.length) return [...jobs];
  return jobs.map((job, i) => [job, keys.map((k) => k.read(job)), i]).sort(([, a, i], [, b, j]) => {
    for (let n = 0; n < keys.length; n += 1) {
      const x = a[n];
      const y = b[n];
      if (x == null || y == null) {
        if (x == null && y == null) continue;
        return (x == null) - (y == null);
      }
      const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      if (order) return order * keys[n].sign;
    }
    return i - j;
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

// The lanes of a custom field, in order: [{ label, value, color }]. `value`
// is what a card dropped in the lane gets (null clears it). The empty lane
// comes first, like ClickUp's. An archived option that a job still has gets
// a lane after the live ones. `people` is [{ id, name }] for a person field;
// `jobs` are the jobs on the page and `valueOf` reads a job's value.
export const NOT_SET = 'Not set';
export function fieldLanes(field, { people = [], jobs = [], valueOf = () => null } = {}) {
  const used = new Set(jobs.map(valueOf).filter((v) => v != null));
  if (field.type === 'checkbox') {
    return [{ label: 'No', value: null, color: 'gray' }, { label: 'Yes', value: true, color: 'green' }];
  }
  const empty = { label: NOT_SET, value: null, color: 'gray' };
  if (field.type === 'person') {
    const known = people.map((p) => ({ label: p.name, value: p.id, color: 'blue' }));
    const gone = [...used].filter((id) => !people.some((p) => p.id === id))
      .map((id, i) => ({ label: `Former person ${i + 1}`, value: id, color: 'gray' }));
    return [empty, ...known, ...gone];
  }
  const options = field.options ?? [];
  return [empty,
    ...options.filter((o) => !o.archived).map((o) => ({ label: o.name, value: o.id, color: o.color ?? 'gray' })),
    ...options.filter((o) => o.archived && used.has(o.id)).map((o) => ({ label: `${o.name} (archived)`, value: o.id, color: 'gray', archived: true }))];
}

// The lane label a job sits in for a field's lanes. A checkbox that is
// false sits in "No", with the unset ones.
export function laneOf(lanes, value) {
  if (value === false || value == null) return lanes[0].label;
  return (lanes.find((lane) => lane.value === value) ?? lanes[0]).label;
}
