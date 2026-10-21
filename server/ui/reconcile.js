// Reconcile: Flow's jobs with no Flow invoice, and Flow invoices with no job.
// Laid out like Jobs and Invoices:
//   /reconcile      every gap in one list, with the Jobs page's Filter chip
//                   (show jobs, invoices, with or without a possible match)
//                   and a search. Ticked jobs with no possible invoice get
//                   their drafts from the bulk bar. A row opens it.
//   /reconcile/:id  one gap, as an invoice opens from Invoices: the invoice
//                   pager on top ("← Back" to the list as it was, "n of N",
//                   previous and next), then the gap beside its possible
//                   other side, each fact marked same (✓) or different (≠),
//                   and a search for any other. A person links one, or for a
//                   job makes its invoice; then the next one opens.
//                   ?kind=invoice opens a Flow invoice with no job.
// Flow's own records only: matching a Flow invoice to an accounting system's
// is that integration's work. API: /api/invoicing/reconcile,
// /jobs/:id/reconcile, /invoices/:id/reconcile, /jobs/:id/link,
// /jobs/:id/no-invoice (docs/JOB_INVOICE_LINKS.md).
import { bulkBar } from '/assets/ui/bulk-bar.js';
import { lucide } from '/assets/ui/custom-fields.js';
import { columnTable, rowCells, viewSaver } from '/assets/ui/columns.js';
import { statusRank } from '/assets/ui/job-board.js';
import { filterJobs, KIND_OF_TYPE, normaliseListView, RECONCILE_COLUMNS } from '/assets/ui/job-view.js';
import { normaliseReconcileView, RECONCILE_FILTER_FIELDS } from '/assets/ui/list-views.js';
import { savedViews } from '/assets/ui/saved-views.js';
import { pager } from '/assets/ui/pager.js';
import { findBox, today, viewBar } from '/assets/ui/view-bar.js';
import { formatCents } from '/assets/ui/invoicing.js';

const STATUS = { draft: 'Draft', issued: 'Approved', void: 'Void' };
const fullDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const shortDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '—');
const money = (cents) => (cents == null ? '—' : formatCents(cents));
const lineText = (l) => `${l.code ?? l.description ?? '—'} ${money(l.amountCents)}`;

// The words for how far one date is from another.
export function dayWords(days) {
  if (days == null) return null;
  if (days === 0) return 'same day';
  const n = Math.abs(days);
  return `${n} day${n === 1 ? '' : 's'} ${days > 0 ? 'later' : 'earlier'}`;
}

export const statusWords = (status) => STATUS[status] ?? status ?? '—';

const dateMark = (c) => (c.date ? (Math.abs(c.date.days) <= 3 ? 'same' : 'differs') : null);
const othersMark = (n) => (n ? 'differs' : 'same');

// The facts of a job and of each candidate Flow invoice: { label, value, mark }.
export function jobFacts(job) {
  return [
    { label: 'Client', value: job.clientName ?? '—' },
    { label: 'Reference', value: job.reference ?? '—' },
    { label: 'Date', value: fullDate(job.jobDate) },
    { label: 'Lines', value: job.lines.map(lineText) },
    { label: 'Total', value: money(job.totalCents) },
    { label: 'Other jobs', value: '—' },
    { label: 'Status', value: job.sourceStatus ?? '—' },
  ];
}

export function invoiceCandidateFacts(invoice) {
  const c = invoice.checks;
  return [
    { label: 'Client', value: c.client === 'same' ? 'Same' : invoice.clientName ?? '—', mark: c.client },
    { label: 'Reference', value: invoice.reference ?? '—', mark: c.reference },
    { label: 'Date', value: [shortDate(invoice.date), dayWords(c.date?.days)].filter(Boolean).join(' · '), mark: dateMark(c) },
    { label: 'Lines', value: invoice.lines.map(lineText), mark: c.lines },
    { label: 'Total', value: money(invoice.totalCents), mark: c.total },
    { label: 'Other jobs', value: c.others ? `Linked to ${c.others} other job${c.others === 1 ? '' : 's'}` : 'None', mark: othersMark(c.others) },
    { label: 'Status', value: statusWords(invoice.status), mark: null },
  ];
}

