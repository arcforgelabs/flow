// Jobs (/jobs): every billable job from the lab system, as a board with one
// column per billing stage, or as a list. A job's stage follows from its
// evidence (server/core/ledger.js ledgerView), so cards are not dragged: a
// job moves when its evidence changes, or when someone drafts its invoice
// here. Data comes from /api/invoicing/jobs (server/api/invoicing.js).

import { formatCents } from '/assets/ui/invoicing.js';

// Board columns, left to right. Held jobs sit with the jobs that need review.
const STAGES = [
  { id: 'work', label: 'In work', views: ['in_work'], tone: 'mute' },
  { id: 'review', label: 'Needs review', views: ['review_required', 'held'], tone: 'warn' },
  { id: 'pending', label: 'Checking', views: ['pending'], tone: 'mute' },
  { id: 'ready', label: 'Ready to bill', views: ['ready'], tone: 'info' },
  { id: 'drafted', label: 'Drafted', views: ['drafted'], tone: 'info' },
  { id: 'invoiced', label: 'Invoiced', views: ['invoiced'], tone: 'success' },
  { id: 'paid', label: 'Paid', views: ['paid'], tone: 'success' },
];
const STAGE_OF = Object.fromEntries(STAGES.flatMap((stage) => stage.views.map((view) => [view, stage])));
const LAYOUT_KEY = 'flow_jobs_layout';

const showDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '—');

function readLayout() {
  try { return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'board'; } catch { return 'board'; }
}

function saveLayout(layout) {
  try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* the choice is only a convenience */ }
}

