// A person's own view of the Jobs page: layout, group, sort and filter. It is
// saved with their account (PUT /api/me/views/jobs, server/auth/people.js),
// so it follows them to every device. The rules are here, with no page code,
// so the server can check a saved view and tests can read them
// (test/job-view.test.js). server/ui/jobs.js draws the page.

export const LAYOUTS = ['board', 'list'];
// 'none' is one plain list with no group heads. The board has a lane per
// group, so there it shows the status lanes.
export const GROUPS = { status: 'Status', stage: 'Invoice stage', client: 'Client', practitioner: 'Practitioner', none: 'None' };
export const SORTS = { board: 'Lab system order', due: 'Date', client: 'Client', practitioner: 'Practitioner', total: 'Total' };
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
export const DEFAULT_VIEW = Object.freeze({
  layout: 'board', group: 'status', sort: 'board', dir: 'asc', hide: [], late: false, problems: false, mine: false, columns: DEFAULT_COLUMNS,
});

// Group by one of the lab's custom fields (docs/CUSTOM_FIELDS.md):
// 'field:<field id>'. Only dropdown, person and checkbox fields make lanes.
const FIELD_GROUP = /^field:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const fieldGroup = (fieldId) => `field:${fieldId}`;
export const fieldIdOf = (group) => (FIELD_GROUP.test(group ?? '') ? group.slice(6) : null);

const MAX_HIDDEN = 100;
const MAX_COLUMNS = 40;
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
    group: FIELD_GROUP.test(value.group ?? '') ? value.group : pick('group', Object.keys(GROUPS)),
    sort: pick('sort', Object.keys(SORTS)),
    dir: pick('dir', DIRS),
    hide,
    late: value.late === true,
    problems: value.problems === true,
    mine: value.mine === true,
    columns: Array.isArray(value.columns)
      ? [...new Set(value.columns.filter((c) => Object.hasOwn(COLUMNS, c) || FIELD_GROUP.test(c ?? '')))].slice(0, MAX_COLUMNS)
      : [...DEFAULT_COLUMNS],
  };
}

// How many filters are on: shown on the Filter button.
export function filterCount(view) {
  return view.hide.length + (view.late ? 1 : 0) + (view.problems ? 1 : 0) + (view.mine ? 1 : 0);
}

// The jobs the filter keeps. `status` is a job's status label; `late` and
// `problem` say if a job is late or has a problem; `mine` says if it is
// assigned to the person looking (jobs.js knows how).
export function filterJobs(jobs, view, { status, late, problem, mine = () => true }) {
  const hidden = new Set(view.hide);
  return jobs.filter((job) => !hidden.has(status(job))
    && (!view.late || late(job))
    && (!view.problems || problem(job))
    && (!view.mine || mine(job)));
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