// The facts of a Flow invoice and of each candidate job.
function invoiceFacts(invoice) {
  return [
    { label: 'Client', value: invoice.clientName ?? '—' },
    { label: 'Reference', value: invoice.reference ?? '—' },
    { label: 'Date', value: fullDate(invoice.date) },
    { label: 'Lines', value: invoice.lines.map(lineText) },
    { label: 'Total', value: money(invoice.totalCents) },
    { label: 'Status', value: statusWords(invoice.status) },
  ];
}

function jobCandidateFacts(job) {
  const c = job.checks;
  return [
    { label: 'Client', value: c.client === 'same' ? 'Same' : job.clientName ?? '—', mark: c.client },
    { label: 'Reference', value: job.practitioner ?? '—', mark: null },
    { label: 'Date', value: [shortDate(job.jobDate), dayWords(c.date?.days)].filter(Boolean).join(' · '), mark: dateMark(c) },
    { label: 'Lines', value: job.lines.map(lineText), mark: c.lines },
    { label: 'Total', value: money(job.totalCents), mark: c.total },
    { label: 'Status', value: job.sourceStatus ?? (job.ready ? 'Ready to invoice' : 'In work'), mark: null },
  ];
}


// The list's filter rows (view-bar.js), kept per viewer in this browser.
// The list a person opened a gap from, for the pager.
const FILTER_KEY = 'flow_reconcile_filters';
const NAV_KEY = 'flow_reconcile_nav';
// The fields a filter row can use. One word each; Type's choices have icons.
// The filter's fields: list-views.js (the server checks saved views with them).
const FILTER_FIELDS = RECONCILE_FILTER_FIELDS;
const MATCH_OPS = { yes: 'Has one', no: 'Has none' };
const SET_OPS = { is: 'Is', not: 'Is not' };
const TYPES = [{ value: 'job', label: 'Job', icon: 'briefcase' }, { value: 'invoice', label: 'Invoice', icon: 'file-text' }];

