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

// Filters, like ClickUp's: groups of rows of field, operator and value. The
// rows in a group all match ('all') or any one matches ('any'); the groups
// join the same way (the view's `match`). A custom field filters too
// ('field:<id>'); its kind comes from its type. Each kind has ClickUp's
// operators, in the order ClickUp's menu shows them.
export const FILTER_FIELDS = {
  status: { label: 'Status', kind: 'choice', icon: 'circle-dot' },
  stage: { label: 'Invoice stage', kind: 'choice', icon: 'receipt' },
  client: { label: 'Client', kind: 'choice', icon: 'building-2' },
  practitioner: { label: 'Practitioner', kind: 'choice', icon: 'stethoscope' },
  assignee: { label: 'Assignee', kind: 'person', icon: 'user-round' },
  due: { label: 'Due', kind: 'date', icon: 'calendar' },
  ordered: { label: 'Requested', kind: 'date', icon: 'calendar' },
  shipped: { label: 'Shipped', kind: 'date', icon: 'calendar' },
  total: { label: 'Total', kind: 'number', icon: 'dollar-sign' },
  problem: { label: 'Problem', kind: 'check', icon: 'triangle-alert' },
};
const CHOICE_OPS = { is: 'Is', not: 'Is not', set: 'Is set', unset: 'Is not set' };
export const OPERATORS = {
  choice: CHOICE_OPS,
  person: CHOICE_OPS,
  // A date row's range is its value (DATE_VALUES), as on ClickUp.
  date: CHOICE_OPS,
  number: { set: 'Is set', unset: 'Is not set', gt: 'Greater than', lt: 'Less than', eq: 'Equal to' },
  check: { yes: 'Is checked', no: 'Is not checked' },
  text: { has: 'Contains', hasnt: 'Does not contain', is: 'Is', set: 'Is set', unset: 'Is not set' },
};
// The ranges a date row can match, as ClickUp's list names them. 'on',
// 'before' and 'after' take a day ('on:2026-03-10'), 'between' two days
// ('between:2026-03-01..2026-03-31'), 'last' and 'next' a count of days
// ('next:14').
export const DATE_VALUES = {
  today: 'Today', yesterday: 'Yesterday', tomorrow: 'Tomorrow', next7: 'Next 7 days', last7: 'Last 7 days',
  thisweek: 'This week', nextweek: 'Next week', lastweek: 'Last week',
  lastmonth: 'Last month', thismonth: 'This month', nextmonth: 'Next month', earlier: 'Today & Earlier',
  lastquarter: 'Last quarter', thisquarter: 'This quarter', nextquarter: 'Next quarter',
  overdue: 'Overdue', later: 'Later than Today', last: 'Last', next: 'Next',
  lastyear: 'Last year', thisyear: 'This year', nextyear: 'Next year',
  on: 'Exact date', before: 'Before date', after: 'After date', between: 'Date range',
};
export const KIND_OF_TYPE = { dropdown: 'choice', person: 'person', checkbox: 'check', date: 'date', number: 'number', text: 'text' };
// Each kind's icon in the field list (Lucide, /assets/icons/), as ClickUp
// shows a field's type beside its name.
export const KIND_ICONS = { choice: 'square-chevron-down', person: 'user-round', check: 'square-check', date: 'calendar', number: 'hash', text: 'type' };
export const MATCHES = ['all', 'any'];
// Operators that need no value.
const NO_VALUE = new Set(['set', 'unset', 'yes', 'no']);
const ALL_OPS = new Set(Object.values(OPERATORS).flatMap(Object.keys));
// Filters saved before dates took ClickUp's form had the range as the
// operator ('next7', 'before' with a day). They load as "Is <range>".
const OLD_DATE_OPS = new Set(['overdue', 'today', 'next7', 'last7', 'before', 'after', 'on']);

