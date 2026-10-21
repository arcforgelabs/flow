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


const CHEVRONS = { prev: 'M14.5 6l-6 6 6 6', next: 'M9.5 6l6 6-6 6' };
const TICK_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.5 3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FILTER_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M4.5 8h7M6.5 12h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
// The list's filter, kept per viewer: which kinds show, and whether they
// have a possible match. The list a person opened a gap from, for the pager.
const FILTER_KEY = 'flow_reconcile_filter';
const NAV_KEY = 'flow_reconcile_nav';
const DEFAULT_FILTER = { job: true, invoice: true, match: 'any' };
const MATCH_WORDS = { any: null, some: 'Has a possible match', none: 'No possible match' };

function readStored(store, key, fallback) {
  try { return JSON.parse(store.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeStored(store, key, value) {
  try { store.setItem(key, JSON.stringify(value)); } catch { /* the page still works, it forgets */ }
}

// One row for each gap, jobs and invoices together, oldest first.
export function reconcileRows({ jobs = [], invoices = [] }) {
  return [
    ...jobs.map((j) => ({ kind: 'job', id: j.id, client: j.clientName, who: j.practitioner, date: j.jobDate, totalCents: j.totalCents, possible: j.possible, unclear: j.unclear })),
    ...invoices.map((i) => ({ kind: 'invoice', id: i.id, client: i.clientName, who: i.number ?? 'Draft', status: i.status, date: i.issueDate, totalCents: i.totalCents, possible: i.possible })),
  ].sort((a, b) => String(a.date ?? '9999').localeCompare(String(b.date ?? '9999')));
}

export function filterRows(rows, filter, q = '') {
  const words = q.trim().toLowerCase();
  return rows.filter((r) => filter[r.kind] !== false
    && (filter.match === 'some' ? r.possible > 0 : filter.match === 'none' ? !r.possible : true)
    && (!words || [r.client, r.who, money(r.totalCents)].some((v) => String(v ?? '').toLowerCase().includes(words))));
}

export async function renderReconcile(main, ui, id = null) {
  if (id) return renderGap(main, ui, id);
  return renderList(main, ui);
}

const pathOf = (row) => `/reconcile/${row.id}${row.kind === 'invoice' ? '?kind=invoice' : ''}`;
const KIND_ICON = { job: ['briefcase', 'Job with no invoice'], invoice: ['file-text', 'Invoice with no job'] };

async function renderList(main, ui) {
  const { h, flow, toast, pageHeader } = ui;
  const icon = (name, label) => lucide(h, name, label);
  const canAct = ['owner', 'admin'].includes(ui.me?.person?.role);
  const back = readStored(sessionStorage, NAV_KEY, null);
  const state = { filter: { ...DEFAULT_FILTER, ...readStored(localStorage, FILTER_KEY, {}) }, q: back?.q ?? '', ticked: new Set() };
  const search = h('input', { class: 'fx-input fx-search', type: 'search', placeholder: 'Find a client, practitioner or amount', 'aria-label': 'Find a gap', value: state.q });
  const controls = h('div', { class: 'fx-viewbar', role: 'group', 'aria-label': 'Filter' });
  const host = h('div', { class: 'fx-rec' }, h('div', { class: 'fx-skeleton' }));
  const bulk = bulkBar(ui, { label: 'Ticked jobs' });
  main.append(
    pageHeader('Reconcile'),
    h('div', { class: 'fx-toolbar fx-toolbar--plain' }, controls, h('div', { class: 'fx-toolbar__end' }, search)),
    host, bulk.element);

  // The Filter chip and its panel, as on Jobs.
  const panel = h('div', { class: 'fx-pop', id: 'fx-rec-filter', popover: 'auto', role: 'menu' });
  const chip = h('button', { type: 'button', class: 'fx-chip', popovertarget: 'fx-rec-filter', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  const clear = h('button', { type: 'button', class: 'fx-chip__clear', 'aria-label': 'Clear the filter', title: 'Clear the filter', hidden: true }, icon('x'));
  const chipset = h('span', { class: 'fx-chipset' }, chip, clear);
  controls.replaceChildren(chipset, panel);
  const svg = (markup) => { const span = h('span', { class: 'fx-pop__tick' }); span.innerHTML = markup; return span; };
  const option = (text, checked, onclick, role = 'menuitemcheckbox') => h('button', {
    type: 'button', class: 'fx-pop__item', role, 'aria-checked': String(checked), onclick,
  }, checked ? svg(TICK_ICON) : h('span', { class: 'fx-pop__tick' }), h('span', {}, text));
  const setFilter = (patch) => {
    state.filter = { ...state.filter, ...patch };
    if (!state.filter.job && !state.filter.invoice) state.filter = { ...state.filter, job: true, invoice: true };
    writeStored(localStorage, FILTER_KEY, state.filter);
    fillPanel();
    draw();
  };
  const fillPanel = () => panel.replaceChildren(
    h('p', { class: 'fx-pop__head' }, 'Show'),
    option('Jobs with no invoice', state.filter.job, () => setFilter({ job: !state.filter.job })),
    option('Invoices with no job', state.filter.invoice, () => setFilter({ invoice: !state.filter.invoice })),
    h('div', { class: 'fx-pop__sep' }),
    h('p', { class: 'fx-pop__head' }, 'Possible match'),
    ...Object.entries({ any: 'Any', some: 'Has a possible match', none: 'No possible match' })
      .map(([value, text]) => option(text, state.filter.match === value, () => setFilter({ match: value }), 'menuitemradio')));
  panel.addEventListener('toggle', (event) => {
    chip.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState !== 'open') return;
    fillPanel();
    const at = chip.getBoundingClientRect();
    panel.style.top = `${Math.round(at.bottom + 6)}px`;
    panel.style.left = `${Math.round(Math.max(8, Math.min(at.left, innerWidth - panel.offsetWidth - 8)))}px`;
  });
  clear.addEventListener('click', () => setFilter({ ...DEFAULT_FILTER }));
  const drawChip = () => {
    const count = (state.filter.job && state.filter.invoice ? 0 : 1) + (state.filter.match === 'any' ? 0 : 1);
    chip.replaceChildren(svg(FILTER_ICON), h('span', {}, count ? `${count} ${count === 1 ? 'Filter' : 'Filters'}` : 'Filter'));
    chip.classList.toggle('fx-chip--on', count > 0);
    chipset.classList.toggle('fx-chipset--on', count > 0);
    clear.hidden = count === 0;
  };
  search.addEventListener('input', () => { state.q = search.value; draw(); });

  let rows;
  try {
    rows = reconcileRows(await flow('/api/invoicing/reconcile'));
  } catch (error) {
    host.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
    return;
  }

  function draw() {
    drawChip();
    const shown = filterRows(rows, state.filter, state.q);
    const seen = new Set(shown.map((r) => r.id));
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
    host.replaceChildren(h('div', { class: 'fx-panel' }, h('table', { class: 'fx-table fx-table--rows fx-rec-list' },
      h('thead', {}, h('tr', {},
        canAct ? h('th', { class: 'fx-tick-cell' }, all) : null,
        h('th', { class: 'fx-rec-list__kind' }, h('span', { class: 'fx-sr' }, 'Kind')),
        h('th', {}, 'Client'),
        h('th', {}, 'Practitioner or invoice'),
        h('th', {}, 'Date'),
        h('th', { class: 'fx-num' }, 'Total'),
        h('th', { class: 'fx-rec-list__mid' }, 'Possible'))),
      h('tbody', {}, shown.map((r) => {
        const box = r.kind === 'job' ? h('input', { type: 'checkbox', class: 'fx-tick', 'aria-label': `Tick ${r.client ?? 'job'}`, checked: state.ticked.has(r.id), onclick: (event) => event.stopPropagation(), onchange: () => {
          if (box.checked) state.ticked.add(r.id); else state.ticked.delete(r.id);
          drawBar();
        } }) : null;
        if (box) boxes.set(r.id, box);
        const [glyph, label] = KIND_ICON[r.kind];
        return h('tr', { 'data-kind': r.kind, onclick: () => { remember(); ui.go(pathOf(r)); } },
          canAct ? h('td', { class: 'fx-tick-cell', onclick: (event) => event.stopPropagation() }, box) : null,
          h('td', { class: 'fx-rec-list__kind' }, icon(glyph, label)),
          h('td', { class: 'fx-strong' }, r.client ?? h('span', { class: 'fx-dim' }, 'No client')),
          h('td', { class: r.kind === 'invoice' ? 'fx-num' : 'fx-dim' }, r.who ?? '—', r.kind === 'invoice' ? h('span', { class: 'fx-dim' }, ` · ${statusWords(r.status)}`) : null),
          h('td', { class: 'fx-dim' }, shortDate(r.date)),
          h('td', { class: 'fx-num' }, money(r.totalCents)),
          h('td', { class: 'fx-rec-list__mid' }, possible(r)));
      })))));
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
  const step = (to, label, path) => {
    const button = h('button', { class: 'fx-pager__step', type: 'button', disabled: !to, 'aria-label': label, title: label, onclick: () => ui.go(pathOf(to)) });
    button.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return button;
  };
  const pager = h('nav', { class: 'fx-pager', 'aria-label': 'Reconcile' },
    h('button', { class: 'fx-pager__back', type: 'button', onclick: () => ui.go('/reconcile') }, '← Back'),
    h('span', { class: 'fx-pager__count' }, at >= 0 ? `${at + 1} of ${order.length}` : ''),
    h('span', { class: 'fx-pager__steps' }, step(at > 0 ? order[at - 1] : null, 'Previous', CHEVRONS.prev), step(at >= 0 ? order[at + 1] : null, 'Next', CHEVRONS.next)));
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
  const search = h('input', {
    class: 'fx-input fx-xi__search', type: 'search', autocomplete: 'off',
    placeholder: kind === 'job' ? 'Find another Flow invoice: number, client, Reference, amount' : 'Find another job: client, practitioner, case',
    'aria-label': kind === 'job' ? 'Find another Flow invoice' : 'Find another job',
  });
  const card = h('section', { class: 'fx-rec fx-rec__gap', 'aria-label': 'Compare' },
    pager,
    h('header', { class: 'fx-ph' }, h('div', { class: 'fx-ph__text' }, title, sub), actions),
    results,
    h('div', { class: 'fx-xi__bulk' }, icon('search'), search));
  main.append(card);

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(search.value), 300);
  });

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
        : h('p', { class: 'fx-empty' }, q.trim() ? 'No Flow invoice matches the search.' : 'Flow found no invoice that may be for this job. Find one below, or make it.'),
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
