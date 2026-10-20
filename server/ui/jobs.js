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

import { formatCents } from '/assets/ui/invoicing.js';
import {
  caseNumber, FINAL_RANK, fixes, INVOICE_STAGES, invoiceStage, matches, NO_STATUS, orderStatuses, problemSummary, statusRank,
} from '/assets/ui/job-board.js';
import {
  DEFAULT_VIEW, fieldGroup, fieldIdOf, fieldLanes, filterCount, filterJobs, groupJobs, GROUPS, laneOf, normaliseJobsView, NOT_SET, sortJobs, SORTS,
} from '/assets/ui/job-view.js';

const LAYOUT_KEY = 'flow_jobs_layout';
const SYSTEM_NAME = { seazona: 'Seazona', xero: 'Xero' };
// A job's events (server/core/ledger.js), in plain words.
const ACTIVITY = {
  observed: 'Flow read the job', source_changed: 'The job changed in the lab system', ready: 'Marked ready to invoice',
  in_work: 'Put back in work', drafted: 'Draft invoice made', draft_refused: 'Draft invoice refused',
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
const clientOf = (job) => job.clientName ?? 'No client';
// The one date a card shows: when the job is due, else when it was ordered.
const dateOf = (job) => (job.dueOn ? `Due ${showDate(job.dueOn)}` : job.orderedOn ? `Ordered ${showDate(job.orderedOn)}` : job.jobDate ? showDate(job.jobDate) : null);

function readLayout() {
  try { return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'board'; } catch { return 'board'; }
}

function saveLayout(layout) {
  try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* the choice is only a convenience */ }
}

// The local calendar day, as yyyy-mm-dd, to mark late jobs.
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const WARN_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6v3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".9" fill="currentColor"/></svg>';
const PERSON_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 14c.6-2.8 2.8-4.3 5.5-4.3s4.9 1.5 5.5 4.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const GROUP_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 14.5 5 8 8.2 1.5 5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="m1.5 8.2 6.5 3.2 6.5-3.2M1.5 11.2 8 14.4l6.5-3.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const SORT_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5-3.5L11.5 6M4.5 10 8 13.5l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FILTER_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h12M4.5 8h7M7 12.5h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const TICK_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.5 3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CALENDAR_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