export const DEFAULT_VIEW = Object.freeze({
  layout: 'board', group: 'status', groupDir: 'asc', sorts: Object.freeze([]), match: 'all', groups: Object.freeze([]), columns: DEFAULT_COLUMNS,
  widths: Object.freeze({}),
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
const MAX_GROUPS = 10;
const MAX_SORTS = 5;

const cleanLabels = (list) => [...new Set(list.filter((label) => typeof label === 'string' && label.length > 0 && label.length <= MAX_LABEL))].slice(0, MAX_VALUES);
// A filter's value: a list of choices, a word or date, or a number.
function cleanValue(value) {
  if (Array.isArray(value)) return cleanLabels(value);
  if (typeof value === 'string') return value.length <= MAX_LABEL ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

// One row, checked. `kindOf(field)` is the field's kind, '*' for a custom
// field (its type is not known here, so any operator stands and the page
// skips one that does not fit), or null for a field the list does not have.
function cleanFilter(filter, kindOf) {
  if (!filter || typeof filter !== 'object') return null;
  const kind = kindOf(filter.field ?? '');
  if (!kind) return null;
  if (OLD_DATE_OPS.has(filter.op) && (kind === 'date' || kind === '*')) {
    const day = typeof filter.value === 'string' && ISO_DAY.test(filter.value) ? filter.value : null;
    const range = ['before', 'after', 'on'].includes(filter.op) ? (day ? `${filter.op}:${day}` : null) : filter.op;
    return { field: filter.field, op: 'is', value: range };
  }
  const ok = kind === '*' ? ALL_OPS.has(filter.op) : Object.hasOwn(OPERATORS[kind] ?? {}, filter.op ?? '');
  return ok ? { field: filter.field, op: filter.op, value: NO_VALUE.has(filter.op) ? null : cleanValue(filter.value) } : null;
}

// A filter as Flow keeps it: { match, groups: [{ match, filters }] }. A
// filter saved before groups ({ match, filters }) loads as one group.
export function cleanFilterView(value, kindOf) {
  const input = value && typeof value === 'object' ? value : {};
  const match = (m) => (MATCHES.includes(m) ? m : 'all');
  const list = Array.isArray(input.groups) ? input.groups
    : Array.isArray(input.filters) ? [{ match: input.match, filters: input.filters }] : [];
  let room = MAX_FILTERS;
  const groups = list.slice(0, MAX_GROUPS).map((g) => {
    const filters = (Array.isArray(g?.filters) ? g.filters : []).map((f) => cleanFilter(f, kindOf)).filter(Boolean).slice(0, room);
    room -= filters.length;
    return { match: match(g?.match), filters };
  }).filter((g) => g.filters.length);
  return { match: Array.isArray(input.groups) ? match(input.match) : 'all', groups };
}

// A job filter field's kind, for cleanFilterView.
const jobKind = (field) => FILTER_FIELDS[field]?.kind ?? (FIELD_GROUP.test(field) ? '*' : null);

// A view saved before filter rows had fixed filters: hidden statuses, late
// jobs, jobs with a problem, and "Assignee: me". They become rows.
function oldFilters(value) {
  const filters = [];
  const hide = Array.isArray(value.hide) ? cleanLabels(value.hide) : [];
  if (hide.length) filters.push({ field: 'status', op: 'not', value: hide });
  if (value.late === true) filters.push({ field: 'due', op: 'is', value: 'overdue' });
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
    ...cleanFilterView(Array.isArray(value.groups) || Array.isArray(value.filters) ? value : { filters: oldFilters(value) }, jobKind),
    columns: Array.isArray(value.columns)
      ? [...new Set(value.columns.filter((c) => Object.hasOwn(COLUMNS, c) || FIELD_GROUP.test(c ?? '')))].slice(0, MAX_COLUMNS)
      : [...DEFAULT_COLUMNS],
    widths: cleanWidths(value.widths),
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_RANGE = /^between:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;
// Is a date row's value a range Flow knows?
export function dateValueIsOn(value) {
  if (typeof value !== 'string') return false;
  if (Object.hasOwn(DATE_VALUES, value)) return !['on', 'before', 'after', 'between', 'last', 'next'].includes(value);
  const [kind, rest = ''] = value.split(':');
  if (['on', 'before', 'after'].includes(kind)) return ISO_DAY.test(rest);
  if (['last', 'next'].includes(kind)) return /^[1-9]\d{0,3}$/.test(rest);
  return DAY_RANGE.test(value);
}

// A row filters only once it is complete: a row still being filled in
// (no value yet) keeps every job. `kind` is the row's field kind.
export function filterIsOn(filter, kind = null) {
  if (NO_VALUE.has(filter.op)) return true;
  if (kind === 'date' || (kind == null && typeof filter.value === 'string' && dateValueIsOn(filter.value))) return dateValueIsOn(filter.value);
  if (['eq', 'gt', 'lt'].includes(filter.op)) return typeof filter.value === 'number';
  return Array.isArray(filter.value) ? filter.value.length > 0 : typeof filter.value === 'string' && filter.value.trim().length > 0;
}

// Every row of a view, in its groups' order.
export const filterRows = (view) => (view.groups ?? []).flatMap((g) => g.filters);

// How many filters are on: shown on the Filter button.
export function filterCount(view, kindOf = () => null) {
  return filterRows(view).filter((f) => filterIsOn(f, kindOf(f.field))).length;
}

const text = (value) => (value ?? '').toString().toLowerCase();
const addDays = (iso, days) => {
  const at = new Date(`${iso}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};
const parts = (iso) => iso.split('-').map(Number);
const dayIso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
// The first day of the week (Monday, as in Australia) that holds `iso`.
const weekStart = (iso) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const monthRange = (y, m) => ({ from: dayIso(y, m, 1), to: dayIso(y, m + 1, 0) });
const quarterRange = (y, q) => ({ from: dayIso(y, q * 3 + 1, 1), to: dayIso(y, q * 3 + 4, 0) });

// The days a date value matches, both ends kept: { from, to }, where a
// missing end is open. Null for 'overdue' (it needs the job) or a value
// Flow does not know.
export function dateRange(value, today) {
  const [y, m] = parts(today);
  const q = Math.floor((m - 1) / 3);
  const week = weekStart(today);
  switch (value) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'tomorrow': return { from: addDays(today, 1), to: addDays(today, 1) };
    case 'next7': return { from: today, to: addDays(today, 7) };
    case 'last7': return { from: addDays(today, -7), to: addDays(today, -1) };
    case 'thisweek': return { from: week, to: addDays(week, 6) };
    case 'nextweek': return { from: addDays(week, 7), to: addDays(week, 13) };
    case 'lastweek': return { from: addDays(week, -7), to: addDays(week, -1) };
    case 'thismonth': return monthRange(y, m);
    case 'nextmonth': return monthRange(y, m + 1);
    case 'lastmonth': return monthRange(y, m - 1);
    case 'earlier': return { from: null, to: today };
    case 'later': return { from: addDays(today, 1), to: null };
    case 'thisquarter': return quarterRange(y, q);
    case 'nextquarter': return quarterRange(y, q + 1);
    case 'lastquarter': return quarterRange(y, q - 1);
    case 'thisyear': return { from: dayIso(y, 1, 1), to: dayIso(y, 12, 31) };
    case 'nextyear': return { from: dayIso(y + 1, 1, 1), to: dayIso(y + 1, 12, 31) };
    case 'lastyear': return { from: dayIso(y - 1, 1, 1), to: dayIso(y - 1, 12, 31) };
    default: break;
  }
  if (!dateValueIsOn(value) || value === 'overdue') return null;
  const between = DAY_RANGE.exec(value);
  if (between) return between[1] <= between[2] ? { from: between[1], to: between[2] } : { from: between[2], to: between[1] };
  const [kind, rest] = value.split(':');
  if (kind === 'on') return { from: rest, to: rest };
  if (kind === 'before') return { from: null, to: addDays(rest, -1) };
  if (kind === 'after') return { from: addDays(rest, 1), to: null };
  if (kind === 'last') return { from: addDays(today, -Number(rest)), to: addDays(today, -1) };
  if (kind === 'next') return { from: today, to: addDays(today, Number(rest)) };
  return null;
}

// Is a day (yyyy-mm-dd) in a date value's range? `late` says if the job is
// late, for "Overdue" on a job's due date.
function inDateValue(day, want, today, late) {
  if (want === 'overdue') return late ? late() : day != null && day < today;
  const range = dateRange(want, today);
  if (!range || day == null) return false;
  return (range.from == null || day >= range.from) && (range.to == null || day <= range.to);
}

// Does one value pass one filter row? `kind` is the field's kind; `late`
// says if the job is late (for "Overdue" on a job's due date); `me` is the
// person looking (for "Me" in a person filter); `today` is yyyy-mm-dd.
export function matchesFilter(filter, value, { today, me = null, late = null, kind = null } = {}) {
  const want = filter.value;
  const empty = value == null || value === '' || value === false;
  const day = typeof value === 'string' && ISO_DAY.test(value.slice(0, 10)) ? value.slice(0, 10) : null;
  if (kind === 'date' && ['is', 'not'].includes(filter.op)) {
    const inside = inDateValue(day, want, today, late);
    return filter.op === 'is' ? inside : day != null && !inside;
  }
  switch (filter.op) {
    case 'set': return !empty;
    case 'unset': return empty;
    case 'yes': return value === true;
    case 'no': return value !== true;
    case 'is': return Array.isArray(want) ? want.map((w) => (w === 'me' ? me : w)).includes(value) : !empty && text(value) === text(want).trim();
    case 'not': return !want.map((w) => (w === 'me' ? me : w)).includes(value);
    case 'has': return text(value).includes(text(want).trim());
    case 'hasnt': return !text(value).includes(text(want).trim());
    case 'eq': return typeof value === 'number' && value === want;
    case 'gt': return typeof value === 'number' && value > want;
    case 'lt': return typeof value === 'number' && value < want;
    default: return true;
  }
}

// The jobs the filter keeps. `valueOf(job, field)` reads a job's value for
// a filter field; `kindOf(field)` gives its kind, or null when the field is
// gone (its rows are skipped); `late(job)` says if a job is late. A group
// keeps a job when all its rows pass ('all') or one does ('any'); the
// groups join the same way. A group with no complete row is left out.
export function filterJobs(jobs, view, { valueOf, kindOf = (field) => FILTER_FIELDS[field]?.kind ?? null, late = () => false, me = null, today }) {
  const live = (f) => kindOf(f.field) && Object.hasOwn(OPERATORS[kindOf(f.field)], f.op) && filterIsOn(f, kindOf(f.field));
  const groups = (view.groups ?? []).map((g) => ({ match: g.match, rows: g.filters.filter(live) })).filter((g) => g.rows.length);
  if (!groups.length) return [...jobs];
  const pass = (job) => (f) => matchesFilter(f, valueOf(job, f.field), { today, me, kind: kindOf(f.field), late: f.field === 'due' ? () => late(job) : null });
  const passGroup = (job) => (g) => (g.match === 'any' ? g.rows.some(pass(job)) : g.rows.every(pass(job)));
  return jobs.filter((job) => (view.match === 'any' ? groups.some(passGroup(job)) : groups.every(passGroup(job))));
}

// The status lanes to show: a status filter hides the lanes it leaves out,
// even empty ones. A row whose group (or the groups' join) is "any" can be
// passed another way, so it hides no lane.
export function keptStatuses(view, labels) {
  const groups = (view.groups ?? []).filter((g) => g.filters.some((f) => filterIsOn(f)));
  if (view.match === 'any' && groups.length > 1) return labels;
  return groups.filter((g) => g.match !== 'any' || g.filters.length === 1)
    .flatMap((g) => g.filters)
    .filter((f) => f.field === 'status' && filterIsOn(f) && Array.isArray(f.value)).reduce((kept, f) => (f.op === 'is'
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

// ── Columns (columns.js draws them) ──
// Each kind of column starts at a width and never gets narrower than its
// minimum, so a head and a short value always fit.
export const COLUMN_WIDTH = Object.freeze({
  client: 240, text: 176, case: 96, date: 120, total: 112, stage: 168, person: 96, status: 128, link: 96, icon: 48, number: 112,
});
export const COLUMN_MIN = Object.freeze({
  client: 140, text: 112, case: 64, date: 76, total: 84, stage: 104, person: 64, status: 92, link: 72, icon: 40, number: 80,
});
export const MAX_WIDTH = 800;
const COLUMN_ID = /^[a-z][a-z0-9_-]{0,31}(:[0-9a-f-]{36})?$/i;

export const minWidth = (kind) => COLUMN_MIN[kind] ?? COLUMN_MIN.text;
export const startWidth = (kind) => COLUMN_WIDTH[kind] ?? COLUMN_WIDTH.text;
// A column's width now: the person's width (kept to the kind's minimum and
// the most), else the kind's start width.
export function widthOf(column, widths) {
  const saved = widths?.[column.id];
  return Number.isFinite(saved) ? Math.round(Math.min(MAX_WIDTH, Math.max(minWidth(column.kind), saved))) : startWidth(column.kind);
}

// Saved widths as Flow keeps them: known-looking ids, whole pixels in range.
// The minimum per kind applies when a width is drawn (widthOf), since the
// server does not know a custom column's kind.
export function cleanWidths(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [id, px] of Object.entries(input).slice(0, MAX_COLUMNS)) {
    if (COLUMN_ID.test(id) && Number.isFinite(px) && px >= COLUMN_MIN.icon && px <= MAX_WIDTH) out[id] = Math.round(px);
  }
  return out;
}

// A saved column order: ids `known(id)` allows, each once.
export function cleanColumnIds(input, known) {
  if (!Array.isArray(input)) return null;
  return [...new Set(input.filter((id) => typeof id === 'string' && COLUMN_ID.test(id) && known(id)))].slice(0, MAX_COLUMNS);
}

// The ids with `id` put at place `to` (0 is the start).
export function moveColumn(ids, id, to) {
  const rest = ids.filter((c) => c !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

// The columns in a view's order: the ones it names first, in its order, and
// any it does not name after them, as the page lists them.
export function inOrder(columns, ids) {
  if (!Array.isArray(ids)) return columns;
  const at = new Map(ids.map((id, n) => [id, n]));
  return columns.map((c, n) => [c, at.has(c.id) ? at.get(c.id) : ids.length + n]).sort((a, b) => a[1] - b[1]).map(([c]) => c);
}

// The columns of the Invoices and Reconcile lists. On Pending, Reference
// shows the invoice's problem; Number shows on the tabs with numbers only.
export const INVOICE_COLUMNS = Object.freeze({
  number: 'Number', client: 'Client', reference: 'Reference', date: 'Date', total: 'Total', status: 'Status', linked: 'Linked',
});
export const RECONCILE_COLUMNS = Object.freeze({
  kind: 'Type', client: 'Client', detail: 'Detail', date: 'Date', total: 'Total', possible: 'Possible',
});

// A person's view of a list with set columns (Invoices, Reconcile): the
// shown columns in order (every one when none is saved) and their widths.
export function normaliseListView(input, columns) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const ids = Object.keys(columns);
  return {
    columns: cleanColumnIds(value.columns, (id) => ids.includes(id)) ?? ids,
    widths: cleanWidths(value.widths),
  };
}
