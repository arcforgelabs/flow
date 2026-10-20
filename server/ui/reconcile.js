// Reconcile: Flow's jobs with no Flow invoice, and Flow invoices with no job.
// The same two views as Price list › Reconcile and Xero › Import › Review:
//   card  one job (or invoice) beside its possible other side, each fact
//         marked same (✓) or different (≠), and a search for any other. The
//         invoice pager steps through them: "← Back" to the list, "n of N",
//         previous and next. A person links one, or for a job makes its
//         invoice; then the next one opens.
//   list  every gap in a table. Ticked jobs with no possible invoice get
//         their drafts from the bulk bar; a row opens its card.
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

export async function renderReconcile(main, ui, id = null) {
  const { h, flow, toast, pageHeader } = ui;
  const canAct = ['owner', 'admin'].includes(ui.me?.person?.role);
  const icon = (name, label) => lucide(h, name, label);
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab') === 'invoices' ? 'invoices' : 'jobs';
  const view = params.get('view') === 'list' && !id ? 'list' : 'card';
  const pathOf = ({ itemId = null, inTab = tab, inView = 'card' } = {}) => {
    const query = new URLSearchParams();
    if (inTab === 'invoices') query.set('tab', 'invoices');
    if (inView === 'list') query.set('view', 'list');
    return `/reconcile${itemId ? `/${itemId}` : ''}${query.size ? `?${query}` : ''}`;
  };
  const open = (to, event) => {
    if (event) event.preventDefault();
    ui.go(pathOf(to));
  };

  const toggle = (name, label, glyph) => h('button', {
    class: 'fx-xi__view', type: 'button', role: 'tab', 'aria-selected': String(view === name), 'aria-label': label, title: label,
    onclick: () => open({ inView: name }),
  }, icon(glyph));
  const subtitle = h('span', {}, 'Flow jobs with no invoice, and Flow invoices with no job.');
  const tabs = h('div', { class: 'fx-tabs', role: 'tablist' });
  const host = h('div', { class: 'fx-rec' }, h('p', { class: 'fx-dim' }, 'Loading…'));
  const bulk = bulkBar(ui, { label: 'Ticked jobs' });
  main.append(
    pageHeader('Reconcile', {
      subtitle,
      actions: [h('div', { class: 'fx-xi__views', role: 'tablist', 'aria-label': 'View' }, toggle('card', 'One at a time', 'square'), toggle('list', 'List, tick many', 'list-checks'))],
    }),
    h('div', { class: 'fx-toolbar fx-rec__bar' }, tabs),
    host, bulk.element);

  let lists;
  try {
    lists = await flow('/api/invoicing/reconcile');
  } catch (error) {
    host.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
    return;
  }
  tabs.replaceChildren(...[['jobs', 'Job, no invoice', lists.jobs.length], ['invoices', 'Invoice, no job', lists.invoices.length]].map(([name, label, count]) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(name === tab),
    onclick: () => { if (name !== tab) open({ inTab: name, inView: view }); },
  }, label, h('span', { class: 'fx-tabs__count' }, String(count)))));

  const queue = tab === 'invoices' ? lists.invoices : lists.jobs;
  if (!queue.length) {
    host.replaceChildren(h('div', { class: 'fx-xi__done' }, icon('check-check'),
      h('p', {}, tab === 'jobs' ? 'Every ready job has an invoice.' : 'Every invoice has a job.')));
    return;
  }
  if (view === 'list') drawList();
  else await drawCard();

  // Every gap in one table. A row opens its card.
  function drawList() {
    const ticked = new Set();
    const boxes = new Map();
    const jobs = tab === 'jobs';
    const drawBar = () => {
      const picked = queue.filter((item) => ticked.has(item.id));
      const plain = picked.filter((item) => !item.possible);
      bulk.draw({
        count: canAct && jobs ? picked.length : 0,
        onClear: () => { ticked.clear(); for (const b of boxes.values()) b.checked = false; all.checked = false; drawBar(); },
        groups: [[
          { icon: 'file-plus', label: 'Make invoices', title: 'Make a draft invoice for each ticked job with no possible invoice', primary: true, run: async () => {
            if (!plain.length) { toast('Each ticked job has a possible invoice. Open it, and check it one at a time.', 'warn'); return; }
            let made = 0;
            for (const item of plain) {
              try {
                if (item.unclear) await flow(`/api/invoicing/jobs/${item.id}/no-invoice`, { method: 'POST', body: '{}' });
                await flow(`/api/invoicing/jobs/${item.id}/draft`, { method: 'POST', body: '{}' });
                made += 1;
              } catch (error) {
                toast(error.message, 'danger');
              }
            }
            const kept = picked.length - plain.length;
            toast(`${made} draft${made === 1 ? '' : 's'} made.${kept ? ` ${kept} with a possible invoice stay here.` : ''}`, made ? 'success' : 'warn');
            ui.go(pathOf({ inView: 'list' }));
          } },
        ]],
      });
    };
    const all = h('input', { type: 'checkbox', class: 'fx-tick', 'aria-label': 'Tick all', onchange: () => {
      for (const item of queue) { if (all.checked) ticked.add(item.id); else ticked.delete(item.id); }
      for (const b of boxes.values()) b.checked = all.checked;
      drawBar();
    } });
    const ticks = canAct && jobs;
    const possible = (item) => (item.possible
      ? h('span', { class: 'fx-rec__possible', 'data-state': 'some' }, icon('link-2', 'Possible match'), String(item.possible))
      : h('span', { class: 'fx-rec__possible' }, icon('circle-dashed', 'No possible match')));
    host.replaceChildren(h('div', { class: 'fx-xi__scroll' }, h('table', { class: 'fx-table fx-table--rows fx-rec-list' },
      h('thead', {}, h('tr', {},
        ticks ? h('th', { class: 'fx-tick-cell' }, all) : null,
        jobs ? null : h('th', {}, 'Invoice'),
        h('th', {}, 'Client'),
        h('th', {}, jobs ? 'Practitioner' : 'Status'),
        h('th', {}, 'Date'),
        h('th', { class: 'fx-num' }, 'Total'),
        h('th', { class: 'fx-rec-list__mid' }, jobs ? 'Invoices' : 'Jobs'))),
      h('tbody', {}, queue.map((item) => {
        const box = h('input', { type: 'checkbox', class: 'fx-tick', 'aria-label': `Tick ${item.clientName ?? 'job'}`, onclick: (event) => event.stopPropagation(), onchange: () => {
          if (box.checked) ticked.add(item.id); else ticked.delete(item.id);
          drawBar();
        } });
        boxes.set(item.id, box);
        return h('tr', { onclick: () => open({ itemId: item.id }) },
          ticks ? h('td', { class: 'fx-tick-cell', onclick: (event) => event.stopPropagation() }, box) : null,
          jobs ? null : h('td', { class: 'fx-num fx-strong' }, item.number ?? 'Draft'),
          h('td', { class: jobs ? 'fx-strong' : '' }, item.clientName ?? h('span', { class: 'fx-dim' }, 'No client')),
          h('td', { class: 'fx-dim' }, jobs ? item.practitioner ?? '—' : statusWords(item.status)),
          h('td', { class: 'fx-dim' }, shortDate(jobs ? item.jobDate : item.issueDate)),
          h('td', { class: 'fx-num' }, money(item.totalCents)),
          h('td', { class: 'fx-rec-list__mid' }, possible(item)));
      })))));
    drawBar();
  }

  // One gap at a time, beside its possible other side.
  async function drawCard() {
    const at = Math.max(0, id ? queue.findIndex((item) => item.id === id) : 0);
    const current = id && queue[at]?.id !== id ? { id } : queue[at];
    const itemId = current.id;
    const inQueue = queue[at]?.id === itemId;
    const next = () => {
      const rest = queue.filter((item) => item.id !== itemId);
      open({ itemId: rest[Math.min(at, rest.length - 1)]?.id ?? null, inView: rest.length ? 'card' : 'list' });
    };

    const step = (to, label, path) => {
      const button = h('button', {
        class: 'fx-pager__step', type: 'button', disabled: !to, 'aria-label': label, title: label,
        onclick: () => open({ itemId: to }),
      });
      button.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      return button;
    };
    const pager = h('nav', { class: 'fx-pager', 'aria-label': tab === 'jobs' ? 'Jobs with no invoice' : 'Invoices with no job' },
      h('button', { class: 'fx-pager__back', type: 'button', onclick: () => open({ inView: 'list' }) }, '← Back'),
      h('span', { class: 'fx-pager__count' }, inQueue ? `${at + 1} of ${queue.length}` : ''),
      h('span', { class: 'fx-pager__steps' },
        step(inQueue ? queue[at - 1]?.id : null, 'Previous', CHEVRONS.prev),
        step(inQueue ? queue[at + 1]?.id : queue[0]?.id, 'Next', CHEVRONS.next)));

    const kind = tab === 'jobs' ? 'jobs' : 'invoices';
    const search = h('input', {
      class: 'fx-input fx-xi__search', type: 'search', autocomplete: 'off',
      placeholder: tab === 'jobs' ? 'Find another Flow invoice: number, client, Reference, amount' : 'Find another job: client, practitioner, case',
      'aria-label': tab === 'jobs' ? 'Find another Flow invoice' : 'Find another job',
    });
    const head = h('div', { class: 'fx-rec__head' });
    const results = h('div', { class: 'fx-rec__results' }, h('p', { class: 'fx-dim' }, 'Loading…'));
    const acts = h('div', { class: 'fx-xi__acts' });
    const card = h('section', { class: 'fx-rec__card-view', 'aria-label': 'Compare' },
      pager, head, results, h('div', { class: 'fx-xi__bulk' }, icon('search'), search), acts);
    host.replaceChildren(card);

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
        body = await flow(`/api/invoicing/${kind}/${itemId}/reconcile${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
      } catch (error) {
        results.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
        return;
      }
      if (tab === 'jobs') renderJob(body, q);
      else renderInvoice(body, q);
    }

    function renderHead(title, facts, link) {
      head.replaceChildren(
        h('div', {}, h('h2', { class: 'fx-rec__title' }, title), h('span', { class: 'fx-dim' }, facts.filter(Boolean).join(' · '))),
        link ?? h('span', {}));
    }

    const skip = () => (queue.length > 1 ? h('button', { class: 'fx-btn', type: 'button', onclick: next }, icon('skip-forward'), 'Skip') : null);

    function renderJob({ job, invoices }, q) {
      const system = job.sourceName ?? job.sourceSystem;
      renderHead(job.clientName ?? 'No client', [job.practitioner, fullDate(job.jobDate), money(job.totalCents)], null);
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
      acts.replaceChildren(...[
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
      renderHead(invoice.number ?? 'Draft invoice', [invoice.clientName, fullDate(invoice.date), money(invoice.totalCents)],
        inFlow(`/invoices/${invoice.id}`, 'Open invoice'));
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
      acts.replaceChildren(...[skip()].filter(Boolean));
    }

    await load();
  }
}
