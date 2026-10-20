// Reconcile: Flow's jobs with no Flow invoice, and Flow invoices with no job.
// For one of them, the possible other side beside it, each fact marked same
// (✓) or different (≠), and a search for any other. A person links one, or
// for a job makes its invoice. Flow's own records only: matching a Flow
// invoice to an accounting system's is that integration's work. API:
// /api/invoicing/reconcile, /jobs/:id/reconcile, /invoices/:id/reconcile,
// /jobs/:id/link, /jobs/:id/no-invoice (docs/JOB_INVOICE_LINKS.md).
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

export async function renderReconcile(main, ui, id = null) {
  const { h, flow, pageHeader } = ui;
  const canAct = ['owner', 'admin'].includes(ui.me?.person?.role);
  const tab = new URLSearchParams(location.search).get('tab') === 'invoices' ? 'invoices' : 'jobs';
  const host = h('div', { class: `fx-rec${id ? ' fx-rec--open' : ''}` }, h('p', { class: 'fx-dim' }, 'Loading…'));
  main.append(pageHeader('Reconcile', { subtitle: 'Flow jobs with no invoice, and Flow invoices with no job.' }), host);

  let lists;
  try {
    lists = await flow('/api/invoicing/reconcile');
  } catch (error) {
    host.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
    return;
  }
  const queue = tab === 'invoices' ? lists.invoices : lists.jobs;
  const pathOf = (itemId, inTab = tab) => `/reconcile${itemId ? `/${itemId}` : ''}${inTab === 'invoices' ? '?tab=invoices' : ''}`;
  const open = (itemId, event, inTab = tab) => {
    if (event) event.preventDefault();
    ui.go(pathOf(itemId, inTab));
  };
  const index = id ? queue.findIndex((j) => j.id === id) : -1;
  const next = () => {
    const rest = queue.filter((j) => j.id !== id);
    open(rest[Math.max(0, index)]?.id ?? rest[0]?.id ?? null);
  };

  const tabs = h('div', { class: 'fx-rec__tabs', role: 'tablist' },
    [['jobs', `Job, no invoice · ${lists.jobs.length}`], ['invoices', `Invoice, no job · ${lists.invoices.length}`]].map(([name, label]) => h('a', {
      class: 'fx-rec__tab', role: 'tab', href: pathOf(null, name), 'aria-selected': String(name === tab), onclick: (event) => open(null, event, name),
    }, label)));
  const items = queue.map((item) => h('a', {
    class: 'fx-rec__item', href: pathOf(item.id), 'aria-current': item.id === id ? 'true' : 'false', onclick: (event) => open(item.id, event),
  },
  h('span', { class: 'fx-rec__item-top' }, h('span', { class: 'fx-strong' }, tab === 'jobs' ? item.clientName ?? 'No client' : item.number ?? 'Draft'), h('span', { class: 'fx-num' }, money(item.totalCents))),
  h('span', { class: 'fx-dim' }, (tab === 'jobs'
    ? [item.practitioner, shortDate(item.jobDate)]
    : [item.clientName, item.issueDate ? shortDate(item.issueDate) : null, statusWords(item.status)]
  ).concat(item.possible ? `${item.possible} possible` : 'none found').filter(Boolean).join(' · '))));
  const list = h('nav', { class: 'fx-rec__queue', 'aria-label': tab === 'jobs' ? 'Jobs with no invoice' : 'Invoices with no job' },
    tabs, items.length ? items : h('p', { class: 'fx-empty' }, tab === 'jobs' ? 'Every ready job has an invoice.' : 'Every invoice has a job.'));

  const detail = h('section', { class: 'fx-rec__detail', 'aria-label': 'Compare' });
  host.replaceChildren(list, detail);
  if (!id) {
    detail.append(h('p', { class: 'fx-empty' }, queue.length ? 'Choose one.' : 'Nothing to reconcile here.'));
    return;
  }

  const kind = tab === 'jobs' ? 'jobs' : 'invoices';
  const search = h('input', {
    class: 'fx-input fx-rec__search', type: 'search', autocomplete: 'off',
    placeholder: tab === 'jobs' ? 'Search Flow invoices: number, client, Reference, amount' : 'Search jobs: client, practitioner, case',
    'aria-label': tab === 'jobs' ? 'Search Flow invoices' : 'Search jobs',
  });
  const head = h('div', { class: 'fx-rec__head' });
  const results = h('div', { class: 'fx-rec__results' }, h('p', { class: 'fx-dim' }, 'Loading…'));
  const foot = h('div', { class: 'fx-rec__foot' });
  detail.replaceChildren(head, search, results, foot);

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(search.value), 300);
  });

  async function act(run, done) {
    for (const b of detail.querySelectorAll('button')) b.disabled = true;
    try {
      await run();
      ui.toast(done, 'success');
      next();
    } catch (error) {
      const reasons = error.details?.reasons;
      ui.toast(reasons?.length ? `Not done: ${reasons.join('; ')}.` : error.message, 'danger');
      for (const b of detail.querySelectorAll('button')) b.disabled = false;
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
      body = await flow(`/api/invoicing/${kind}/${id}/reconcile${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
    } catch (error) {
      results.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
      return;
    }
    const position = index >= 0 ? `${index + 1} of ${queue.length}` : '';
    if (tab === 'jobs') renderJob(body, position, q);
    else renderInvoice(body, position, q);
  }

  function renderHead(position, title, link) {
    head.replaceChildren(...[
      h('div', {},
        h('a', { class: 'fx-rec__back', href: pathOf(null), onclick: (event) => open(null, event) }, '← All'),
        h('span', { class: 'fx-dim' }, position),
        h('h2', { class: 'fx-rec__title' }, title)),
      link,
    ].filter(Boolean));
  }

  function renderJob({ job, invoices }, position, q) {
    const system = job.sourceName ?? job.sourceSystem;
    renderHead(position, job.clientName ?? 'No client', null);
    const candidates = invoices.map((invoice) => {
      const facts = invoiceCandidateFacts(invoice);
      return {
        title: invoice.number ?? 'Draft', sub: statusWords(invoice.status), best: invoice.best, facts,
        summary: `${facts[2].value} · ${money(invoice.totalCents)} · ${statusWords(invoice.status)}`,
        action: canAct && job.open ? () => h('button', {
          class: `fx-btn${invoice.best ? ' fx-btn--primary' : ''}`, type: 'button',
          onclick: () => act(() => flow(`/api/invoicing/jobs/${job.id}/link`, { method: 'POST', body: JSON.stringify({ invoiceId: invoice.id }) }),
            `Linked to ${invoice.number ?? 'the draft'}.`),
        }, 'Link this invoice') : null,
        link: () => inFlow(`/invoices/${invoice.id}`, 'Open invoice'),
      };
    });
    results.replaceChildren(...[
      job.open ? null : h('p', { class: 'fx-notice' }, 'This job has an invoice already.'),
      candidates.length ? compareView({ ours: jobFacts(job), oursTitle: 'This job', oursSub: system, candidates })
        : h('p', { class: 'fx-empty' }, q.trim() ? 'No Flow invoice matches the search.' : 'Flow found no invoice that may be for this job. Search for one, or make it.'),
    ].flat().filter(Boolean));
    foot.replaceChildren(
      h('span', { class: 'fx-dim' }, candidates.length ? 'None of these?' : ''),
      h('div', { class: 'fx-rec__foot-acts' },
        queue.length > 1 ? h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', onclick: next }, 'Skip') : null,
        canAct && job.open ? h('button', {
          class: 'fx-btn', type: 'button',
          onclick: () => act(async () => {
            if (job.unclear) await flow(`/api/invoicing/jobs/${job.id}/no-invoice`, { method: 'POST', body: '{}' });
            await flow(`/api/invoicing/jobs/${job.id}/draft`, { method: 'POST', body: '{}' });
          }, 'Draft invoice made.'),
        }, 'Make invoice') : null));
  }

  function renderInvoice({ invoice, jobs }, position, q) {
    renderHead(position, invoice.number ?? 'Draft invoice', inFlow(`/invoices/${invoice.id}`, 'Open invoice'));
    const candidates = jobs.map((job) => {
      const facts = jobCandidateFacts(job);
      return {
        title: job.caseRef ?? shortDate(job.jobDate), sub: job.practitioner ?? '', best: job.best, facts,
        summary: `${facts[2].value} · ${money(job.totalCents)}`,
        action: canAct && invoice.open ? () => h('button', {
          class: `fx-btn${job.best ? ' fx-btn--primary' : ''}`, type: 'button',
          onclick: () => act(() => flow(`/api/invoicing/jobs/${job.id}/link`, { method: 'POST', body: JSON.stringify({ invoiceId: invoice.id }) }),
            'Job linked.'),
        }, 'Link this job') : null,
        link: null,
      };
    });
    results.replaceChildren(...[
      invoice.open ? null : h('p', { class: 'fx-notice' }, 'This invoice has a job already.'),
      candidates.length ? compareView({ ours: invoiceFacts(invoice), oursTitle: 'This invoice', oursSub: 'Flow', candidates })
        : h('p', { class: 'fx-empty' }, q.trim() ? 'No job matches the search.' : 'Flow found no job that may be for this invoice.'),
    ].flat().filter(Boolean));
    foot.replaceChildren(
      h('span', { class: 'fx-dim' }, ''),
      h('div', { class: 'fx-rec__foot-acts' },
        queue.length > 1 ? h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', onclick: next }, 'Skip') : null));
  }

  await load();
}