export async function renderJobs(main, ui) {
  const { h, flow, pageHeader, notice } = ui;
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
  };
  const toggle = h('div', { class: 'fx-seg', role: 'radiogroup', 'aria-label': 'Layout' });
  const search = h('input', { class: 'fx-input fx-search', type: 'search', placeholder: 'Find a case, client or practitioner', 'aria-label': 'Find a job', value: asked });
  const host = h('div', { class: 'fx-jobs' }, h('div', { class: 'fx-skeleton' }));
  const controls = h('div', { class: 'fx-viewbar', role: 'group', 'aria-label': 'Group, sort and filter' });
  main.classList.add('fx-main--wide');
  main.append(
    pageHeader('Jobs', { subtitle: 'Every job in the lab system, by its status there.' }),
    h('div', { class: 'fx-toolbar fx-toolbar--plain' }, controls, h('div', { class: 'fx-toolbar__end' }, search, toggle)),
    host);

  const drawToggle = () => toggle.replaceChildren(...[['board', 'Board'], ['list', 'List']].map(([id, label]) => h('button', {
    type: 'button', role: 'radio', class: 'fx-seg__item', 'aria-checked': String(state.view.layout === id),
    onclick: () => { saveLayout(id); change({ layout: id }); drawToggle(); },
  }, label)));
  drawToggle();
  search.addEventListener('input', () => { state.q = search.value.trim(); draw(); });

  const problemsOf = (job) => fixes(job.obligation);
  const valueKey = (job, fieldId) => `${job.sourceSystem}\u0000${job.sourceJobRef}\u0000${fieldId}`;
  const valueOf = (job, fieldId) => state.values.get(valueKey(job, fieldId)) ?? null;
  const groupable = () => state.fields.filter((f) => f.groupable);
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
  let saveTimer = null;
  function change(patch) {
    state.view = normaliseJobsView({ ...state.view, ...patch });
    if (ui.me) ui.me.views = { ...ui.me.views, jobs: state.view };
    drawControls();
    draw();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      flow('/api/me/views/jobs', { method: 'PUT', body: JSON.stringify(state.view) })
        .catch(() => ui.toast?.('Flow could not save your view. It applies on this page only.', 'danger'));
    }, 500);
  }

  // One toolbar control: a button that opens a small menu under it. The menu
  // is a popover, so a click outside or Escape closes it.
  let menuCount = 0;
  function menu(icon, build) {
    const id = `fx-jobs-menu-${++menuCount}`;
    const panel = h('div', { class: 'fx-pop', id, popover: 'auto', role: 'menu' });
    const button = h('button', { type: 'button', class: 'fx-chip', popovertarget: id, 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    const fill = () => panel.replaceChildren(...build(fill, () => panel.hidePopover()).filter(Boolean));
    panel.addEventListener('toggle', (event) => {
      button.setAttribute('aria-expanded', String(event.newState === 'open'));
      if (event.newState !== 'open') return;
      fill();
      const at = button.getBoundingClientRect();
      panel.style.top = `${Math.round(at.bottom + 6)}px`;
      panel.style.left = `${Math.round(Math.max(8, Math.min(at.left, innerWidth - panel.offsetWidth - 8)))}px`;
    });
    return {
      node: [button, panel],
      set(label, on) {
        button.replaceChildren(svg(icon), h('span', {}, label));
        button.classList.toggle('fx-chip--on', on);
      },
    };
  }

  // A choice in a menu: a row with a tick when it is chosen.
  const option = (text, checked, onclick, role = 'menuitemradio') => h('button', {
    type: 'button', class: 'fx-pop__item', role, 'aria-checked': String(checked), onclick,
  }, h('span', { class: 'fx-pop__tick' }, checked ? svg(TICK_ICON) : null), h('span', {}, text));
  const heading = (text) => h('p', { class: 'fx-pop__head' }, text);
  const DIR_WORDS = { total: ['Low to high', 'High to low'], due: ['Oldest first', 'Newest first'], board: ['As the lab system has it', 'Reversed'] };

  const groupMenu = menu(GROUP_ICON, (_redraw, close) => [
    heading('Group by'),
    ...Object.entries(GROUPS).map(([id, text]) => option(text, state.view.group === id, () => { change({ group: id }); close(); })),
    groupable().length ? h('div', { class: 'fx-pop__sep' }) : null,
    groupable().length ? heading('Custom fields') : null,
    ...groupable().map((f) => option(f.name, state.view.group === fieldGroup(f.id), () => { change({ group: fieldGroup(f.id) }); close(); })),
  ]);
  const sortMenu = menu(SORT_ICON, (redraw) => {
    const [up, down] = DIR_WORDS[state.view.sort] ?? ['A to Z', 'Z to A'];
    return [
      heading('Sort by'),
      ...Object.entries(SORTS).map(([id, text]) => option(text, state.view.sort === id, () => { change({ sort: id }); redraw(); })),
      h('div', { class: 'fx-pop__sep' }),
      option(up, state.view.dir === 'asc', () => { change({ dir: 'asc' }); redraw(); }),
      option(down, state.view.dir === 'desc', () => { change({ dir: 'desc' }); redraw(); }),
    ];
  });
  const filterMenu = menu(FILTER_ICON, (redraw) => {
    const hidden = new Set(state.view.hide);
    return [
      heading('Show only'),
      option('Late jobs', state.view.late, () => { change({ late: !state.view.late }); redraw(); }, 'menuitemcheckbox'),
      option('Jobs with a problem', state.view.problems, () => { change({ problems: !state.view.problems }); redraw(); }, 'menuitemcheckbox'),
      h('div', { class: 'fx-pop__sep' }),
      heading('Statuses'),
      ...orderStatuses(state.statuses, state.jobs).map((label) => option(label, !hidden.has(label), () => {
        const next = new Set(hidden);
        if (next.has(label)) next.delete(label); else next.add(label);
        change({ hide: [...next] });
        redraw();
      }, 'menuitemcheckbox')),
      filterCount(state.view) ? h('div', { class: 'fx-pop__foot' }, h('button', {
        type: 'button', class: 'fx-btn fx-btn--ghost fx-btn--sm', onclick: () => { change({ hide: [], late: false, problems: false }); redraw(); },
      }, 'Clear filters')) : null,
    ];
  });
  controls.append(...groupMenu.node, ...sortMenu.node, ...filterMenu.node);

  function drawControls() {
    const { group, sort, dir } = state.view;
    const field = fieldOfGroup(group);
    groupMenu.set(`Group: ${field?.name ?? GROUPS[group] ?? GROUPS.status}`, group !== DEFAULT_VIEW.group && (Boolean(field) || Boolean(GROUPS[group])));
    const sorted = sort !== DEFAULT_VIEW.sort || dir !== DEFAULT_VIEW.dir;
    sortMenu.set(sorted ? `Sort: ${SORTS[sort]}${dir === 'desc' ? ' ↓' : ''}` : 'Sort', sorted);
    const count = filterCount(state.view);
    filterMenu.set(count ? `Filter · ${count}` : 'Filter', count > 0);
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
      { status: statusOf, late: isLate, problem: (job) => problemsOf(job).length > 0 });
    const groups = grouped(sortJobs(found, state.view));
    main.classList.toggle('fx-main--board', state.view.layout === 'board');
    host.replaceChildren(state.view.layout === 'list' ? list(groups, found.length) : board(groups));
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
  function grouped(jobs) {
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
    if (group === 'status' || !GROUPS[group]) {
      const hidden = new Set(state.view.hide);
      return groupJobs(jobs, orderStatuses(state.statuses, state.jobs).filter((label) => !hidden.has(label)), laneStatusOf)
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
        ? state.people.map((p) => ({ value: p.id, label: p.name }))
        : field.options.filter((o) => !o.archived || o.id === current).map((o) => ({ value: o.id, label: o.archived ? `${o.name} (archived)` : o.name }));
      const select = h('select', { class: 'fx-select fx-task__input', 'aria-label': label },
        h('option', { value: '' }, NOT_SET), choices.map((c) => h('option', { value: c.value, selected: c.value === current }, c.label)));
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

  // The list: one block per group, with the group's label over its rows.
  function list(groups, count) {
    if (!count) return h('div', { class: 'fx-panel' }, h('p', { class: 'fx-empty' }, 'No job matches the search or filter.'));
    const row = (job) => h('tr', {
      class: 'fx-row-link', tabindex: '0',
      onclick: () => openJob(job),
      onkeydown: (event) => { if (event.key === 'Enter') openJob(job); },
    },
    h('td', {}, h('span', { class: 'fx-job__cell' }, h('span', { class: 'fx-strong' }, clientOf(job)), problemMark(job))),
    h('td', { class: 'fx-dim' }, job.practitioner ?? '—'),
    h('td', {}, job.status ?? NO_STATUS),
    h('td', { class: 'fx-dim' }, dateOf(job) ?? '—'),
    h('td', { class: 'fx-num fx-strong' }, job.totalCents == null ? '—' : formatCents(job.totalCents)));
    return h('div', { class: 'fx-panel' }, h('table', { class: 'fx-table fx-table--jobs' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Client'), h('th', {}, 'Practitioner'), h('th', {}, 'Stage'), h('th', {}, 'Date'),
        h('th', { class: 'fx-num' }, 'Total'))),
      groups.filter((g) => g.jobs.length).map(({ label, jobs, rank }) => h('tbody', {},
        h('tr', { class: 'fx-table__group' }, h('td', { colspan: '5' },
          h('span', { class: 'fx-table__group-row' }, stagePill(label, jobs.length, rank), h('span', { class: 'fx-board__sum' }, formatCents(totalOf(jobs)))))),
        jobs.map(row)))));
  }

  // What a person can do with the job's invoice from here.
  function actions(job, close) {
    const o = job.obligation;
    if (!o) return [];
    if (o.invoiceId) {
      const label = o.invoiceStatus === 'draft' ? 'Open draft invoice' : `Open invoice ${o.invoiceNumber ?? ''}`.trim();
      const open = h('a', { class: 'fx-btn', href: `/invoices/${o.invoiceId}`, onclick: (event) => { close(); ui.go(event); } }, label);
      // Only the job changed and the draft is not sent (ledger.js): one tap
      // puts the job's new lines on Flow's own draft. Nothing goes elsewhere.
      if (!o.canUseNewLines) return [open];
      const system = SYSTEM_NAME[job.sourceSystem] ?? job.sourceSystem;
      return [h('button', {
        class: 'fx-btn fx-btn--primary', type: 'button',
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            await flow(`/api/invoicing/jobs/${o.id}/use-new-lines`, { method: 'POST', body: '{}' });
            ui.toast(`The draft invoice now matches ${system}.`, 'success');
          } catch (error) {
            ui.toast(error.message, 'danger');
          }
          close();
          await load();
        },
      }, `Adopt ${system} changes`), open];
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
  // and its lines; its activity at the side (below on a phone). Esc, the X
  // or a click outside closes it. `atFix` scrolls to what to fix. The job's
  // custom fields can be changed here (in Flow only), and its stage moved
  // (a hand-off to the work system).
  function openJob(job, { atFix = false } = {}) {
    const o = job.obligation;
    const stage = invoiceStage(o);
    const found = problemsOf(job);
    const choose = found.find((f) => f.go === 'choose') ?? null;
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
    const fixBox = rest.length ? h('section', { class: 'fx-task__fix', 'aria-label': 'Fix' },
      h('h3', {}, 'Fix'),
      rest.map((f) => h('div', { class: 'fx-task__fixrow' }, h('span', {}, [f.text, f.todo].filter(Boolean).join(' ')), fixLink(f.go)))) : null;
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
    function fixLink(go) {
      const inFlow = (href, text) => h('a', { class: 'fx-task__link', href, onclick: (event) => { close(); ui.go(event); } }, text);
      if (go === 'invoice' && o?.invoiceId) return inFlow(`/invoices/${o.invoiceId}`, 'Open invoice');
      if (go === 'work' && job.link?.url) {
        return h('a', { class: 'fx-task__link', href: job.link.url, target: '_blank', rel: 'noopener' }, job.link.exact ? `Open case in ${system} ↗` : `Open ${system} ↗`);
      }
      if (go === 'price-list') return inFlow('/price-list', 'Open price list');
      if (go === 'invoicing-settings') return inFlow('/invoicing-settings', 'Open invoice rules');
      if (go === 'integrations' && ui.me?.person?.role === 'owner') return inFlow('/integrations', 'Open integrations');
      return null;
    }
    const lines = job.lines ?? [];
    const activity = h('ol', {}, h('li', { class: 'fx-dim' }, 'Loading…'));
    element.append(h('div', { class: 'fx-task__grid' },
      h('div', { class: 'fx-task__main' },
        h('header', { class: 'fx-task__head' },
          h('nav', { class: 'fx-task__crumb', 'aria-label': 'Breadcrumb' },
            h('span', {}, 'Jobs'), h('span', { class: 'fx-task__slash', 'aria-hidden': 'true' }, '/'), h('span', {}, status)),
          h('button', { class: 'fx-btn fx-btn--ghost fx-btn--icon', type: 'button', 'aria-label': 'Close', onclick: close }, '✕')),
        h('h2', { class: 'fx-task__title' }, clientOf(job)),
        h('div', { class: 'fx-task__stage' }, stagePill(status)),
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
        fixBox,
        state.fields.length ? h('section', { class: 'fx-task__custom', 'aria-label': 'Custom fields' },
          h('h3', {}, 'Fields'),
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
      h('aside', { class: 'fx-task__activity', 'aria-label': 'Activity' },
        h('h3', {}, 'Activity'),
        o ? activity : h('p', { class: 'fx-dim' }, `Flow has no invoice record for this job yet. It makes one when ${system} reports the job complete.`))));
    element.addEventListener('click', (event) => { if (event.target === element) close(); });
    element.addEventListener('close', () => element.remove());
    document.body.append(element);
    element.showModal();
    if (atFix && (chooseBox ?? fixBox)) (chooseBox ?? fixBox).scrollIntoView({ block: 'start' });
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

function svg(markup) {
  const span = document.createElement('span');
  span.innerHTML = markup;
  return span.firstChild;
}