export async function renderJobs(main, ui) {
  const { h, flow, pageHeader, notice } = ui;
  // Search (search.js) opens a job with no invoice as /jobs?q=<case>.
  const asked = new URLSearchParams(location.search).get('q') ?? '';
  const state = { layout: readLayout(), q: asked.trim().toLowerCase(), jobs: [], canDraft: false };
  const toggle = h('div', { class: 'fx-seg', role: 'radiogroup', 'aria-label': 'Layout' });
  const search = h('input', { class: 'fx-input fx-search', type: 'search', placeholder: 'Find a case, client or practitioner', 'aria-label': 'Find a job', value: asked });
  const host = h('div', { class: 'fx-jobs' }, h('div', { class: 'fx-skeleton' }));
  main.classList.add('fx-main--wide');
  main.append(
    pageHeader('Jobs', { subtitle: 'Every billable job from the lab system, by billing stage.' }),
    h('div', { class: 'fx-toolbar fx-toolbar--plain' }, search, toggle),
    host);

  const drawToggle = () => toggle.replaceChildren(...[['board', 'Board'], ['list', 'List']].map(([id, label]) => h('button', {
    type: 'button', role: 'radio', class: 'fx-seg__item', 'aria-checked': String(state.layout === id),
    onclick: () => { state.layout = id; saveLayout(id); drawToggle(); draw(); },
  }, label)));
  drawToggle();
  search.addEventListener('input', () => { state.q = search.value.trim().toLowerCase(); draw(); });

  const visible = () => (state.q
    ? state.jobs.filter((job) => [job.caseRef, job.sourceJobRef, job.contactName, job.practitioner, job.invoiceNumber]
      .some((value) => value && String(value).toLowerCase().includes(state.q)))
    : state.jobs);

  function draw() {
    if (!state.jobs.length) {
      host.replaceChildren(h('div', { class: 'fx-panel fx-empty' },
        h('p', {}, 'No jobs yet. Jobs appear here once the lab system is connected under Integrations.'),
        h('a', { class: 'fx-btn', href: '/invoices/new', onclick: ui.go }, 'Make an invoice by hand')));
      return;
    }
    host.replaceChildren(state.layout === 'list' ? list(visible()) : board(visible()));
  }

  async function load() {
    try {
      const [{ jobs }, context] = await Promise.all([flow('/api/invoicing/jobs'), flow('/api/invoicing/context')]);
      state.jobs = jobs;
      state.canDraft = context.canIssue;
    } catch (error) {
      host.replaceChildren(notice(error.message, 'danger'));
      return;
    }
    draw();
  }

  function action(job) {
    if (job.invoiceId) {
      const href = `/invoices/${job.invoiceId}`;
      return h('a', { class: 'fx-btn fx-btn--ghost fx-btn--sm', href, onclick: ui.go }, job.invoiceNumber ?? 'Open draft');
    }
    // Flow's own stage: a person marks a job ready to invoice, or an
    // automation does (Settings, Automations).
    if (job.view === 'in_work') {
      return h('button', {
        class: 'fx-btn fx-btn--sm', type: 'button',
        onclick: async (event) => {
          event.stopPropagation();
          event.currentTarget.disabled = true;
          try {
            await flow(`/api/invoicing/jobs/${job.id}/ready`, { method: 'POST', body: JSON.stringify({ ready: true }) });
            ui.toast('Marked ready to invoice.', 'success');
          } catch (error) {
            ui.toast(error.message, 'danger');
          }
          await load();
        },
      }, 'Mark ready');
    }
    if (job.view !== 'ready' || !state.canDraft) return null;
    return h('button', {
      class: 'fx-btn fx-btn--primary fx-btn--sm', type: 'button',
      onclick: async (event) => {
        event.stopPropagation();
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const { invoice } = await flow(`/api/invoicing/jobs/${job.id}/draft`, { method: 'POST', body: '{}' });
          ui.toast('Draft invoice made.', 'success');
          ui.go(`/invoices/${invoice.id}`);
        } catch (error) {
          const reasons = error.details?.reasons;
          ui.toast(reasons?.length ? `Not drafted: ${reasons.join('; ')}.` : error.message, 'danger');
          button.disabled = false;
          await load();
        }
      },
    }, 'Draft invoice');
  }

  function card(job) {
    const stage = STAGE_OF[job.view];
    const reasons = ['review', 'pending'].includes(stage?.id) ? job.reasons?.join('; ') : '';
    const why = reasons ? reasons[0].toUpperCase() + reasons.slice(1) + '.' : null;
    return h('article', { class: `fx-job${stage?.id === 'review' ? ' fx-job--flag' : ''}` },
      h('div', { class: 'fx-job__top' },
        h('span', { class: 'fx-strong' }, job.caseRef ?? job.sourceJobRef),
        h('span', { class: 'fx-job__amount' }, formatCents(job.totalCents))),
      h('div', { class: 'fx-job__client' }, job.contactName ?? 'No client'),
      h('div', { class: 'fx-job__meta' },
        job.practitioner ? h('span', {}, job.practitioner) : null,
        h('span', {}, `Shipped ${showDate(job.shippedOn)}`)),
      why ? h('p', { class: 'fx-job__why' }, why) : null,
      action(job));
  }

  function board(jobs) {
    return h('div', { class: 'fx-board' }, STAGES.map((stage) => {
      const inStage = jobs.filter((job) => stage.views.includes(job.view));
      const total = inStage.reduce((sum, job) => sum + (job.totalCents ?? 0), 0);
      return h('section', { class: 'fx-board__col', 'aria-label': stage.label },
        h('header', { class: 'fx-board__head' },
          h('span', { class: 'fx-board__dot', 'data-tone': stage.tone }),
          h('span', { class: 'fx-strong' }, stage.label),
          h('span', { class: 'fx-board__count' }, String(inStage.length)),
          h('span', { class: 'fx-board__sum' }, inStage.length ? formatCents(total) : '')),
        h('div', { class: 'fx-board__cards' }, inStage.length ? inStage.map(card) : h('p', { class: 'fx-board__none' }, 'None')));
    }));
  }

  function list(jobs) {
    if (!jobs.length) return h('div', { class: 'fx-panel' }, h('p', { class: 'fx-empty' }, 'No job matches that search.'));
    return h('div', { class: 'fx-panel' }, h('table', { class: 'fx-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Case'), h('th', {}, 'Client'), h('th', {}, 'Practitioner'), h('th', {}, 'Shipped'),
        h('th', {}, 'Stage'), h('th', { class: 'fx-num' }, 'Total'), h('th', { class: 'fx-table__actions' }, h('span', { class: 'fx-sr' }, 'Action')))),
      h('tbody', {}, jobs.map((job) => {
        const stage = STAGE_OF[job.view];
        return h('tr', {},
          h('td', { class: 'fx-strong' }, job.caseRef ?? job.sourceJobRef),
          h('td', {}, job.contactName ?? '—'),
          h('td', { class: 'fx-dim' }, job.practitioner ?? '—'),
          h('td', { class: 'fx-dim' }, showDate(job.shippedOn)),
          h('td', {}, h('span', { class: 'fx-status', 'data-tone': stage?.tone ?? 'mute', title: job.reasons?.join('; ') ?? '' }, stage?.label ?? job.view)),
          h('td', { class: 'fx-num fx-strong' }, formatCents(job.totalCents)),
          h('td', { class: 'fx-table__actions' }, action(job)));
      }))));
  }

  await load();
}
