// Jobs (/jobs): the work system's jobs, as a board with one column per work
// system status (its own statuses, one to one), or as a list. A click on a
// job opens its detail panel: the job, its lines, its invoice, its custom
// fields, and what to fix. Data comes from /api/invoicing/board
// (server/core/job-board.js); the rules are in server/ui/job-board.js and
// server/ui/job-view.js.
//
// A card can be dragged to another lane with a mouse or pen
// (docs/JOB_BOARD_MOVES.md). Grouped by a custom field, the move sets the
// job's value, in Flow only. Grouped by status, the move is a stage move
// in the work system: Seazona cannot take one through its API, so Flow
// shows what to do there and the card waits in its new lane. On a phone,
// or with a keyboard, the job's panel has the same moves.

import { bulkBar } from '/assets/ui/bulk-bar.js';
import { columnTable, onRightButton, rowCells, viewSaver } from '/assets/ui/columns.js';
import { lucide } from '/assets/ui/custom-fields.js';
import { formatCents } from '/assets/ui/invoicing.js';
import { jobChangeReview } from '/assets/ui/job-change.js';
import {
  caseNumber, FINAL_RANK, fixes, INVOICE_STAGES, invoiceStage, matches, NO_STATUS, orderStatuses, problemSummary, statusRank,
} from '/assets/ui/job-board.js';
import {
  COLUMNS, DEFAULT_VIEW, fieldGroup, fieldIdOf, fieldLanes, FILTER_FIELDS, filterJobs, groupJobs, GROUPS, KIND_OF_TYPE, keptStatuses, laneOf,
  normaliseJobsView, NOT_SET, OPERATORS, sortJobs, SORTS,
} from '/assets/ui/job-view.js';
import { clipLabel, initialsOf } from '/assets/ui/person.js';
import { savedViews } from '/assets/ui/saved-views.js';
import { sidecar } from '/assets/ui/sidecar.js';
import { findBox, ICONS, svg, today, viewBar } from '/assets/ui/view-bar.js';

const LAYOUT_KEY = 'flow_jobs_layout';
const FOLDED_KEY = 'flow_jobs_folded';
// The job panel's sidecar: the tab last open, or closed.
const SIDE_KEY = 'flow_job_side';
const SIDE_TABS = ['activity', 'fix', 'closed'];
const SYSTEM_NAME = { seazona: 'Seazona', xero: 'Xero' };
// A job's events (server/core/ledger.js), in plain words.
const ACTIVITY = {
  observed: 'Flow read the job', source_changed: 'The job changed in the lab system', ready: 'Marked ready to invoice',
  in_work: 'Put back in work', drafted: 'Draft invoice made', draft_refused: 'Draft invoice refused', invoice_linked: 'Linked to an invoice',
  accounting_checked: 'Checked in the accounting system', payment_recorded: 'Payment recorded', paid: 'Paid in full',
  held: 'Put on hold', review: 'Sent to review', released: 'Hold removed',
  status_moved_back: 'The job status moved back in the lab system', source_lines_used: 'New job lines used on the draft',
  writeback_sent: 'Status sent to the lab system', writeback_failed: 'Status not sent to the lab system',
  writeback_not_supported: 'The lab system does not take the status',
};
const BY = { person: 'A person', automation: 'An automation' };
// Grouped by invoice stage: a job with no invoice stage yet is still in work.
const STAGE_GROUPS = { in_work: 'In work', ...INVOICE_STAGES };
const STAGE_RANK = { 'In work': 0, Drafted: 2, Problem: 2, 'Ready to invoice': 4, Invoiced: 5, Paid: 6 };

const showDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '—');
const fullDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
// A list date, short: Today, Tomorrow or Yesterday, else day/month (and
// year when it is not this year).
const shortDate = (iso) => {
  if (!iso) return '—';
  const at = new Date(`${iso}T00:00:00`);
  const now = new Date();
  const days = Math.round((at - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return at.toLocaleDateString('en-AU', at.getFullYear() === now.getFullYear() ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: '2-digit' });
};
const clientOf = (job) => job.clientName ?? 'No client';
// The one date a card shows: when the job is due, else when it was ordered.
const dateOf = (job) => (job.dueOn ? `Due ${showDate(job.dueOn)}` : job.orderedOn ? `Ordered ${showDate(job.orderedOn)}` : job.jobDate ? showDate(job.jobDate) : null);

function readLayout() {
  try { return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'board'; } catch { return 'board'; }
}

function saveLayout(layout) {
  try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* the choice is only a convenience */ }
}

// The list's folded groups, by group key, in this browser only.
function readFolded() {
  try {
    const value = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function saveFolded(folded) {
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify(folded)); } catch { /* a convenience only */ }
}

function readSide() {
  try {
    const value = localStorage.getItem(SIDE_KEY);
    return SIDE_TABS.includes(value) ? value : 'activity';
  } catch { return 'activity'; }
}

function saveSide(tab) {
  try { localStorage.setItem(SIDE_KEY, tab ?? 'closed'); } catch { /* a convenience only */ }
}


const WARN_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6v3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".9" fill="currentColor"/></svg>';
const PERSON_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 14c.6-2.8 2.8-4.3 5.5-4.3s4.9 1.5 5.5 4.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const CHEVRON_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CALENDAR_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

