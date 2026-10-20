// Jobs (/jobs): the work system's jobs, as a board with one column per work
// system status (its own statuses, one to one), or as a list. Cards are not
// dragged: a job moves when the work system changes its status. A click on a
// job opens its detail panel: the job, its lines, its invoice, and what to
// fix. Data comes from /api/invoicing/board (server/core/job-board.js); the
// rules are in server/ui/job-board.js.

import { formatCents } from '/assets/ui/invoicing.js';
import {
  FINAL_RANK, fixes, INVOICE_STAGES, invoiceStage, matches, NO_STATUS, orderStatuses, problemSummary, statusRank,
} from '/assets/ui/job-board.js';

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
const CALENDAR_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

export async function renderJobs(main, ui) {
  const { h, flow, pageHeader, notice } = ui;
  // Search (search.js) opens a job with no invoice as /jobs?q=<case>.
  const asked = new URLSearchParams(location.search).get('q') ?? '';
  const state = { layout: readLayout(), q: asked.trim().toLowerCase(), jobs: [], statuses: [], accountingName: null, canDraft: false };
  const toggle = h('div', { class: 'fx-seg', role: 'radiogroup', 'aria-label': 'Layout' });
  const search = h('input', { class: 'fx-input fx-search', type: 'search', placeholder: 'Find a case, client or practitioner', 'aria-label': 'Find a job', value: asked });
  const host = h('div', { class: 'fx-jobs' }, h('div', { class: 'fx-skeleton' }));
  main.classList.add('fx-main--wide');
  main.append(
    pageHeader('Jobs', { subtitle: 'Every job in the lab system, by its status there.' }),
    h('div', { class: 'fx-toolbar fx-toolbar--plain fx-toolbar--end' }, search, toggle),
    host);

  const drawToggle = () => toggle.replaceChildren(...[['board', 'Board'], ['list', 'List']].map(([id, label]) => h('button', {
    type: 'button', role: 'radio', class: 'fx-seg__item', 'aria-checked': String(state.layout === id),
    onclick: () => { state.layout = id; saveLayout(id); drawToggle(); draw(); },
  }, label)));
  drawToggle();
  search.addEventListener('input', () => { state.q = search.value.trim(); draw(); });

  const problemsOf = (job) => fixes(job.obligation, { accountingName: state.accountingName });

  function draw() {
    if (!state.jobs.length) {
      main.classList.remove('fx-main--board');
      host.replaceChildren(h('div', { class: 'fx-panel fx-empty' },
        h('p', {}, 'No jobs yet. Jobs appear here once the lab system is connected under Integrations.'),
        h('a', { class: 'fx-btn', href: '/invoices/new', onclick: ui.go }, 'Make an invoice by hand')));
      return;
    }
    const shown = state.jobs.filter((job) => matches(job, state.q));
    main.classList.toggle('fx-main--board', state.layout === 'board');
    host.replaceChildren(state.layout === 'list' ? list(shown) : board(shown));
  }

  async function load() {
    try {
      const [body, context] = await Promise.all([flow('/api/invoicing/board'), flow('/api/invoicing/context')]);
      state.jobs = body.jobs;
      state.statuses = body.statuses;
      state.accountingName = body.accountingName;
      state.canDraft = context.canIssue;
    } catch (error) {
      host.replaceChildren(notice(error.message, 'danger'));
      return;
    }
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
  // problem. Never the case number. A late job's date shows in red. No
  // "move to the next stage" tick yet: Flow only reads the lab system.
  function jobCard(job) {
    const date = dateOf(job);
    const day = job.dueOn ?? job.orderedOn ?? job.jobDate;
    const late = job.dueOn && job.dueOn < today() && statusRank(job.status) < FINAL_RANK;
    return h('article', {
      class: 'fx-job', tabindex: '0', role: 'button', 'aria-label': `${clientOf(job)}, open the job`,
      onclick: () => openJob(job),
      onkeydown: (event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openJob(job); } },
    },
    h('div', { class: 'fx-job__client' }, clientOf(job)),
    job.practitioner ? h('div', { class: 'fx-job__who' }, svg(PERSON_ICON), h('span', {}, job.practitioner)) : null,
    h('div', { class: 'fx-job__foot' },
      day ? h('span', { class: `fx-job__date${late ? ' fx-job__date--late' : ''}`, title: late ? `${date}, past due` : date }, svg(CALENDAR_ICON), showDate(day)) : null,
      h('span', { class: 'fx-job__space' }),
      problemMark(job),
      h('span', { class: 'fx-job__amount' }, job.totalCents == null ? '—' : formatCents(job.totalCents))));
  }

  // A column's label: the status, in its stage colour, and how many jobs.
  const stagePill = (label, count = null) => h('span', { class: 'fx-stage', 'data-rank': String(statusRank(label)) },
    h('span', { class: 'fx-stage__label' }, label),
    count == null ? null : h('span', { class: 'fx-stage__count' }, String(count)));

  function board(jobs) {
    const columns = orderStatuses(state.statuses, state.jobs);
    return h('div', { class: 'fx-board' }, columns.map((label) => {
      const inColumn = jobs.filter((job) => (job.status ?? NO_STATUS) === label);
      const total = inColumn.reduce((sum, job) => sum + (job.totalCents ?? 0), 0);
      return h('section', { class: 'fx-board__col', 'aria-label': label },
        h('header', { class: 'fx-board__head' },
          stagePill(label, inColumn.length),
          h('span', { class: 'fx-board__sum' }, inColumn.length ? formatCents(total) : '')),
        h('div', { class: 'fx-board__cards' }, inColumn.length ? inColumn.map(jobCard) : h('p', { class: 'fx-board__none' }, 'None')));
    }));
  }

  function list(jobs) {
    if (!jobs.length) return h('div', { class: 'fx-panel' }, h('p', { class: 'fx-empty' }, 'No job matches that search.'));
    return h('div', { class: 'fx-panel' }, h('table', { class: 'fx-table fx-table--jobs' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Client'), h('th', {}, 'Practitioner'), h('th', {}, 'Stage'), h('th', {}, 'Date'),
        h('th', { class: 'fx-num' }, 'Total'))),
      h('tbody', {}, jobs.map((job) => h('tr', {
        class: 'fx-row-link', tabindex: '0',
        onclick: () => openJob(job),
        onkeydown: (event) => { if (event.key === 'Enter') openJob(job); },
      },
      h('td', {}, h('span', { class: 'fx-job__cell' }, h('span', { class: 'fx-strong' }, clientOf(job)), problemMark(job))),
      h('td', { class: 'fx-dim' }, job.practitioner ?? '—'),
      h('td', {}, job.status ?? NO_STATUS),
      h('td', { class: 'fx-dim' }, dateOf(job) ?? '—'),
      h('td', { class: 'fx-num fx-strong' }, job.totalCents == null ? '—' : formatCents(job.totalCents)))))));
  }

  // What a person can do with the job's invoice from here.
  function actions(job, close) {
    const o = job.obligation;
    if (!o) return [];
    if (o.invoiceId) {
      const label = o.invoiceStatus === 'draft' ? 'Open draft invoice' : `Open invoice ${o.invoiceNumber ?? ''}`.trim();
      const open = h('a', { class: 'fx-btn', href: `/invoices/${o.invoiceId}`, onclick: (event) => { close(); ui.go(event); } }, label);
      // Only the job changed and the draft is not sent (ledger.js): one tap
      // puts the job's new lines on Flow's own draft.
      if (!o.canUseNewLines) return [open];
      return [h('button', {
        class: 'fx-btn fx-btn--primary', type: 'button',
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            await flow(`/api/invoicing/jobs/${o.id}/use-new-lines`, { method: 'POST', body: '{}' });
            ui.toast('The draft has the new job lines.', 'success');
          } catch (error) {
            ui.toast(error.message, 'danger');
          }
          close();
          await load();
        },
      }, 'Use new lines'), open];
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
  // or a click outside closes it. `atFix` scrolls to what to fix. Nothing is
  // edited here yet: Flow only reads the lab system.
  function openJob(job, { atFix = false } = {}) {
    const o = job.obligation;
    const stage = invoiceStage(o);
    const found = problemsOf(job);
    const system = SYSTEM_NAME[job.sourceSystem] ?? job.sourceSystem;
    const status = job.status ?? NO_STATUS;
    const late = job.dueOn && job.dueOn < today() && statusRank(job.status) < FINAL_RANK;
    const field = (term, value, attrs = {}) => (value == null || value === '' ? null
      : h('div', {}, h('dt', {}, term), h('dd', attrs, value)));
    const link = (attrs, text) => h('a', { class: 'fx-task__link', ...attrs }, text);
    const element = h('dialog', { class: 'fx-dialog fx-task', 'aria-label': clientOf(job) });
    const close = () => element.close();
    const invoiceText = o?.invoiceId
      ? link({ href: `/invoices/${o.invoiceId}`, onclick: (event) => { close(); ui.go(event); } },
        `${o.invoiceStatus === 'draft' ? 'Draft' : 'Invoice'} ${o.invoiceNumber ?? ''}`.trim() + (stage ? ` · ${INVOICE_STAGES[stage]}` : ''))
      : stage ? INVOICE_STAGES[stage] : o ? 'Not ready to invoice' : 'No invoice yet';
    const fixBox = found.length ? h('section', { class: 'fx-task__fix', 'aria-label': 'Fix' },
      h('h3', {}, 'Fix'),
      found.map((f) => h('div', { class: 'fx-task__fixrow' }, h('span', {}, `${f.text} ${f.todo}`)))) : null;
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
          field('Case number', job.caseRef ?? job.sourceJobRef, { class: 'fx-mono' }),
          field(`${system} status`, job.status),
          field(`${system} client`, job.workClientName && job.workClientName !== job.clientName ? job.workClientName : null),
          field('Department', job.department),
          field('Invoice', invoiceText),
          o?.accountingUrl ? field(state.accountingName ?? 'Accounting', link({ href: o.accountingUrl, target: '_blank', rel: 'noopener' }, `Open in ${state.accountingName ?? 'the accounting system'}`)) : null),
        fixBox,
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
    if (atFix && fixBox) fixBox.scrollIntoView({ block: 'start' });
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