function readStored(store, key, fallback) {
  try { return JSON.parse(store.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeStored(store, key, value) {
  try { store.setItem(key, JSON.stringify(value)); } catch { /* the page still works, it forgets */ }
}

// One row for each gap, jobs and invoices together, oldest first.
export function reconcileRows({ jobs = [], invoices = [] }) {
  return [
    ...jobs.map((j) => ({
      kind: 'job', id: j.id, client: j.clientName, who: j.practitioner, stage: j.status ?? null, date: j.jobDate, totalCents: j.totalCents, possible: j.possible, unclear: j.unclear,
      key: j.sourceSystem && j.sourceJobRef ? `${j.sourceSystem}\u0000${j.sourceJobRef}` : null,
    })),
    ...invoices.map((i) => ({ kind: 'invoice', id: i.id, client: i.clientName, who: i.number ?? 'Draft', status: i.status, stage: statusWords(i.status), date: i.issueDate, totalCents: i.totalCents, possible: i.possible })),
  ].sort((a, b) => String(a.date ?? '9999').localeCompare(String(b.date ?? '9999')));
}

const isCustom = (field) => /^field:/.test(field);

// A row's value for a filter field, as the filter compares it. `valueOf`
// reads a job's custom field value: (row, fieldId) => value.
export function rowValue(row, field, valueOf = () => null) {
  switch (field) {
    case 'type': return row.kind;
    case 'status': return row.stage ?? null;
    case 'client': return row.client ?? null;
    case 'practitioner': return row.kind === 'job' ? row.who ?? null : null;
    case 'date': return row.date ?? null;
    case 'total': return row.totalCents == null ? null : row.totalCents / 100;
    case 'match': return row.possible > 0;
    default: return isCustom(field) && row.kind === 'job' ? valueOf(row, field.slice(6)) : null;
  }
}

// A view without the rows a record does not have: an invoice has no
// practitioner and no custom fields.
const forInvoices = (view) => ({ ...view, groups: view.groups.map((g) => ({ ...g, filters: g.filters.filter((f) => !FILTER_FIELDS[f.field]?.job && !isCustom(f.field)) })) });

// The rows a view keeps: its filter rows, then the search words. `kindOf`
// gives a field's kind (custom fields too); `valueOf` a custom value.
export function keptRows(rows, view, q = '', { kindOf = (field) => FILTER_FIELDS[field]?.kind ?? null, valueOf = () => null, now = today() } = {}) {
  const words = q.trim().toLowerCase();
  const keep = (list, v) => filterJobs(list, v, { valueOf: (row, field) => rowValue(row, field, valueOf), kindOf, today: now });
  const kept = new Set([...keep(rows.filter((r) => r.kind === 'job'), view), ...keep(rows.filter((r) => r.kind !== 'job'), forInvoices(view))]);
  return rows.filter((r) => kept.has(r))
    .filter((r) => !words || [r.client, r.who, money(r.totalCents)].some((v) => String(v ?? '').toLowerCase().includes(words)));
}

function readView() {
  return normaliseReconcileView(readStored(localStorage, FILTER_KEY, {}));
}

export async function renderReconcile(main, ui, id = null) {
  if (id) return renderGap(main, ui, id);
  return renderList(main, ui);
}

const pathOf = (row) => `/reconcile/${row.id}${row.kind === 'invoice' ? '?kind=invoice' : ''}`;
const KIND_ICON = { job: ['briefcase', 'Job'], invoice: ['file-text', 'Invoice'] };

async function renderList(main, ui) {
  const { h, flow, toast, listHead, listFrame } = ui;
  const icon = (name, label) => lucide(h, name, label);
  const canAct = ['owner', 'admin'].includes(ui.me?.person?.role);
  const back = readStored(sessionStorage, NAV_KEY, null);
  const state = { view: readView(), q: back?.q ?? '', ticked: new Set(), columns: normaliseListView(ui.me?.views?.reconcile, RECONCILE_COLUMNS) };
  // The list's columns: resize, move, hide, kept with the account.
  const saveColumns = viewSaver(ui, 'reconcile');
  const heads = columnTable(h, {
    order: () => state.columns.columns,
    widths: () => state.columns.widths,
    change: (patch) => {
      state.columns = normaliseListView({ ...state.columns, ...patch }, RECONCILE_COLUMNS);
      saveColumns(state.columns);
      draw();
    },
    hidden: () => Object.keys(RECONCILE_COLUMNS).filter((id) => !state.columns.columns.includes(id)).map((id) => ({ id, label: RECONCILE_COLUMNS[id] })),
  });
  let rows;
  // A change to the filter: kept in this browser, and drawn.
  const setView = (patch) => {
    state.view = normaliseReconcileView({ ...state.view, ...patch });
    writeStored(localStorage, FILTER_KEY, state.view);
    views.draw();
    if (rows) draw();
  };
  // The person's named views (saved-views.js): their default opens on a
  // new visit.
  const views = savedViews(ui, { page: 'reconcile', current: () => state.view, apply: setView });
  const opening = views.opening();
  if (opening) state.view = normaliseReconcileView(opening);
  const find = findBox(h, { label: 'Find a client, practitioner or amount', value: state.q, oninput: (words) => { state.q = words; draw(); } });
  const controls = h('div', { class: 'fx-viewbar', role: 'group', 'aria-label': 'Filter' });
  const host = h('div', { class: 'fx-rec' }, h('div', { class: 'fx-skeleton' }));
  const bulk = bulkBar(ui, { label: 'Ticked jobs' });
  const frame = listFrame(main, host);
  main.append(...listHead('Reconcile', { views: views.element, start: controls, end: find.element }).nodes, frame.element, bulk.element);

  // The Filter chip: the same panel as on Jobs (view-bar.js). Job rows also
  // have the lab's custom fields.
  const custom = { fields: [], people: [], values: new Map() };
  const fieldById = (id) => custom.fields.find((f) => f.id === id) ?? null;
  const kindOf = (field) => FILTER_FIELDS[field]?.kind ?? (isCustom(field) ? KIND_OF_TYPE[fieldById(field.slice(6))?.type] ?? null : null);
  const valueOf = (row, fieldId) => (row.key ? custom.values.get(`${row.key}\u0000${fieldId}`) ?? null : null);
  const labels = (list) => [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
  const filterMenu = viewBar(h).filterMenu({
    fields: () => [
      ...Object.entries(FILTER_FIELDS).map(([value, f]) => ({ value, label: f.label, icon: f.icon })),
      ...custom.fields.filter((f) => KIND_OF_TYPE[f.type]).map((f) => ({ value: `field:${f.id}`, label: f.name })),
    ],
    kindOf,
    opsOf: (field) => (field === 'match' ? MATCH_OPS : ['type', 'status'].includes(field) ? SET_OPS : null),
    choicesOf: (field) => {
      if (field === 'type') return TYPES;
      if (field === 'status') return labels(rows.filter((r) => r.kind === 'job').map((r) => r.stage)).map((c) => ({ ...c, rank: statusRank(c.value) }))
        .concat(labels(rows.filter((r) => r.kind !== 'job').map((r) => r.stage)).filter((c) => !rows.some((r) => r.kind === 'job' && r.stage === c.value)));
      if (field === 'client') return labels(rows.map((r) => r.client));
      if (field === 'practitioner') return labels(rows.filter((r) => r.kind === 'job').map((r) => r.who));
      const f = isCustom(field) ? fieldById(field.slice(6)) : null;
      if (f?.type === 'person') return [{ value: 'me', label: 'Me' }, ...custom.people.map((p) => ({ value: p.id, label: p.name }))];
      return (f?.options ?? []).map((o) => ({ value: o.id, label: o.archived ? `${o.name} (archived)` : o.name, color: o.color }));
    },
    view: () => state.view,
    change: setView,
    first: 'type',
    empty: 'No filters. Every job and invoice shows.',
  });
  controls.append(...filterMenu.node);

  views.draw();
  try {
    // Custom fields are extra: the list still shows without them.
    const [lists, fields, values] = await Promise.all([
      flow('/api/invoicing/reconcile'), flow('/api/custom-fields').catch(() => null), flow('/api/custom-fields/values').catch(() => null),
    ]);
    rows = reconcileRows(lists);
    custom.fields = fields?.fields ?? [];
    custom.people = fields?.people ?? [];
    custom.values = new Map((values?.values ?? []).map((v) => [`${v.sourceSystem}\u0000${v.sourceJobRef}\u0000${v.fieldId}`, v.value]));
  } catch (error) {
    host.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
    return;
  }

  function draw() {
    filterMenu.draw();
    const shown = keptRows(rows, state.view, state.q, { kindOf, valueOf });
    const seen = new Set(shown.map((r) => r.id));
    frame.count(`${shown.length} to check`);
    for (const key of state.ticked) if (!seen.has(key)) state.ticked.delete(key);
    const remember = () => writeStored(sessionStorage, NAV_KEY, { q: state.q, rows: shown.map(({ kind, id }) => ({ kind, id })) });
    if (!rows.length) {
      host.replaceChildren(h('div', { class: 'fx-xi__done' }, icon('check-check'), h('p', {}, 'Every job has an invoice, and every invoice has a job.')));
      bulk.draw({ count: 0 });
      return;
    }
    if (!shown.length) {
      host.replaceChildren(h('p', { class: 'fx-empty' }, 'Nothing matches the filter or the search.'));
      bulk.draw({ count: 0 });
      return;
    }
    const tickable = shown.filter((r) => r.kind === 'job');
    const boxes = new Map();
    const drawBar = () => {
      const picked = tickable.filter((r) => state.ticked.has(r.id));
      const plain = picked.filter((r) => !r.possible);
      bulk.draw({
        count: canAct ? picked.length : 0,
        onClear: () => { state.ticked.clear(); draw(); },
        groups: [[
          { icon: 'file-plus', label: 'Make invoices', title: 'Make a draft invoice for each ticked job with no possible invoice', primary: true, run: async () => {
            if (!plain.length) { toast('Each ticked job has a possible invoice. Open it, and check it first.', 'warn'); return; }
            let made = 0;
            for (const row of plain) {
              try {
                if (row.unclear) await flow(`/api/invoicing/jobs/${row.id}/no-invoice`, { method: 'POST', body: '{}' });
                await flow(`/api/invoicing/jobs/${row.id}/draft`, { method: 'POST', body: '{}' });
                made += 1;
              } catch (error) {
                toast(error.message, 'danger');
              }
            }
            const kept = picked.length - plain.length;
            toast(`${made} draft${made === 1 ? '' : 's'} made.${kept ? ` ${kept} with a possible invoice stay here.` : ''}`, made ? 'success' : 'warn');
            ui.go('/reconcile');
          } },
        ]],
      });
    };
    const all = h('input', { type: 'checkbox', class: 'fx-tick', 'aria-label': 'Tick every job', checked: tickable.length > 0 && tickable.every((r) => state.ticked.has(r.id)), disabled: !tickable.length, onchange: () => {
      for (const r of tickable) { if (all.checked) state.ticked.add(r.id); else state.ticked.delete(r.id); }
      for (const b of boxes.values()) b.checked = all.checked;
      drawBar();
    } });
    const possible = (r) => (r.possible
      ? h('span', { class: 'fx-rec__possible', 'data-state': 'some' }, icon('link-2', 'Possible match'), String(r.possible))
      : h('span', { class: 'fx-rec__possible' }, icon('circle-dashed', 'No possible match')));
    const ALL = {
      kind: { kind: 'icon', icon: 'layers', className: 'fx-rec-list__kind', cell: (r) => icon(...KIND_ICON[r.kind]) },
      client: { kind: 'client', className: 'fx-strong', cell: (r) => r.client ?? h('span', { class: 'fx-dim' }, 'No client') },
      detail: { kind: 'text', cell: (r) => h('span', { class: r.kind === 'invoice' ? 'fx-num' : 'fx-dim' }, r.who ?? '—', r.kind === 'invoice' ? h('span', { class: 'fx-dim' }, ` · ${statusWords(r.status)}`) : null) },
      date: { kind: 'date', className: 'fx-dim', cell: (r) => shortDate(r.date) },
      total: { kind: 'total', num: true, cell: (r) => money(r.totalCents) },
      possible: { kind: 'status', className: 'fx-rec-list__mid', cell: possible },
    };
    const columns = state.columns.columns.map((id) => ({ id, label: RECONCILE_COLUMNS[id], ...ALL[id] }));
    host.replaceChildren(h('div', { class: 'fx-panel' }, heads.table({
      className: 'fx-table--rows fx-rec-list',
      columns,
      lead: canAct ? [h('th', { class: 'fx-tick-cell' }, all)] : [],
      rows: h('tbody', {}, shown.map((r) => {
        const box = r.kind === 'job' ? h('input', { type: 'checkbox', class: 'fx-tick', 'aria-label': `Tick ${r.client ?? 'job'}`, checked: state.ticked.has(r.id), onclick: (event) => event.stopPropagation(), onchange: () => {
          if (box.checked) state.ticked.add(r.id); else state.ticked.delete(r.id);
          drawBar();
        } }) : null;
        if (box) boxes.set(r.id, box);
        return h('tr', { 'data-kind': r.kind, onclick: () => { remember(); ui.go(pathOf(r)); } },
          canAct ? h('td', { class: 'fx-tick-cell', onclick: (event) => event.stopPropagation() }, box) : null,
          rowCells(h, columns, r),
          h('td', { class: 'fx-c-end' }));
      })),
    })));
    drawBar();
  }
  draw();
}

// One gap, opened from the list (or from a job's Reconcile button).
async function renderGap(main, ui, id) {
  const { h, flow, toast } = ui;
  const icon = (name, label) => lucide(h, name, label);
  const canAct = ['owner', 'admin'].includes(ui.me?.person?.role);
  const params = new URLSearchParams(location.search);
  const kind = params.get('kind') === 'invoice' || params.get('tab') === 'invoices' ? 'invoice' : 'job';

  // The pager steps through the list as it was; opened from elsewhere, it
  // steps through every gap of the same kind.
  let order = readStored(sessionStorage, NAV_KEY, null)?.rows ?? [];
  if (!order.some((r) => r.id === id)) {
    const lists = await flow('/api/invoicing/reconcile').catch(() => null);
    order = lists ? reconcileRows(lists).filter((r) => r.kind === kind).map(({ kind: k, id: i }) => ({ kind: k, id: i })) : [];
  }
  const at = order.findIndex((r) => r.id === id);
  const { element: pagerBar, draw: drawPager } = pager(h, {
    label: 'Reconcile',
    back: () => ui.go('/reconcile'),
  });
  const goRow = (row) => (row ? () => ui.go(pathOf(row)) : null);
  drawPager({
    count: at >= 0 ? `${at + 1} of ${order.length}` : '',
    prev: goRow(at > 0 ? order[at - 1] : null),
    next: goRow(at >= 0 ? order[at + 1] : null),
  });
  const next = () => {
    const rest = order.filter((r) => r.id !== id);
    writeStored(sessionStorage, NAV_KEY, { ...readStored(sessionStorage, NAV_KEY, {}), rows: rest });
    const to = rest[Math.min(Math.max(at, 0), rest.length - 1)];
    ui.go(to ? pathOf(to) : '/reconcile');
  };

  const title = h('h1', { class: 'fx-title' }, kind === 'job' ? 'Job with no invoice' : 'Invoice with no job');
  const sub = h('p', { class: 'fx-ph__sub' });
  const actions = h('div', { class: 'fx-ph__actions' });
  const results = h('div', { class: 'fx-rec__results' }, h('div', { class: 'fx-skeleton' }));
  let timer = null;
  const find = findBox(h, {
    label: kind === 'job' ? 'Find another invoice: number, client, Reference, amount' : 'Find another job: client, practitioner, case',
    oninput: (words) => {
      clearTimeout(timer);
      timer = setTimeout(() => load(words), 300);
    },
  });
  const card = h('section', { class: 'fx-rec fx-rec__gap', 'aria-label': 'Compare' },
    pagerBar,
    h('header', { class: 'fx-ph' }, h('div', { class: 'fx-ph__text' }, title, sub), actions),
    // The search sits where it does on Jobs and Invoices: the right of the
    // toolbar over the rows it searches.
    h('div', { class: 'fx-toolbar fx-toolbar--plain' },
      h('p', { class: 'fx-rows__title' }, kind === 'job' ? 'Possible invoices' : 'Possible jobs'),
      h('div', { class: 'fx-toolbar__end' }, find.element)),
    results);
  main.append(card);


  async function act(run, done) {
    for (const b of card.querySelectorAll('button')) b.disabled = true;
    try {
      await run();
      toast(done, 'success');
      next();
    } catch (error) {
      const reasons = error.details?.reasons;
      toast(reasons?.length ? `Not done: ${reasons.join('; ')}.` : error.message, 'danger');
      for (const b of card.querySelectorAll('button')) b.disabled = false;
    }
  }
  const markOf = (mark) => (mark === 'same' ? h('span', { class: 'fx-rec__mark', 'data-mark': 'same', 'aria-label': 'Same' }, '✓')
    : mark === 'differs' ? h('span', { class: 'fx-rec__mark', 'data-mark': 'differs', 'aria-label': 'Different' }, '≠') : null);
  const valueOf = (fact) => (Array.isArray(fact.value)
    ? h('span', { class: 'fx-rec__lines' }, fact.value.length ? fact.value.map((v) => h('span', {}, v)) : '—')
    : h('span', {}, fact.value));
  const inFlow = (href, label) => h('a', { class: 'fx-task__link', href, onclick: (event) => ui.go(event) }, label);

  // Wide: one table, the record and each candidate a column. Narrow: cards.
  // A candidate's `action` and `link` make a new node for each of the two.
  function compareView({ ours, oursTitle, oursSub, candidates }) {
    const table = h('div', { class: 'fx-rec__table', role: 'table', style: `--cols: ${candidates.length}` },
      h('div', { class: 'fx-rec__row', role: 'row' },
        h('span', { role: 'columnheader' }),
        h('span', { role: 'columnheader', class: 'fx-rec__job' }, h('span', { class: 'fx-strong' }, oursTitle), h('span', { class: 'fx-dim' }, oursSub)),
        candidates.map((c) => h('span', { role: 'columnheader' },
          h('span', { class: 'fx-strong' }, c.title), c.best ? h('span', { class: 'fx-rec__best' }, 'Best match') : h('span', { class: 'fx-dim' }, c.sub)))),
      ours.map((fact, row) => h('div', { class: 'fx-rec__row', role: 'row' },
        h('span', { role: 'rowheader', class: 'fx-dim' }, fact.label),
        h('span', { role: 'cell', class: 'fx-rec__job' }, valueOf(fact)),
        candidates.map((c) => h('span', { role: 'cell', 'data-mark': c.facts[row].mark ?? '' }, markOf(c.facts[row].mark), valueOf(c.facts[row]))))),
      h('div', { class: 'fx-rec__row', role: 'row' },
        h('span', { role: 'cell' }), h('span', { role: 'cell', class: 'fx-rec__job' }),
        candidates.map((c) => h('span', { role: 'cell', class: 'fx-rec__acts' }, c.action?.(), c.link?.()))));
    const cards = h('div', { class: 'fx-rec__cards' },
      h('div', { class: 'fx-rec__card fx-rec__job' },
        h('span', { class: 'fx-rec__label' }, `${oursTitle} · ${oursSub}`),
        ours.filter((f) => f.label !== 'Client' && f.value !== '—').map((f) => h('span', {}, Array.isArray(f.value) ? f.value.join(', ') : f.value))),
      candidates.map((c) => h('div', { class: `fx-rec__card${c.best ? ' fx-rec__card--best' : ''}` },
        h('span', { class: 'fx-rec__card-top' }, h('span', { class: 'fx-strong' }, c.title), c.best ? h('span', { class: 'fx-rec__best' }, 'Best match') : null),
        h('span', { class: 'fx-rec__checks' }, c.facts.filter((f) => f.mark).map((f) => h('span', { 'data-mark': f.mark }, markOf(f.mark), ` ${f.label}`))),
        h('span', { class: 'fx-dim' }, c.summary),
        c.action?.(), c.link?.())));
    return [table, cards];
  }

  async function load(q = '') {
    let body;
    try {
      body = await flow(`/api/invoicing/${kind === 'job' ? 'jobs' : 'invoices'}/${id}/reconcile${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
    } catch (error) {
      results.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
      return;
    }
    if (kind === 'job') renderJob(body, q);
    else renderInvoice(body, q);
  }

  const skip = () => (order.length > 1 ? h('button', { class: 'fx-btn', type: 'button', onclick: next }, icon('skip-forward'), 'Skip') : null);

  function renderJob({ job, invoices }, q) {
    const system = job.sourceName ?? job.sourceSystem;
    sub.replaceChildren([job.clientName ?? 'No client', job.practitioner, fullDate(job.jobDate), money(job.totalCents)].filter(Boolean).join(' · '));
    const candidates = invoices.map((invoice) => {
      const facts = invoiceCandidateFacts(invoice);
      return {
        title: invoice.number ?? 'Draft', sub: statusWords(invoice.status), best: invoice.best, facts,
        summary: `${facts[2].value} · ${money(invoice.totalCents)} · ${statusWords(invoice.status)}`,
        action: canAct && job.open ? () => h('button', {
          class: `fx-btn${invoice.best ? ' fx-btn--primary' : ''}`, type: 'button',
          onclick: () => act(() => flow(`/api/invoicing/jobs/${job.id}/link`, { method: 'POST', body: JSON.stringify({ invoiceId: invoice.id }) }),
            `Linked to ${invoice.number ?? 'the draft'}.`),
        }, icon('link-2'), 'Link this invoice') : null,
        link: () => inFlow(`/invoices/${invoice.id}`, 'Open invoice'),
      };
    });
    results.replaceChildren(...[
      job.open ? null : h('p', { class: 'fx-notice' }, 'This job has an invoice already.'),
      candidates.length ? compareView({ ours: jobFacts(job), oursTitle: 'This job', oursSub: system, candidates })
        : h('p', { class: 'fx-empty' }, q.trim() ? 'No Flow invoice matches the search.' : 'Flow found no invoice that may be for this job. Find one, or make it.'),
    ].flat().filter(Boolean));
    actions.replaceChildren(...[
      skip(),
      canAct && job.open ? h('button', {
        class: `fx-btn${candidates.some((c) => c.best) ? '' : ' fx-btn--primary'}`, type: 'button',
        onclick: () => act(async () => {
          if (job.unclear) await flow(`/api/invoicing/jobs/${job.id}/no-invoice`, { method: 'POST', body: '{}' });
          await flow(`/api/invoicing/jobs/${job.id}/draft`, { method: 'POST', body: '{}' });
        }, 'Draft invoice made.'),
      }, icon('file-plus'), 'Make invoice') : null,
    ].filter(Boolean));
  }

  function renderInvoice({ invoice, jobs }, q) {
    sub.replaceChildren([invoice.number ?? 'Draft', invoice.clientName, fullDate(invoice.date), money(invoice.totalCents)].filter(Boolean).join(' · '));
    const candidates = jobs.map((job) => {
      const facts = jobCandidateFacts(job);
      return {
        title: job.caseRef ?? shortDate(job.jobDate), sub: job.practitioner ?? '', best: job.best, facts,
        summary: `${facts[2].value} · ${money(job.totalCents)}`,
        action: canAct && invoice.open ? () => h('button', {
          class: `fx-btn${job.best ? ' fx-btn--primary' : ''}`, type: 'button',
          onclick: () => act(() => flow(`/api/invoicing/jobs/${job.id}/link`, { method: 'POST', body: JSON.stringify({ invoiceId: invoice.id }) }),
            'Job linked.'),
        }, icon('link-2'), 'Link this job') : null,
        link: null,
      };
    });
    results.replaceChildren(...[
      invoice.open ? null : h('p', { class: 'fx-notice' }, 'This invoice has a job already.'),
      candidates.length ? compareView({ ours: invoiceFacts(invoice), oursTitle: 'This invoice', oursSub: 'Flow', candidates })
        : h('p', { class: 'fx-empty' }, q.trim() ? 'No job matches the search.' : 'Flow found no job that may be for this invoice.'),
    ].flat().filter(Boolean));
    actions.replaceChildren(...[skip(), h('a', { class: 'fx-btn', href: `/invoices/${invoice.id}`, onclick: (event) => ui.go(event) }, icon('file-text'), 'Open invoice')].filter(Boolean));
  }

  await load();
}