export async function renderJobs(main, ui) {
  const { h, flow, listHead, listFrame, edgeFade, notice } = ui;
  // Search (search.js) opens a job with no invoice as /jobs?q=<case>.
  const asked = new URLSearchParams(location.search).get('q') ?? '';
  // The person's own view (job-view.js), saved with their account. Before
  // they first change it, the layout this browser last used still applies.
  const saved = ui.me?.views?.jobs;
  const state = {
    view: normaliseJobsView(saved ?? { ...DEFAULT_VIEW, layout: readLayout() }),
    q: asked.trim().toLowerCase(), jobs: [], statuses: [], canDraft: false,
    // Custom fields (docs/CUSTOM_FIELDS.md): the lab's fields, the work
    // systems' stage fields, the people a person field can name, and each
    // job's values by job and field.
    fields: [], systemFields: [], people: [], values: new Map(),
    // Each work system's "Ask before stage moves", read on the first move.
    askBefore: new Map(),
    // The list's ticked jobs (by jobKey), and its folded groups by group key.
    ticked: new Set(), folded: readFolded(),
  };
  // The person's named views (saved-views.js): their default opens on a
  // new visit.
  const views = savedViews(ui, { page: 'jobs', current: () => state.view, apply: (view) => { change(view); drawToggle(); } });
  const opening = views.opening();
  if (opening) state.view = normaliseJobsView(opening);
  const toggle = h('div', { class: 'fx-seg', role: 'radiogroup', 'aria-label': 'Layout' });
  const find = findBox(h, { label: 'Find a case, client or practitioner', value: asked, oninput: (words) => { state.q = words.trim(); draw(); } });
  const host = h('div', { class: 'fx-jobs' }, h('div', { class: 'fx-skeleton' }));
  const controls = h('div', { class: 'fx-viewbar', role: 'group', 'aria-label': 'Group, sort and filter' });
  // In the list, ticked rows get the same floating bar as Invoices.
  const bulk = bulkBar(ui, { label: 'Ticked jobs' });
  const frame = listFrame(main, host);
  main.append(...listHead('Jobs', { views: views.element, start: controls, end: [find.element, toggle] }).nodes, frame.element, bulk.element);

  const drawToggle = () => toggle.replaceChildren(...[['board', 'Board'], ['list', 'List']].map(([id, label]) => h('button', {
    type: 'button', role: 'radio', class: 'fx-seg__item', 'aria-checked': String(state.view.layout === id),
    onclick: () => { saveLayout(id); change({ layout: id }); drawToggle(); },
  }, label)));
  drawToggle();
  views.draw();

  const problemsOf = (job) => fixes(job.obligation);
  const jobKey = (job) => `${job.sourceSystem}\u0000${job.sourceJobRef}`;
  const valueKey = (job, fieldId) => `${job.sourceSystem}\u0000${job.sourceJobRef}\u0000${fieldId}`;
  const valueOf = (job, fieldId) => state.values.get(valueKey(job, fieldId)) ?? null;
  const groupable = () => state.fields.filter((f) => f.groupable);
  // The Assignee: the lab's first person custom field (Flow makes one,
  // server/core/custom-fields.js ensureAssignee). The filter "Assignee is
  // Me" keeps the jobs it names the person looking at.
  const assigneeField = () => state.fields.find((f) => f.type === 'person') ?? null;
  // The list's columns a person can choose: Patient only when the
  // installation keeps patient names; Assignee only with a person field.
  const builtInColumns = () => Object.keys(COLUMNS).filter((id) => (id !== 'patient' || state.jobs.some((job) => job.patient))
    && (id !== 'assignee' || assigneeField()));
  const customColumns = () => state.fields.filter((f) => f.id !== assigneeField()?.id);
  const fieldOfGroup = (group) => groupable().find((f) => f.id === fieldIdOf(group)) ?? null;
  // A work system whose stages Flow can hand a move to (Seazona).
  const movesStages = (job) => state.systemFields.some((f) => f.source === job.sourceSystem);
  // The lane a job shows in when grouped by status: a stage move the work
  // system has not made yet puts it in its new lane.
  const laneStatusOf = (job) => job.pendingMove?.to ?? job.status ?? NO_STATUS;
  const statusOf = (job) => job.status ?? NO_STATUS;
  const isLate = (job) => Boolean(job.dueOn && job.dueOn < today() && statusRank(job.status) < FINAL_RANK);

  // A change to the view: draw it now, save it with the account shortly
  // after, so a few quick clicks make one request.
  const saveView = viewSaver(ui, 'jobs');
  function change(patch) {
    state.view = normaliseJobsView({ ...state.view, ...patch });
    views.draw();
    drawControls();
    draw();
    saveView(state.view);
  }

  // The chips (view-bar.js), shared with every list page.
  const { menu, option, title, choose, bin, addButton, rowsFoot, clearAll, filterMenu: buildFilterMenu } = viewBar(h);
  const DATE_WORDS = ['Oldest first', 'Newest first'];
  const NUMBER_WORDS = ['Low to high', 'High to low'];
  const DIR_WORDS = { total: NUMBER_WORDS, due: DATE_WORDS, ordered: DATE_WORDS, shipped: DATE_WORDS };
  const TYPE_WORDS = { date: DATE_WORDS, number: NUMBER_WORDS };
  const dirWords = (by) => DIR_WORDS[by] ?? TYPE_WORDS[fieldById(fieldIdOf(by))?.type] ?? ['A to Z', 'Z to A'];
  const fieldById = (id) => state.fields.find((f) => f.id === id) ?? null;

  // ── Group by ──
  // One row: what to group by, the group order, and a bin that takes the
  // groups away (the list only: the board always has lanes).
  const groupOptions = () => [
    ...Object.entries(GROUPS).filter(([id]) => id !== 'none').map(([value, label]) => ({ value, label })),
    { group: 'Custom fields', options: groupable().map((f) => ({ value: fieldGroup(f.id), label: f.name })) },
  ];
  const groupMenu = menu(ICONS.group, (redraw) => {
    const list = state.view.layout === 'list';
    const group = state.view.group === 'none' && !list ? 'status' : state.view.group;
    const none = group === 'none';
    return [
      title('Group by'),
      h('div', { class: 'fx-rows' }, h('div', { class: 'fx-rows__row fx-rows__row--group' },
        choose('Group by', none ? '' : group, [...(none ? [{ value: '', label: 'Choose…', disabled: true }] : []), ...groupOptions()], (value) => { change({ group: value }); redraw(); }),
        choose('Group order', state.view.groupDir, [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }], (value) => { change({ groupDir: value }); redraw(); }, { disabled: none }),
        list && !none ? bin('Remove the grouping', () => { change({ group: 'none' }); redraw(); }) : h('span', { class: 'fx-rows__gap' }))),
    ];
  }, { rows: true, clearLabel: 'Remove the grouping' });

  // ── Sort ──
  // Rows of sorts, each applied in turn. In the list, a column's head sorts
  // too.
  const sortOptions = () => [
    ...Object.entries(SORTS).map(([value, label]) => ({ value, label })),
    { group: 'Custom fields', options: state.fields.map((f) => ({ value: fieldGroup(f.id), label: f.name })) },
  ];
  const setSorts = (sorts) => change({ sorts });
  const sortMenu = menu(ICONS.sort, (redraw) => {
    const { sorts } = state.view;
    const unused = sortOptions().flatMap((o) => o.options ?? [o]).filter((o) => !sorts.some((s) => s.by === o.value));
    return [
      title('Sort'),
      sorts.length ? h('div', { class: 'fx-rows' }, sorts.map((s, i) => {
        const [up, down] = dirWords(s.by);
        const others = sorts.filter((_, n) => n !== i).map((x) => x.by);
        const options = sortOptions().map((o) => (o.group ? { ...o, options: o.options.filter((x) => !others.includes(x.value)) } : o)).filter((o) => o.group || !others.includes(o.value));
        return h('div', { class: 'fx-rows__row fx-rows__row--sort' },
          h('span', { class: 'fx-rows__lead' }, i ? 'then' : 'Sort by'),
          choose('Sort by', s.by, options, (by) => { setSorts(sorts.map((x, n) => (n === i ? { by, dir: x.dir } : x))); redraw(); }),
          choose('Order', s.dir, [{ value: 'asc', label: up }, { value: 'desc', label: down }], (dir) => { setSorts(sorts.map((x, n) => (n === i ? { ...x, dir } : x))); redraw(); }),
          bin('Remove this sort', () => { setSorts(sorts.filter((_, n) => n !== i)); redraw(); }));
      })) : h('p', { class: 'fx-rows__empty' }, 'No sort. Jobs show in the lab system’s order.'),
      rowsFoot(
        sorts.length < 5 && unused.length ? addButton('Add sort', () => { setSorts([...sorts, { by: unused[0].value, dir: 'asc' }]); redraw(); }) : h('span'),
        sorts.length ? clearAll(() => { setSorts([]); redraw(); }) : null),
    ];
  }, { rows: true, clearLabel: 'Clear the sort' });

  // ── Filters ──
  // The shared filter panel (view-bar.js), as ClickUp's: groups of rows of
  // field, operator and value. A job's fields, then the lab's custom fields.
  const filterFields = () => [
    ...Object.entries(FILTER_FIELDS).filter(([id]) => id !== 'assignee' || assigneeField())
      .map(([value, f]) => ({ value, label: value === 'assignee' ? assigneeField().name : f.label, icon: f.icon })),
    { group: 'Custom fields', options: customColumns().map((f) => ({ value: fieldGroup(f.id), label: f.name })) },
  ];
  const kindOf = (field) => {
    if (field === 'assignee') return assigneeField() ? 'person' : null;
    if (Object.hasOwn(FILTER_FIELDS, field)) return FILTER_FIELDS[field].kind;
    return KIND_OF_TYPE[fieldById(fieldIdOf(field))?.type] ?? null;
  };
  // Status and stage are always set, so they offer Is and Is not, as
  // ClickUp's Status does.
  const PROBLEM_OPS = { yes: 'Has one', no: 'Has none' };
  const SET_OPS = { is: 'Is', not: 'Is not' };
  const opsOf = (field) => (field === 'problem' ? PROBLEM_OPS : ['status', 'stage'].includes(field) ? SET_OPS : OPERATORS[kindOf(field)] ?? {});
  // The choices a choice or person filter offers: [{ value, label }].
  function choicesOf(field) {
    const people = () => [{ value: 'me', label: 'Me' }, ...state.people.map((p) => ({ value: p.id, label: p.name }))];
    const labels = (list) => [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
    if (field === 'status') return orderStatuses(state.statuses, state.jobs).map((v) => ({ value: v, label: v, rank: statusRank(v) }));
    if (field === 'stage') return Object.values(STAGE_GROUPS).map((v) => ({ value: v, label: v }));
    if (field === 'client') return labels(state.jobs.map(clientOf));
    if (field === 'practitioner') return labels(state.jobs.map((job) => job.practitioner));
    if (field === 'assignee') return people();
    const custom = fieldById(fieldIdOf(field));
    if (custom?.type === 'person') return people();
    return (custom?.options ?? []).map((o) => ({ value: o.id, label: o.archived ? `${o.name} (archived)` : o.name, color: o.color }));
  }
  // A job's value for a filter field, as the filter compares it.
  function filterValue(job, field) {
    switch (field) {
      case 'status': return statusOf(job);
      case 'stage': return STAGE_GROUPS[invoiceStage(job.obligation) ?? 'in_work'];
      case 'client': return clientOf(job);
      case 'practitioner': return job.practitioner ?? null;
      case 'assignee': return assigneeField() ? valueOf(job, assigneeField().id)?.value ?? null : null;
      case 'due': return job.dueOn ?? null;
      case 'ordered': return job.orderedOn ?? null;
      case 'shipped': return job.shippedOn ?? null;
      case 'total': return job.totalCents == null ? null : job.totalCents / 100;
      case 'problem': return problemsOf(job).length > 0;
      default: return valueOf(job, fieldIdOf(field))?.value ?? null;
    }
  }
  const filterMenu = buildFilterMenu({
    fields: filterFields, kindOf, opsOf, choicesOf, first: 'status',
    view: () => state.view, change, empty: 'No filters. Every job shows.',
  });

  // Columns (the list only): Client always shows; each other column can be
  // shown or hidden. Custom fields are columns too.
  const heading = (text) => h('p', { class: 'fx-pop__head' }, text);
  const columnsMenu = menu(ICONS.columns, (redraw) => {
    const on = new Set(state.view.columns);
    const flip = (id) => {
      const next = on.has(id) ? state.view.columns.filter((c) => c !== id) : [...state.view.columns, id];
      change({ columns: next });
      redraw();
    };
    const custom = customColumns();
    return [
      heading('Columns'),
      option('Client', true, () => {}, 'menuitemcheckbox'),
      ...builtInColumns().map((id) => option(COLUMNS[id], on.has(id), () => flip(id), 'menuitemcheckbox')),
      custom.length ? h('div', { class: 'fx-pop__sep' }) : null,
      custom.length ? heading('Custom fields') : null,
      ...custom.map((f) => option(f.name, on.has(fieldGroup(f.id)), () => flip(fieldGroup(f.id)), 'menuitemcheckbox')),
    ];
  });
  controls.append(...groupMenu.node, ...sortMenu.node, ...filterMenu.node, ...columnsMenu.node);

  // A sort's name: a built-in key or a custom field.
  const sortName = (by) => SORTS[by] ?? fieldById(fieldIdOf(by))?.name ?? 'Custom field';
  function drawControls() {
    const { group, sorts, layout } = state.view;
    const list = layout === 'list';
    const field = fieldOfGroup(group);
    // The board has no "None": it shows the status lanes.
    const shown = group === 'none' && !list ? 'status' : group;
    const label = shown === 'none' ? 'Group: None' : `Group: ${field?.name ?? GROUPS[shown] ?? GROUPS.status}`;
    const grouped = list ? shown !== 'none' : shown !== 'status';
    groupMenu.set(label, shown !== DEFAULT_VIEW.group, grouped ? () => change({ group: list ? 'none' : 'status' }) : null);
    // In the list, the column heads sort; the Sort chip shows there only
    // while a sort is on, so it can be seen and cleared.
    const [first] = sorts;
    sortMenu.set(sorts.length > 1 ? `Sort · ${sorts.length}` : first ? `Sort: ${sortName(first.by)} ${first.dir === 'desc' ? '↓' : '↑'}` : 'Sort', sorts.length > 0,
      sorts.length ? () => change({ sorts: [] }) : null);
    sortMenu.wrap.hidden = list && !sorts.length;
    filterMenu.draw();
    columnsMenu.set('Columns', false);
    columnsMenu.wrap.hidden = !list;
  }
  drawControls();

  function draw() {
    if (!state.jobs.length) {
      main.classList.remove('fx-main--board');
      host.replaceChildren(h('div', { class: 'fx-panel fx-empty' },
        h('p', {}, 'No jobs yet. Jobs appear here once the lab system is connected under Integrations.'),
        h('a', { class: 'fx-btn', href: '/invoices/new', onclick: ui.go }, 'Make an invoice by hand')));
      return;
    }
    const found = filterJobs(state.jobs.filter((job) => matches(job, state.q)), state.view,
      { valueOf: filterValue, kindOf, late: isLate, me: ui.me?.person?.id ?? null, today: today() });
    const groups = grouped(sortJobs(found, state.view, sortKey));
    main.classList.toggle('fx-main--board', state.view.layout === 'board');
    // A tick on a job the search or filter now hides goes.
    const shown = new Set(found.map(jobKey));
    for (const key of state.ticked) if (!shown.has(key)) state.ticked.delete(key);
    state.found = found;
    frame.count(`${found.length} ${found.length === 1 ? 'job' : 'jobs'}`);
    host.replaceChildren(state.view.layout === 'list' ? list(groups, found.length) : board(groups));
    drawBulk();
  }

  async function load() {
    try {
      // Custom fields are extra: the board still shows without them.
      const [body, context, fields, values] = await Promise.all([
        flow('/api/invoicing/board'), flow('/api/invoicing/context'),
        flow('/api/custom-fields').catch(() => null), flow('/api/custom-fields/values').catch(() => null),
      ]);
      state.jobs = body.jobs;
      state.statuses = body.statuses;
      state.canDraft = context.canIssue;
      state.fields = fields?.fields ?? [];
      state.systemFields = fields?.systemFields ?? [];
      state.people = fields?.people ?? [];
      state.values = new Map((values?.values ?? []).map((v) => [valueKey(v, v.fieldId), { value: v.value, updatedAt: v.updatedAt }]));
    } catch (error) {
      host.replaceChildren(notice(error.message, 'danger'));
      return;
    }
    drawControls();
    draw();
  }

  // The small warning mark of a job with a problem. It opens the job's page
  // at its Fix box.
  function problemMark(job) {
    const found = problemsOf(job);
    if (!found.length) return null;
    const label = `Problem: ${problemSummary(found)}. Open to fix.`;
    return h('button', {
      class: 'fx-job__problem', type: 'button', 'aria-label': label, title: label,
      onclick: (event) => { event.stopPropagation(); openJob(job, { atFix: true }); },
    }, svg(WARN_ICON));
  }

  // One card ("Task card"). The card design may change, so its markup stays
  // here and its CSS in one block of flow.css ("Job card"): client,
  // practitioner, one date, total, and a warning mark when the job has a
  // problem. Never the case number. A late job's date shows in red. A stage
  // move the work system has not made yet adds "Waiting for <system>".
  function jobCard(job) {
    const date = dateOf(job);
    const day = job.dueOn ?? job.orderedOn ?? job.jobDate;
    const late = isLate(job);
    const system = SYSTEM_NAME[job.sourceSystem] ?? job.sourceSystem;
    const card = h('article', {
      class: 'fx-job', tabindex: '0', role: 'button', 'aria-label': `${clientOf(job)}, open the job`,
      onclick: () => { if (!dragged) openJob(job); },
      onkeydown: (event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openJob(job); } },
    },
    h('div', { class: 'fx-job__client' }, clientOf(job)),
    job.practitioner ? h('div', { class: 'fx-job__who' }, svg(PERSON_ICON), h('span', {}, job.practitioner)) : null,
    h('div', { class: 'fx-job__foot' },
      day ? h('span', { class: `fx-job__date${late ? ' fx-job__date--late' : ''}`, title: late ? `${date}, past due` : date }, svg(CALENDAR_ICON), showDate(day)) : null,
      h('span', { class: 'fx-job__space' }),
      problemMark(job),
      h('span', { class: 'fx-job__amount' }, job.totalCents == null ? '—' : formatCents(job.totalCents))),
    job.pendingMove ? h('span', { class: 'fx-job__wait', title: `Set the status to ${job.pendingMove.to} in ${system}. Flow then reads the change.` }, `Waiting for ${system}`) : null);
    cardJobs.set(card, job);
    return card;
  }

  // A group's label: in its stage colour when the group is a status or an
  // invoice stage, and how many jobs.
  const stagePill = (label, count = null, rank = statusRank(label)) => h('span', { class: 'fx-stage', 'data-rank': String(rank) },
    h('span', { class: 'fx-stage__label' }, label),
    count == null ? null : h('span', { class: 'fx-stage__count' }, String(count)));

  // The groups the view asks for, in order, each with its jobs. Grouped by
  // status, every status the work system has shows, even with no job, except
  // the ones the filter hides.
  // A group's `drop` says what a card dropped in it changes: a custom
  // field's value, or the job's stage in the work system. No `drop`: cards
  // cannot be dropped there (invoice stage, client, practitioner).
  // "Descending" shows the groups in the other order.
  function grouped(jobs) {
    const groups = groupsOf(jobs);
    return state.view.groupDir === 'desc' ? groups.reverse() : groups;
  }
  function groupsOf(jobs) {
    const { group } = state.view;
    const field = fieldOfGroup(group);
    if (field) {
      const read = (job) => valueOf(job, field.id)?.value ?? null;
      const lanes = fieldLanes(field, { people: state.people, jobs: state.jobs, valueOf: read });
      const byLabel = new Map(lanes.map((lane) => [lane.label, lane]));
      return groupJobs(jobs, lanes.map((lane) => lane.label), (job) => laneOf(lanes, read(job))).map((g) => {
        const lane = byLabel.get(g.label);
        return { ...g, rank: 'plain', color: lane?.color, drop: lane && !lane.archived ? { kind: 'field', field, value: lane.value } : null };
      });
    }
    if (group === 'none' && state.view.layout === 'list') return [{ label: null, jobs, rank: 'plain' }];
    if (group === 'status' || group === 'none' || !GROUPS[group]) {
      return groupJobs(jobs, keptStatuses(state.view, orderStatuses(state.statuses, state.jobs)), laneStatusOf)
        .map((g) => ({ ...g, rank: statusRank(g.label), drop: g.label === NO_STATUS ? null : { kind: 'stage', status: g.label } }));
    }
    if (group === 'stage') {
      const labelOf = (job) => STAGE_GROUPS[invoiceStage(job.obligation) ?? 'in_work'];
      return groupJobs(jobs, Object.values(STAGE_GROUPS), labelOf).map((g) => ({ ...g, rank: STAGE_RANK[g.label] }));
    }
    const labelOf = group === 'client' ? clientOf : (job) => job.practitioner ?? 'Not listed';
    const labels = [...new Set(jobs.map(labelOf))].sort((x, y) => x.localeCompare(y));
    return groupJobs(jobs, labels, labelOf).map((g) => ({ ...g, rank: 'plain' }));
  }

  const totalOf = (jobs) => jobs.reduce((sum, job) => sum + (job.totalCents ?? 0), 0);

  function board(groups) {
    if (!groups.length) return h('div', { class: 'fx-panel' }, h('p', { class: 'fx-empty' }, 'No job matches the search or filter.'));
    const element = h('div', { class: 'fx-board' }, groups.map(({ label, jobs, rank, color }, index) => h('section', { class: 'fx-board__col', 'aria-label': label, 'data-lane': String(index) },
      h('header', { class: 'fx-board__head' },
        color ? h('span', { class: 'fx-cf__opt fx-board__lane', 'data-color': color }, label, h('span', { class: 'fx-stage__count' }, String(jobs.length))) : stagePill(label, jobs.length, rank),
        h('span', { class: 'fx-board__sum' }, jobs.length ? formatCents(totalOf(jobs)) : '')),
      h('div', { class: 'fx-board__cards' }, jobs.length ? jobs.map(jobCard) : h('p', { class: 'fx-board__none' }, 'None')))));
    if (groups.some((g) => g.drop)) enableDrag(element, groups);
    // Lanes past the frame's sides, and cards past a lane's foot, fade.
    edgeFade(element, { target: frame.view, edges: ['left', 'right'] });
    element.querySelectorAll('.fx-board__cards').forEach((cards) => edgeFade(cards, { target: cards.parentElement, edges: ['top', 'bottom'] }));
    return element;
  }

  // ── Moves ────────────────────────────────────────────────────────────────
  // Drag with a mouse or pen: press on a card, move 6px, and a copy of the
  // card follows the pointer. A lane that takes the card lights up. Touch
  // keeps scrolling the board; the job's panel has the moves instead.
  const cardJobs = new WeakMap();
  let dragged = false;
  function enableDrag(element, groups) {
    let drag = null;
    const laneAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('.fx-board__col') ?? null;
    const canDrop = (lane, job) => {
      if (!lane || !drag) return false;
      const target = groups[Number(lane.dataset.lane)];
      if (!target?.drop || Number(lane.dataset.lane) === drag.from) return false;
      return target.drop.kind === 'field' || movesStages(job);
    };
    const end = () => {
      drag?.ghost?.remove();
      drag?.card.classList.remove('fx-job--lifted');
      element.classList.remove('fx-board--dragging');
      element.querySelectorAll('.fx-board__col--over').forEach((lane) => lane.classList.remove('fx-board__col--over'));
      drag = null;
    };
    element.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.pointerType === 'touch') return;
      const card = event.target.closest('.fx-job');
      if (!card || event.target.closest('button, a')) return;
      const rect = card.getBoundingClientRect();
      drag = { card, job: cardJobs.get(card), from: Number(card.closest('.fx-board__col').dataset.lane), x: event.clientX, y: event.clientY, dx: event.clientX - rect.left, dy: event.clientY - rect.top, width: rect.width, moved: false, over: null };
      card.setPointerCapture(event.pointerId);
    });
    element.addEventListener('pointermove', (event) => {
      if (!drag) return;
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
        drag.moved = true;
        drag.ghost = drag.card.cloneNode(true);
        drag.ghost.classList.add('fx-job--ghost');
        drag.ghost.style.width = `${drag.width}px`;
        document.body.append(drag.ghost);
        drag.card.classList.add('fx-job--lifted');
        element.classList.add('fx-board--dragging');
      }
      drag.ghost.style.transform = `translate(${event.clientX - drag.dx}px, ${event.clientY - drag.dy}px) rotate(1.5deg)`;
      const lane = laneAt(event.clientX, event.clientY);
      const over = canDrop(lane, drag.job) ? lane : null;
      if (over !== drag.over) {
        drag.over?.classList.remove('fx-board__col--over');
        over?.classList.add('fx-board__col--over');
        drag.over = over;
      }
    });
    element.addEventListener('pointerup', (event) => {
      if (!drag) return;
      const { moved, over, job } = drag;
      const target = over ? groups[Number(over.dataset.lane)] : null;
      end();
      if (!moved) return;
      // The click that ends a drag does not open the job.
      dragged = true;
      setTimeout(() => { dragged = false; }, 0);
      if (target) moveJob(job, target.drop);
      event.preventDefault();
    });
    element.addEventListener('pointercancel', end);
    element.addEventListener('keydown', (event) => { if (event.key === 'Escape' && drag) end(); });
  }

  function moveJob(job, drop) {
    if (drop.kind === 'field') return setValue(job, drop.field, drop.value);
    return moveStage(job, drop.status);
  }

  // Set one job's custom field value, in Flow only. The board shows it at
  // once; `expectedUpdatedAt` makes a change someone else made first win,
  // and the board then shows theirs.
  async function setValue(job, field, value) {
    const key = valueKey(job, field.id);
    const before = state.values.get(key) ?? null;
    if ((before?.value ?? null) === value) return;
    if (value == null) state.values.delete(key); else state.values.set(key, { value, updatedAt: before?.updatedAt ?? null });
    draw();
    const keep = (saved) => {
      if (saved?.value == null) state.values.delete(key); else state.values.set(key, { value: saved.value, updatedAt: saved.updatedAt });
    };
    try {
      const { value: saved } = await flow('/api/custom-fields/values', {
        method: 'PUT',
        body: JSON.stringify({ sourceSystem: job.sourceSystem, sourceJobRef: job.sourceJobRef, fieldId: field.id, value, expectedUpdatedAt: before?.updatedAt ?? null }),
      });
      keep(saved);
    } catch (error) {
      if (error.code === 'conflict' && error.details) {
        keep(error.details.current);
        ui.toast?.(`Someone changed ${field.name} on this job just now. The board shows their change.`, 'info');
      } else {
        if (before) state.values.set(key, before); else state.values.delete(key);
        ui.toast?.(error.message, 'danger');
      }
    }
    draw();
  }

  // "Ask before stage moves", this person's own setting in the work system's
  // integration. On unless they said "Don't ask again".
  async function askBefore(system) {
    if (!state.askBefore.has(system)) {
      try {
        const { integrations } = await flow(`/api/work/my-settings?integration=${encodeURIComponent(system)}`);
        state.askBefore.set(system, integrations[0]?.settings.find((s) => s.key === 'askBeforeStageMoves')?.value ?? true);
      } catch {
        state.askBefore.set(system, true);
      }
    }
    return state.askBefore.get(system);
  }

  // A stage move in the work system. Seazona cannot take it through its
  // API, so Flow says what to do there, records the move, and the card waits
  // in its new lane until the sync reads the new status. A move back to the
  // job's own status takes a waiting move back.
  async function moveStage(job, status) {
    const system = SYSTEM_NAME[job.sourceSystem] ?? job.sourceSystem;
    const ref = { sourceSystem: job.sourceSystem, sourceJobRef: job.sourceJobRef };
    const before = job.pendingMove ?? null;
    if (status === (job.status ?? NO_STATUS)) {
      if (!before) return;
      job.pendingMove = null;
      draw();
      try {
        await flow('/api/work/moves/cancel', { method: 'POST', body: JSON.stringify(ref) });
        ui.toast?.(`Move taken back. The card follows ${system} again.`, 'success');
      } catch (error) {
        job.pendingMove = before;
        ui.toast?.(error.message, 'danger');
        draw();
      }
      return;
    }
    let dontAsk = false;
    if (await askBefore(job.sourceSystem)) {
      const tick = h('input', { type: 'checkbox', name: 'dontAsk' });
      const chip = (text) => h('span', { class: 'fx-move__stage' }, text);
      const body = h('div', { class: 'fx-fields fx-move' },
        h('p', { class: 'fx-move__path' }, chip(job.status ?? NO_STATUS), h('span', { 'aria-hidden': 'true' }, '→'), chip(status)),
        h('p', { class: 'fx-move__note' }, `${system} cannot take this change from Flow. Make it in ${system}:`),
        h('ol', { class: 'fx-steps' },
          h('li', {}, openStep(job, system)),
          h('li', {}, `Set its status to ${status}.`),
          h('li', {}, `Flow shows the card as waiting until it reads the change. After a day it goes back.`)),
        h('label', { class: 'fx-check' }, tick, h('span', {}, "Don't ask again")));
      const ok = await ui.dialog({ title: `Move in ${system}`, body, confirm: 'Move card' });
      if (!ok) return;
      dontAsk = tick.checked;
    }
    job.pendingMove = { to: status, from: job.status, openUrl: job.link?.url ?? null, openExact: Boolean(job.link?.exact) };
    draw();
    try {
      const { move } = await flow('/api/work/moves', { method: 'POST', body: JSON.stringify({ ...ref, toStatus: status }) });
      job.pendingMove = { to: move.to, from: move.from, requestedAt: move.requestedAt, expiresAt: move.expiresAt, openUrl: move.openUrl, openExact: move.openExact };
      ui.toast?.(`Waiting for ${system}. Set ${caseNumber(move) ? `case ${caseNumber(move)}` : 'the case'} to ${move.to} there.`, 'success');
    } catch (error) {
      job.pendingMove = before;
      ui.toast?.(error.message, 'danger');
    }
    if (dontAsk) {
      state.askBefore.set(job.sourceSystem, false);
      flow('/api/work/my-settings', { method: 'PUT', body: JSON.stringify({ integration: job.sourceSystem, key: 'askBeforeStageMoves', value: false }) })
        .catch(() => ui.toast?.('Flow could not save "Don\'t ask again".', 'danger'));
    }
    draw();
  }

  // The first step of a stage move: a link that opens the order in the work
  // system's web app. An exact link opens the order itself; otherwise it
  // opens the lab's home page there, and the person finds the case.
  function openStep(job, system) {
    const caseRef = caseNumber(job);
    const named = caseRef ? `case ${caseRef}` : `the case for ${clientOf(job)}`;
    const url = job.link?.url ?? null;
    if (!url) return `Open ${named} in ${system}.`;
    const out = (text) => h('a', { class: 'fx-task__link', href: url, target: '_blank', rel: 'noopener' }, text);
    return job.link.exact
      ? h('span', {}, out(caseRef ? `Open case ${caseRef} in ${system} ↗` : `Open the case in ${system} ↗`))
      : h('span', {}, out(`Open ${system} ↗`), ` and find ${named}.`);
  }

  // The job panel's custom fields: one control each, saved when it changes.
  function fieldControl(job, field) {
    const current = valueOf(job, field.id)?.value ?? null;
    const save = (value) => setValue(job, field, value);
    const label = field.name;
    if (field.type === 'dropdown' || field.type === 'person') {
      const choices = field.type === 'person'
        ? state.people.map((p) => ({ value: p.id, label: p.name, title: p.name }))
        : field.options.filter((o) => !o.archived || o.id === current).map((o) => ({ value: o.id, label: o.archived ? `${o.name} (archived)` : o.name }));
      const select = h('select', { class: 'fx-select fx-task__input', 'aria-label': label },
        h('option', { value: '' }, NOT_SET), choices.map((c) => h('option', { value: c.value, selected: c.value === current, title: c.title ?? null }, clipLabel(c.label))));
      select.addEventListener('change', () => save(select.value || null));
      return select;
    }
    if (field.type === 'checkbox') {
      const box = h('input', { type: 'checkbox', 'aria-label': label, checked: current === true });
      box.addEventListener('change', () => save(box.checked ? true : null));
      return box;
    }
    const input = h('input', {
      class: 'fx-input fx-task__input', 'aria-label': label,
      type: field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text',
      value: current ?? '', maxlength: field.type === 'text' ? '500' : null, step: field.type === 'number' ? 'any' : null,
    });
    input.addEventListener('change', () => {
      const raw = input.value.trim();
      save(raw === '' ? null : field.type === 'number' ? Number(raw) : raw);
    });
    return input;
  }

  // The job panel's stage move: the same move as a drag, for a phone or a
  // keyboard. A waiting move shows what to do, with Take back.
  function stageControl(job) {
    const system = SYSTEM_NAME[job.sourceSystem] ?? job.sourceSystem;
    const stages = state.systemFields.find((f) => f.source === job.sourceSystem)?.options ?? [];
    if (!stages.length) return null;
    const select = h('select', { class: 'fx-select fx-task__input', 'aria-label': `Move to a ${system} stage` },
      h('option', { value: '' }, 'Move to…'),
      stages.filter((s) => s.name !== job.status).map((s) => h('option', { value: s.name }, s.name)));
    select.addEventListener('change', () => { if (select.value) moveStage(job, select.value).then(() => select.closest('dialog')?.close()); });
    const wait = job.pendingMove ? h('div', { class: 'fx-task__wait' },
      h('span', {}, `Waiting for ${system}: set the status to ${job.pendingMove.to} there.`),
      job.pendingMove.openUrl ? h('a', { class: 'fx-task__link', href: job.pendingMove.openUrl, target: '_blank', rel: 'noopener' }, `Open in ${system}`) : null,
      h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', onclick: (event) => { event.currentTarget.closest('dialog')?.close(); moveStage(job, job.status ?? NO_STATUS); } }, 'Take back')) : null;
    return h('div', { class: 'fx-task__move' }, wait, select);
  }

  // What a column's head sorts by: a built-in key, or the column's custom
  // field (Assignee is the lab's person field).
  const SORT_OF = { client: 'client', practitioner: 'practitioner', due: 'due', ordered: 'ordered', shipped: 'shipped', total: 'total' };
  const sortOf = (columnId) => SORT_OF[columnId]
    ?? (columnId === 'assignee' && assigneeField() ? fieldGroup(assigneeField().id) : fieldIdOf(columnId) ? columnId : null);
  // A custom field's sort key: a person's name, an option's place in the
  // list, ticked first or last, or the value.
  function sortKey(job, by) {
    const field = fieldById(fieldIdOf(by));
    const value = field ? valueOf(job, field.id)?.value ?? null : null;
    if (!field || value == null) return null;
    if (field.type === 'person') return (state.people.find((p) => p.id === value)?.name ?? '').toLowerCase() || null;
    if (field.type === 'dropdown') {
      const at = (field.options ?? []).findIndex((o) => o.id === value);
      return at < 0 ? null : at;
    }
    if (field.type === 'checkbox') return value === true ? 1 : 0;
    return typeof value === 'string' ? value.toLowerCase() : value;
  }
  // A column head's sort button, as ClickUp's: it shows on hover, or
  // always while it sorts. A click sorts one way, again the other way, and
  // a third time takes the sort off. A right-click on a sorting head opens
  // a small menu: change the direction, or clear the sort.
  function sortButton(columnId, label) {
    const by = sortOf(columnId);
    if (!by) return null;
    const { sorts } = state.view;
    const at = sorts.findIndex((s) => s.by === by);
    const on = at >= 0 ? sorts[at] : null;
    const [up, down] = dirWords(by);
    const next = () => {
      if (!on) change({ sorts: [{ by, dir: 'asc' }] });
      else if (on.dir === 'asc') change({ sorts: sorts.map((s, n) => (n === at ? { ...s, dir: 'desc' } : s)) });
      else change({ sorts: sorts.filter((_, n) => n !== at) });
    };
    const words = on ? `Sorted ${on.dir === 'asc' ? up : down}. Click to ${on.dir === 'asc' ? `sort ${down}` : 'clear the sort'}` : `Sort by ${label}`;
    return h('button', {
      type: 'button', class: `fx-th-sort${on ? ' fx-th-sort--on' : ''}`, 'aria-label': words, title: words,
      onclick: (event) => { event.stopPropagation(); next(); },
      oncontextmenu: (event) => {
        if (!on) return;
        event.preventDefault();
        event.stopPropagation();
        onRightButton(event, () => sortMenuAt(event, by, label, on, at));
      },
    }, lucide(h, on ? (on.dir === 'asc' ? 'arrow-up' : 'arrow-down') : 'chevrons-up-down'),
    on && sorts.length > 1 ? h('span', { class: 'fx-th-sort__n' }, String(at + 1)) : null);
  }
  function sortMenuAt(event, by, label, on, at) {
    const { sorts } = state.view;
    const flip = () => change({ sorts: sorts.map((s, n) => (n === at ? { ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' } : s)) });
    heads.menu.show([
      h('button', { type: 'button', class: 'fx-pop__item', role: 'menuitemcheckbox', 'aria-checked': 'true', title: 'Change the direction', onclick: () => { heads.menu.close(); flip(); } },
        h('span', { class: 'fx-pop__tick' }, lucide(h, on.dir === 'asc' ? 'arrow-up' : 'arrow-down')), h('span', {}, `Sort by ${label}`), h('span', { class: 'fx-pop__end' }, svg(ICONS.tick))),
      heads.menu.item('ban', 'Clear sort', () => change({ sorts: sorts.filter((_, n) => n !== at) })),
    ], event);
  }
  // The list's heads (columns.js): drag an edge to resize, drag a head to
  // move it; a click or right-click opens its menu: sort by it, move it,
  // edit its custom field, hide it. Client always shows, first. + lists the
  // hidden columns, to add one back.
  const heads = columnTable(h, {
    order: () => state.view.columns,
    widths: () => state.view.widths,
    change,
    hidden: () => {
      const shown = new Set(state.view.columns);
      return [
        ...builtInColumns().filter((id) => !shown.has(id)).map((id) => ({ id, label: id === 'assignee' ? assigneeField().name : COLUMNS[id] })),
        ...customColumns().filter((f) => !shown.has(fieldGroup(f.id))).map((f) => ({ id: fieldGroup(f.id), label: f.name })),
      ];
    },
    extra: (column, item) => {
      const parts = [];
      const sort = sortOf(column.id);
      if (sort) {
        const [up, down] = dirWords(sort);
        parts.push(item('arrow-up-narrow-wide', `Sort: ${up}`, () => change({ sorts: [{ by: sort, dir: 'asc' }] })),
          item('arrow-down-wide-narrow', `Sort: ${down}`, () => change({ sorts: [{ by: sort, dir: 'desc' }] })), h('div', { class: 'fx-pop__sep' }));
      }
      if (column.id.startsWith('field:') && ['owner', 'admin'].includes(ui.me?.person?.role)) {
        parts.push(item('settings', 'Edit custom field', () => ui.go('/custom-fields')));
      }
      return parts;
    },
  });

  // The list's columns, in the order the person chose them. One column holds
  // one field; each date has its own column.
  function listColumns() {
    const day = (iso) => h('time', { datetime: iso ?? null, title: iso ? fullDate(iso) : null }, shortDate(iso));
    const late = (job) => (isLate(job) ? h('span', { class: 'fx-job__date--late', title: 'Past due' }, day(job.dueOn)) : day(job.dueOn));
    const BUILT_IN = {
      case: { kind: 'case', className: 'fx-dim', cell: (job) => caseNumber(job) ?? '—' },
      practitioner: { kind: 'text', className: 'fx-dim', cell: (job) => job.practitioner ?? '—' },
      patient: { kind: 'text', className: 'fx-dim', cell: (job) => job.patient ?? '—' },
      stage: { kind: 'stage', cell: (job) => stagePill(statusOf(job)) },
      assignee: { kind: 'person', cell: (job) => personBadge(job, assigneeField()) },
      ordered: { kind: 'date', className: 'fx-dim', cell: (job) => day(job.orderedOn) },
      due: { kind: 'date', className: 'fx-dim', cell: late },
      shipped: { kind: 'date', className: 'fx-dim', cell: (job) => day(job.shippedOn) },
      total: { kind: 'total', num: true, className: 'fx-strong', cell: (job) => (job.totalCents == null ? '—' : formatCents(job.totalCents)) },
    };
    const allowed = new Set(builtInColumns());
    // Client is always the first column: it has no drag, Move or Hide.
    const client = {
      id: 'client', label: 'Client', kind: 'client', fixed: true, sort: () => sortButton('client', 'Client'),
      cell: (job) => h('span', { class: 'fx-job__cell' }, h('span', { class: 'fx-strong' }, clientOf(job)), problemMark(job)),
    };
    return [client, ...state.view.columns.map((id) => {
      if (BUILT_IN[id]) return allowed.has(id) ? { id, label: id === 'assignee' ? assigneeField().name : COLUMNS[id], ...BUILT_IN[id] } : null;
      const field = customColumns().find((f) => fieldGroup(f.id) === id);
      if (!field) return null;
      const cell = field.type === 'person' ? (job) => personBadge(job, field)
        : field.type === 'date' ? (job) => day(valueOf(job, field.id)?.value ?? null) : (job) => fieldText(job, field);
      return { id, label: field.name, kind: field.type === 'date' ? 'date' : field.type === 'person' ? 'person' : field.type === 'number' ? 'total' : 'text', num: field.type === 'number', className: 'fx-dim', cell };
    }).filter(Boolean).map((c) => ({ ...c, sort: () => sortButton(c.id, c.label) }))];
  }

  // A person custom field's value as a badge (initials), the name on hover.
  function personBadge(job, field) {
    const value = field ? valueOf(job, field.id)?.value ?? null : null;
    if (!value) return h('span', { class: 'fx-dim' }, '—');
    const name = state.people.find((p) => p.id === value)?.name ?? 'Former person';
    return h('span', { class: 'fx-avatar fx-avatar--sm', role: 'img', 'aria-label': name, title: name }, initialsOf(name));
  }

  // A job's custom field value as text.
  function fieldText(job, field) {
    const value = field ? valueOf(job, field.id)?.value ?? null : null;
    if (value == null || value === false) return '—';
    if (field.type === 'checkbox') return 'Yes';
    if (field.type === 'person') return state.people.find((p) => p.id === value)?.name ?? 'Former person';
    if (field.type === 'dropdown') return field.options?.find((o) => o.id === value)?.name ?? '—';
    if (field.type === 'date') return showDate(value);
    return String(value);
  }

  // The list: one block per group, with the group's label over its rows.
  // A tick column at the left; a group's head has a tick for every job in
  // the group, and a click on the head folds the group or opens it. Grouped
  // by None, it is one plain list with no heads.
  function list(groups, count) {
    if (!count) return h('div', { class: 'fx-panel' }, h('p', { class: 'fx-empty' }, 'No job matches the search or filter.'));
    const shownGroups = groups.filter((g) => g.jobs.length);
    const folded = new Set(state.folded[state.view.group] ?? []);
    const allJobs = shownGroups.flatMap((g) => g.jobs);
    const boxes = [];
    // A tick box for a set of jobs: ticked when all are, half when some are.
    const setBox = (jobs, label) => {
      const box = h('input', { type: 'checkbox', class: 'fx-tick', 'aria-label': label, onclick: (event) => event.stopPropagation() });
      const sync = () => {
        const on = jobs.filter((job) => state.ticked.has(jobKey(job))).length;
        box.checked = on > 0 && on === jobs.length;
        box.indeterminate = on > 0 && on < jobs.length;
      };
      box.addEventListener('change', () => {
        for (const job of jobs) { if (box.checked) state.ticked.add(jobKey(job)); else state.ticked.delete(jobKey(job)); }
        syncAll();
      });
      boxes.push(sync);
      sync();
      return box;
    };
    const syncAll = () => { for (const sync of boxes) sync(); drawBulk(); };
    const tickCell = (box) => h('td', { class: 'fx-tick-cell', onclick: (event) => event.stopPropagation() }, box);
    const columns = listColumns();
    const row = (job) => h('tr', {
      class: 'fx-row-link', tabindex: '0',
      onclick: () => openJob(job),
      onkeydown: (event) => { if (event.key === 'Enter' && event.target === event.currentTarget) openJob(job); },
    },
    tickCell(setBox([job], `Tick ${clientOf(job)}${caseNumber(job) ? `, case ${caseNumber(job)}` : ''}`)),
    rowCells(h, columns, job),
    h('td', { class: 'fx-c-end' }));
    const fold = (label) => {
      const next = new Set(state.folded[state.view.group] ?? []);
      if (next.has(label)) next.delete(label); else next.add(label);
      state.folded = { ...state.folded, [state.view.group]: [...next] };
      saveFolded(state.folded);
      draw();
    };
    const head = ({ label, jobs, rank, color }) => {
      const open = !folded.has(label);
      const toggle = h('button', {
        type: 'button', class: 'fx-table__fold', 'aria-expanded': String(open), 'aria-label': `${label}, ${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}. ${open ? 'Fold' : 'Open'} the group`,
        onclick: (event) => { event.stopPropagation(); fold(label); },
      }, svg(CHEVRON_ICON),
      color ? h('span', { class: 'fx-cf__opt fx-board__lane', 'data-color': color }, label, h('span', { class: 'fx-stage__count' }, String(jobs.length))) : stagePill(label, jobs.length, rank));
      return h('tr', { class: `fx-table__group${open ? '' : ' fx-table__group--folded'}`, onclick: () => fold(label) },
        tickCell(setBox(jobs, `Tick every job in ${label}`)),
        h('td', { colspan: String(columns.length + 1) }, h('span', { class: 'fx-table__group-row' }, toggle, h('span', { class: 'fx-board__sum' }, formatCents(totalOf(jobs))))));
    };
    return h('div', { class: 'fx-panel' }, heads.table({
      className: 'fx-table--jobs',
      columns,
      lead: [h('th', { class: 'fx-tick-cell' }, setBox(allJobs, 'Tick every job shown'))],
      rows: shownGroups.map((g) => h('tbody', {},
        g.label == null ? null : head(g),
        g.label != null && folded.has(g.label) ? null : g.jobs.map(row))),
    }));
  }

  // ── Bulk actions ─────────────────────────────────────────────────────────
  // The bar floats at the foot while list rows are ticked (bulk-bar.js, as on
  // Invoices). Move and Ready are the main steps; Copy and Export take the
  // ticked rows out; More has them all, a field per custom field, and the
  // Selection steps.
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const tickedJobs = () => (state.found ?? []).filter((job) => state.ticked.has(jobKey(job)));
  const setTicks = (jobs) => { state.ticked = new Set(jobs.map(jobKey)); draw(); };

  function drawBulk() {
    const rows = state.view.layout === 'list' ? tickedJobs() : [];
    bulk.draw({ count: rows.length, onClear: () => setTicks([]), ...bulkActions(rows) });
  }

  function bulkActions(rows) {
    if (!rows.length) return { groups: [], more: [] };
    const status = [{ icon: 'arrow-right-left', label: 'Move', title: 'Move to a stage', run: () => moveMany(rows) }];
    if (state.fields.length) status.push({ icon: 'tag', label: 'Custom field', title: 'Set a custom field', run: () => setMany(rows) });
    const workable = rows.filter((job) => job.obligation?.view === 'in_work');
    if (workable.length) status.push({ icon: 'check-check', label: 'Ready', title: 'Mark ready to invoice', run: () => readyMany(workable) });
    const draftable = state.canDraft ? rows.filter((job) => job.obligation?.view === 'ready' && !job.obligation.invoiceId) : [];
    if (draftable.length) status.push({ icon: 'file-plus', label: 'Draft', title: 'Draft invoices', run: () => draftMany(draftable) });
    const fields = state.fields.map((field) => ({ icon: 'tag', label: field.name, title: `Set ${field.name}`, run: () => setMany(rows, field.id) }));
    const apply = [
      { icon: 'copy', label: 'Copy', iconOnly: true, title: 'Copy case numbers', run: () => copyLines(rows.map((job) => caseNumber(job) ?? clientOf(job))) },
      { icon: 'download', label: 'Export', iconOnly: true, title: 'Export CSV', run: () => exportCsv(rows) },
    ];
    const all = state.found ?? [];
    const selection = [
      { icon: 'list-checks', label: 'Tick all shown', run: () => setTicks(all) },
      { icon: 'square-check', label: 'Invert ticks', run: () => setTicks(all.filter((job) => !state.ticked.has(jobKey(job)))) },
      { icon: 'square-x', label: 'Clear ticks', run: () => setTicks([]) },
    ];
    return {
      groups: [status, apply],
      more: [
        { head: 'Change stage', actions: status },
        { head: 'Set a custom field', actions: fields },
        { head: 'Apply an action', actions: apply },
        { head: 'Selection', actions: selection },
      ],
    };
  }

  // Move the ticked jobs to one stage. A work system's own stages
  // (Seazona) cannot be moved from Flow in bulk yet, so this says so; a
  // lab's own stages are custom fields (Field). Someone who needs it can
  // report it (Report a problem).
  async function moveMany(jobs) {
    const systems = [...new Set(jobs.map((job) => SYSTEM_NAME[job.sourceSystem] ?? job.sourceSystem))].join(' and ');
    await ui.dialog({
      title: 'Not yet available',
      body: h('p', {}, `Moving ${plural(jobs.length, 'job', 'jobs')} to a ${systems} stage at once is not yet available.`),
      confirm: 'OK',
    });
  }

  // One step on each job's invoice record, one job after the other.
  async function eachJob(jobs, step) {
    let done = 0;
    const refused = [];
    for (const job of jobs) {
      try { await step(job); done += 1; } catch (e) { refused.push(e); }
    }
    return { done, refused };
  }

  async function readyMany(jobs) {
    const { done, refused } = await eachJob(jobs, (job) => flow(`/api/invoicing/jobs/${job.obligation.id}/ready`, { method: 'POST', body: JSON.stringify({ ready: true }) }));
    ui.toast?.(refused.length ? `${done} ready to invoice. ${refused[0].message}` : `${plural(done, 'job', 'jobs')} ready to invoice.`, refused.length ? 'danger' : 'success');
    state.ticked.clear();
    await load();
  }

  async function draftMany(jobs) {
    const ok = await ui.dialog({
      title: `Draft ${plural(jobs.length, 'invoice', 'invoices')}?`,
      body: h('p', {}, 'Flow makes a draft invoice for each job. The drafts stay in Flow until a person checks them.'),
      confirm: `Draft ${jobs.length}`,
    });
    if (!ok) return;
    const { done, refused } = await eachJob(jobs, (job) => flow(`/api/invoicing/jobs/${job.obligation.id}/draft`, { method: 'POST', body: '{}' }));
    ui.toast?.(refused.length ? `${done} drafted. ${plural(refused.length, 'job was', 'jobs were')} not drafted: open ${refused.length === 1 ? 'it' : 'them'} to see why.` : `${plural(done, 'draft invoice', 'draft invoices')} made.`, refused.length ? 'danger' : 'success');
    state.ticked.clear();
    await load();
  }

  // Set one custom field on the ticked jobs, in Flow only: choose the
  // custom field, then its value. `fieldId` starts on that custom field.
  // A dropdown, person or checkbox has a list of values; a date, number or
  // text has a box. An empty box clears the value.
  async function setMany(jobs, fieldId = null) {
    const fields = state.fields;
    if (!fields.length) return;
    const lanesOf = (field) => fieldLanes(field, { people: state.people, jobs: state.jobs, valueOf: (job) => valueOf(job, field.id)?.value ?? null }).filter((lane) => !lane.archived);
    const listed = (field) => field.groupable;
    const pickField = h('select', { class: 'fx-select', name: 'field', 'aria-label': 'Custom field' },
      fields.map((f) => h('option', { value: f.id, selected: f.id === fieldId }, f.name)));
    const valueHost = h('div', {});
    const fieldOf = (id) => fields.find((f) => f.id === id) ?? fields[0];
    const fillValue = () => {
      const field = fieldOf(pickField.value);
      const control = listed(field)
        ? h('select', { class: 'fx-select', name: 'value', 'aria-label': 'Value' }, lanesOf(field).map((lane, i) => h('option', { value: String(i) }, lane.label)))
        : h('input', {
          class: 'fx-input', name: 'value', 'aria-label': 'Value',
          type: field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text', step: field.type === 'number' ? 'any' : null, maxlength: field.type === 'text' ? '500' : null,
        });
      valueHost.replaceChildren(h('label', { class: 'fx-field' }, h('span', {}, 'Value'), control));
    };
    pickField.addEventListener('change', fillValue);
    fillValue();
    const data = await ui.dialog({
      title: `Set a custom field on ${plural(jobs.length, 'job', 'jobs')}`,
      body: h('div', { class: 'fx-fields' }, h('label', { class: 'fx-field' }, h('span', {}, 'Custom field'), pickField), valueHost),
      confirm: 'Set',
    });
    if (!data) return;
    const field = fields.find((f) => f.id === data.get('field'));
    if (!field) return;
    let value;
    let shown;
    if (listed(field)) {
      const lane = lanesOf(field)[Number(data.get('value'))];
      if (!lane) return;
      ({ value } = lane);
      shown = lane.label;
    } else {
      const raw = String(data.get('value') ?? '').trim();
      value = raw === '' ? null : field.type === 'number' ? Number(raw) : raw;
      shown = raw === '' ? 'empty' : field.type === 'date' ? fullDate(raw) : raw;
    }
    for (const job of jobs) await setValue(job, field, value);
    ui.toast?.(`${field.name} set to ${shown} on ${plural(jobs.length, 'job', 'jobs')}.`, 'success');
  }

  async function copyLines(lines) {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      ui.toast?.(`${plural(lines.length, 'line', 'lines')} copied.`, 'success');
    } catch {
      ui.toast?.('The browser did not allow a copy.', 'danger');
    }
  }

  // The ticked rows as a CSV file, with the columns on the screen.
  function exportCsv(jobs) {
    const cell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    const lines = [['Case', 'Client', 'Practitioner', 'Stage', 'Due', 'Ordered', 'Total']]
      .concat(jobs.map((job) => [caseNumber(job) ?? '', clientOf(job), job.practitioner ?? '', statusOf(job), job.dueOn ?? '', job.orderedOn ?? '',
        job.totalCents == null ? '' : (job.totalCents / 100).toFixed(2)]));
    const url = URL.createObjectURL(new Blob([lines.map((l) => l.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }));
    const a = h('a', { href: url, download: `jobs-${today()}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ui.toast?.(`${plural(jobs.length, 'job', 'jobs')} exported.`, 'success');
  }

  // What a person can do with the job's invoice from here.
  function actions(job, close) {
    const o = job.obligation;
    if (!o) return [];
    if (o.invoiceId) {
      const label = o.invoiceStatus === 'draft' ? 'Open draft invoice' : `Open invoice ${o.invoiceNumber ?? ''}`.trim();
      // A changed job is accepted in the panel's sidecar (Fix tab).
      return [h('a', { class: 'fx-btn', href: `/invoices/${o.invoiceId}`, onclick: (event) => { close(); ui.go(event); } }, label)];
    }
    // Flow's own stage: a person marks a job ready to invoice, or an
    // automation does (Settings, Automations).
    if (o.view === 'in_work') {
      return [h('button', {
        class: 'fx-btn', type: 'button',
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            await flow(`/api/invoicing/jobs/${o.id}/ready`, { method: 'POST', body: JSON.stringify({ ready: true }) });
            ui.toast('Marked ready to invoice.', 'success');
          } catch (error) {
            ui.toast(error.message, 'danger');
          }
          close();
          await load();
        },
      }, 'Mark ready to invoice')];
    }
    if (o.view !== 'ready' || !state.canDraft) return [];
    return [h('button', {
      class: 'fx-btn fx-btn--primary', type: 'button',
      onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const { invoice } = await flow(`/api/invoicing/jobs/${o.id}/draft`, { method: 'POST', body: '{}' });
          ui.toast('Draft invoice made.', 'success');
          close();
          ui.go(`/invoices/${invoice.id}`);
        } catch (error) {
          const reasons = error.details?.reasons;
          ui.toast(reasons?.length ? `Not drafted: ${reasons.join('; ')}.` : error.message, 'danger');
          close();
          await load();
        }
      },
    }, 'Draft invoice')];
  }

  // The job's page: a large panel over the board, like a task page. A
  // breadcrumb, the client's name, the stage, the job's fields, what to fix
  // and its lines. At the side (below on a phone), the sidecar: Activity,
  // and Fix when the job has a problem (for a changed job: what changed,
  // and Accept change). The sidecar closes, and the main area takes its room.
  // Esc, the X or a click outside closes the panel. `atFix` opens the
  // Fix tab on the first problem (or scrolls to the invoice choice). The job's custom fields can
  // be changed here (in Flow only), and its stage moved (a hand-off to the
  // work system).
  function openJob(job, { atFix = false } = {}) {
    const o = job.obligation;
    const stage = invoiceStage(o);
    const found = problemsOf(job);
    const choose = found.find((f) => f.go === 'choose') ?? null;
    // The job changed after its draft: its Fix shows the change.
    const reviewable = Boolean(o?.invoiceId) && found.some((f) => f.go === 'review');
    const system = SYSTEM_NAME[job.sourceSystem] ?? job.sourceSystem;
    const status = job.status ?? NO_STATUS;
    const late = isLate(job);
    const field = (term, value, attrs = {}) => (value == null || value === '' ? null
      : h('div', {}, h('dt', {}, term), h('dd', attrs, value)));
    const link = (attrs, text) => h('a', { class: 'fx-task__link', ...attrs }, text);
    const element = h('dialog', { class: 'fx-dialog fx-task', 'aria-label': clientOf(job) });
    const close = () => element.close();
    const invoiceText = o?.invoiceId
      ? link({ href: `/invoices/${o.invoiceId}`, onclick: (event) => { close(); ui.go(event); } },
        `${o.invoiceStatus === 'draft' ? 'Draft' : 'Invoice'} ${o.invoiceNumber ?? ''}`.trim() + (stage ? ` · ${INVOICE_STAGES[stage]}` : ''))
      : choose ? h('span', { class: 'fx-task__none' }, svg(WARN_ICON), 'Needs invoice')
        : stage ? INVOICE_STAGES[stage] : o ? 'Not ready to invoice' : 'No invoice yet';
    const rest = found.filter((f) => f.go !== 'choose');
    // What to fix: one chip a problem, beside the stage, so the panel keeps
    // one layout with or without a fix. A chip is a toggle: a click opens
    // the sidecar's Fix tab on that problem and shows the chip pressed; a
    // second click closes the sidecar. In the tab the problem is fixed: the
    // change and Accept change for a changed job, else what is wrong, what
    // to do and one button.
    const hasFix = rest.length > 0;
    let picked = null;
    const fixChips = rest.map((f, i) => h('button', {
      class: 'fx-task__fixchip', type: 'button', 'aria-pressed': 'false', onclick: () => toggleFix(i),
    }, lucide(h, 'triangle-alert'), f.label));
    function toggleFix(i) {
      if (picked === i && side.tab() === 'fix') { side.close(); return; }
      picked = i;
      side.open('fix');
      // On a phone the sidecar is below the job: bring it into view.
      if (matchMedia('(max-width: 720px)').matches) side.element.scrollIntoView({ block: 'start' });
    }
    // No invoice, and the match is unclear: one line and two buttons. The
    // possible matches are compared on the Reconcile page, not here.
    const chooseBox = choose ? h('section', { class: 'fx-task__choose', 'aria-label': 'Invoice' },
      svg(WARN_ICON),
      h('span', {}, choose.text),
      h('div', { class: 'fx-task__choices' },
        state.canDraft ? h('button', { class: 'fx-btn fx-btn--primary', type: 'button', onclick: (event) => makeInvoice(event.currentTarget) }, 'Make invoice') : null,
        h('a', { class: 'fx-btn', href: `/reconcile/${o.id}`, onclick: (event) => { close(); ui.go(event); } }, 'Reconcile'))) : null;
    // "Make invoice": the person says the job has no invoice yet, then Flow
    // drafts it (the live check before the draft still runs).
    async function makeInvoice(button) {
      if (button) button.disabled = true;
      try {
        await flow(`/api/invoicing/jobs/${o.id}/no-invoice`, { method: 'POST', body: '{}' });
        const { invoice } = await flow(`/api/invoicing/jobs/${o.id}/draft`, { method: 'POST', body: '{}' });
        ui.toast('Draft invoice made.', 'success');
        close();
        ui.go(`/invoices/${invoice.id}`);
      } catch (error) {
        const reasons = error.details?.reasons;
        ui.toast(reasons?.length ? `Not drafted: ${reasons.join('; ')}.` : error.message, 'danger');
        close();
        await load();
      }
    }
    // Each fix's link: Flow's own invoice, the job in the work system, or
    // the Flow page where the fix is made (job-board.js GO).
    function fixLink(go, tip = null) {
      const button = (icon, text, attrs) => h(attrs.href ? 'a' : 'button', {
        class: 'fx-btn fx-btn--sm fx-btn--primary fx-task__fixgo', title: tip, ...(attrs.href ? {} : { type: 'button' }), ...attrs,
      }, lucide(h, icon), text);
      const inFlow = (icon, href, text) => button(icon, text, { href, onclick: (event) => { close(); ui.go(event); } });
      if ((go === 'review' || go === 'invoice') && o?.invoiceId) return inFlow('file-text', `/invoices/${o.invoiceId}`, 'Invoice');
      if (go === 'work' && job.link?.url) return button('external-link', system, { href: job.link.url, target: '_blank', rel: 'noopener' });
      if (go === 'price-list') return inFlow('tag', '/price-list', 'Price list');
      if (go === 'invoicing-settings') return inFlow('list-checks', '/invoicing-settings', 'Rules');
      if (go === 'integrations' && ui.me?.person?.role === 'owner') return inFlow('plug', '/integrations', 'Integrations');
      return null;
    }
    const lines = job.lines ?? [];
    const activity = h('ol', {}, h('li', { class: 'fx-dim' }, 'Loading…'));
    const activityBody = h('div', { class: 'fx-task__activity' },
      o ? activity : h('p', { class: 'fx-dim' }, `Flow has no invoice record for this job yet. It makes one when ${system} reports the job complete.`));
    // The change: as the invoice page shows it (job-change.js),
    // read from the invoice when the sidecar first needs it.
    const reviewBody = h('div', { class: 'fx-task__review' }, h('p', { class: 'fx-dim' }, 'Loading…'));
    let reviewRead = false;
    const readReview = () => {
      if (reviewRead) return;
      reviewRead = true;
      flow(`/api/invoicing/invoices/${o.invoiceId}`).then(({ invoice }) => drawReview(invoice))
        .catch(() => reviewBody.replaceChildren(h('p', {}, 'Flow could not read the change.')));
    };
    function drawReview(invoice) {
      const change = invoice?.jobChange ?? null;
      reviewBody.replaceChildren(change
        ? jobChangeReview(ui, change, { money: formatCents, canAccept: state.canDraft, done: reopen })
        : h('p', { class: 'fx-dim' }, `The draft matches ${system}.`));
    }
    // After Accept change or a recheck: the board reads again, and this
    // job's panel opens again with its new facts.
    async function reopen() {
      await load();
      const fresh = state.jobs.find((j) => jobKey(j) === jobKey(job));
      close();
      if (fresh) openJob(fresh);
    }
    // The Fix tab: the picked problem (the first when the tab itself is
    // clicked).
    function fixBody() {
      const f = rest[picked ?? 0];
      if (f.go === 'review' && reviewable) {
        readReview();
        return h('section', { class: 'fx-task__fixitem', 'aria-label': f.label }, reviewBody);
      }
      return h('section', { class: 'fx-task__fixitem', 'aria-label': f.label },
        h('strong', {}, f.label), h('p', {}, f.text), f.todo ? h('p', { class: 'fx-dim' }, f.todo) : null, fixLink(f.go));
    }
    const sideButton = h('button', {
      class: 'fx-btn fx-btn--ghost fx-btn--icon', type: 'button', 'aria-label': 'Side panel', title: 'Side panel', 'aria-pressed': 'false',
      onclick: () => (side.isOpen() ? side.close() : side.open(readSide() === 'fix' && hasFix ? 'fix' : 'activity')),
    }, lucide(h, 'panel-right'));
    const side = sidecar(h, {
      label: 'Job side panel',
      tabs: [
        { id: 'activity', label: 'Activity', icon: 'history', render: () => activityBody },
        hasFix ? { id: 'fix', label: 'Fix', icon: 'triangle-alert', mark: true, render: () => { picked ??= 0; return fixBody(); } } : null,
      ].filter(Boolean),
      onChange: (tab) => {
        saveSide(tab);
        sideButton.setAttribute('aria-pressed', String(Boolean(tab)));
        if (tab !== 'fix') picked = null;
        fixChips.forEach((chip, i) => chip.setAttribute('aria-pressed', String(tab === 'fix' && picked === i)));
      },
    });
    side.element.classList.add('fx-task__side');
    element.append(h('div', { class: 'fx-task__grid' },
      h('div', { class: 'fx-task__main' },
        h('header', { class: 'fx-task__head' },
          h('nav', { class: 'fx-task__crumb', 'aria-label': 'Breadcrumb' },
            h('span', {}, 'Jobs'), h('span', { class: 'fx-task__slash', 'aria-hidden': 'true' }, '/'), h('span', {}, status)),
          h('div', { class: 'fx-task__tools' }, sideButton,
            h('button', { class: 'fx-btn fx-btn--ghost fx-btn--icon', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: close }, '✕'))),
        h('h2', { class: 'fx-task__title' }, clientOf(job)),
        h('div', { class: 'fx-task__stage' }, stagePill(status), fixChips),
        h('dl', { class: 'fx-task__fields' },
          field('Practitioner', job.practitioner),
          field(job.dueOn ? 'Due' : 'Ordered', job.dueOn ? fullDate(job.dueOn) : job.orderedOn ? fullDate(job.orderedOn) : null, late ? { class: 'fx-task__late' } : {}),
          job.dueOn ? field('Ordered', job.orderedOn ? fullDate(job.orderedOn) : null) : null,
          field('Total', job.totalCents == null ? null : formatCents(job.totalCents)),
          field('Case number', caseNumber(job), { class: 'fx-mono' }),
          job.link?.url ? field(system, link({ href: job.link.url, target: '_blank', rel: 'noopener' }, job.link.exact ? `Open case in ${system} ↗` : `Open ${system} ↗`)) : null,
          field(`${system} status`, job.status),
          field(`${system} client`, job.workClientName && job.workClientName !== job.clientName ? job.workClientName : null),
          field('Department', job.department),
          // The job links to Flow's invoice only. The invoice page shows its
          // link to an accounting system (its Linked card).
          field('Invoice', invoiceText)),
        chooseBox,
        state.fields.length ? h('section', { class: 'fx-task__custom', 'aria-label': 'Custom fields' },
          h('h3', {}, 'Custom fields'),
          h('dl', { class: 'fx-task__fields' }, state.fields.map((f) => h('div', {}, h('dt', {}, f.name), h('dd', {}, fieldControl(job, f)))))) : null,
        movesStages(job) ? h('section', { class: 'fx-task__custom', 'aria-label': `${system} stage` },
          h('h3', {}, `${system} stage`), stageControl(job)) : null,
        h('section', { class: 'fx-task__lines' },
          h('h3', {}, 'Lines'),
          lines.length ? h('table', {},
            h('colgroup', {}, h('col', {}), h('col', { class: 'fx-task__col-code' }), h('col', { class: 'fx-task__col-amount' })),
            h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Price code'), h('th', { class: 'fx-num' }, 'Amount'))),
            h('tbody', {}, lines.map((line) => h('tr', {},
              h('td', {}, line.description),
              line.code && line.mapped ? h('td', { class: 'fx-mono' }, line.code)
                : h('td', { class: 'fx-task__miss', title: line.code ? `${line.code} is not in the price list` : null }, line.code ? `${line.code}: not in the price list` : 'No price code'),
              h('td', { class: 'fx-num' }, line.amountCents == null ? '—' : formatCents(line.amountCents))))),
            h('tfoot', {}, h('tr', {}, h('td', {}, 'Total'), h('td', {}),
              h('td', { class: 'fx-num' }, job.totalCents == null ? '—' : formatCents(job.totalCents)))))
            : h('p', { class: 'fx-dim' }, 'No lines.')),
        h('div', { class: 'fx-task__actions' }, actions(job, close))),
      side.element));
    element.addEventListener('click', (event) => { if (event.target === element) close(); });
    element.addEventListener('close', () => element.remove());
    document.body.append(element);
    element.showModal();
    const last = readSide();
    if (atFix && hasFix) toggleFix(0);
    else if (last !== 'closed') side.open(last === 'fix' && hasFix ? 'fix' : 'activity');
    if (atFix && chooseBox) chooseBox.scrollIntoView({ block: 'start' });
    if (!o) return;
    const when = (iso) => new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    flow(`/api/invoicing/jobs/${o.id}/activity`).then(({ events }) => {
      activity.replaceChildren(...(events.length ? events.map((e) => h('li', {},
        `${ACTIVITY[e.kind] ?? e.kind.replaceAll('_', ' ')} (${BY[e.by] ?? SYSTEM_NAME[e.by] ?? e.by})`,
        h('time', { datetime: e.createdAt }, when(e.createdAt))))
        : [h('li', {}, 'Nothing yet.')]));
    }).catch(() => activity.replaceChildren(h('li', {}, 'Flow could not read the activity.')));
  }

  await load();
}
