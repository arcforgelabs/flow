// Reconcile: the jobs with no invoice whose match is unclear, and for one
// job its possible invoices beside it, each fact marked same (✓) or
// different (≠). A person links one, or says there is none and Flow makes
// the invoice. API: /api/invoicing/reconcile and /jobs/:id/reconcile, /link,
// /no-invoice (docs/JOB_INVOICE_LINKS.md).
import { formatCents } from '/assets/ui/invoicing.js';

const SYSTEM_NAME = { seazona: 'Seazona' };
const STATUS = { DRAFT: 'Draft', SUBMITTED: 'Waiting for approval', AUTHORISED: 'Approved', PAID: 'Paid', VOIDED: 'Void', DELETED: 'Deleted' };
const fullDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const shortDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '—');
const money = (cents) => (cents == null ? '—' : formatCents(cents));

// The words for how far an invoice's date is from the job's.
export function dayWords(days) {
  if (days == null) return null;
  if (days === 0) return 'same day';
  const n = Math.abs(days);
  return `${n} day${n === 1 ? '' : 's'} ${days > 0 ? 'later' : 'earlier'}`;
}

// The status of an accounting invoice in a person's words.
export function statusWords(invoice) {
  if (invoice.status === 'AUTHORISED' && invoice.amountDueCents > 0) return 'Approved · unpaid';
  return STATUS[invoice.status] ?? invoice.status ?? '—';
}

// Each fact of one candidate: { label, value, mark } where mark is 'same',
// 'differs' or null. The job's own column uses jobFacts.
export function candidateFacts(job, invoice) {
  const c = invoice.checks;
  const others = c.otherJobs.length;
  return [
    { label: 'Client', value: c.client === 'same' ? 'Same' : '—', mark: c.client },
    { label: 'Reference', value: invoice.reference ?? 'Not kept', mark: c.reference },
    { label: 'Date', value: [shortDate(invoice.issuedOn), dayWords(c.date?.days)].filter(Boolean).join(' · '), mark: c.date ? (Math.abs(c.date.days) <= 3 ? 'same' : 'differs') : null },
    { label: 'Lines', value: invoice.lines.filter((l) => l.amountCents).map((l) => `${l.itemCode ?? '—'} ${money(l.amountCents)}`), mark: c.lines },
    { label: 'Total', value: money(invoice.totalCents), mark: c.total },
    {
      label: 'Other jobs',
      value: others ? `Linked to ${others} other job${others === 1 ? '' : 's'}` : c.closerJob ? 'Fits another job better' : 'None linked',
      mark: others || c.closerJob ? 'differs' : 'same',
    },
    { label: 'Status', value: statusWords(invoice), mark: null },
  ];
}

function jobFacts(job) {
  return [
    { label: 'Client', value: job.clientName ?? '—' },
    { label: 'Reference', value: job.reference ?? '—' },
    { label: 'Date', value: fullDate(job.jobDate) },
    { label: 'Lines', value: job.lines.map((l) => `${l.code ?? '—'} ${money(l.amountCents)}`) },
    { label: 'Total', value: money(job.totalCents) },
    { label: 'Other jobs', value: '—' },
    { label: 'Status', value: job.sourceStatus ?? '—' },
  ];
}

export async function renderReconcile(main, ui, id = null) {
  const { h, flow, pageHeader } = ui;
  const canAct = ['owner', 'admin'].includes(ui.me?.person?.role);
  const host = h('div', { class: `fx-rec${id ? ' fx-rec--open' : ''}` }, h('p', { class: 'fx-dim' }, 'Loading…'));
  main.append(pageHeader('Reconcile', { subtitle: 'Jobs with no invoice linked. Compare each job with its possible invoices.' }), host);

  let queue;
  try {
    ({ jobs: queue } = await flow('/api/invoicing/reconcile'));
  } catch (error) {
    host.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
    return;
  }
  if (!queue.length) {
    host.replaceChildren(h('p', { class: 'fx-empty' }, 'Every job is reconciled.'));
    return;
  }
  const open = (jobId, event) => {
    if (event) event.preventDefault();
    ui.go(jobId ? `/reconcile/${jobId}` : '/reconcile');
  };
  const index = id ? queue.findIndex((j) => j.id === id) : -1;
  const next = () => {
    const rest = queue.filter((j) => j.id !== id);
    open(rest[Math.max(0, index)]?.id ?? rest[0]?.id ?? null);
  };

  const list = h('nav', { class: 'fx-rec__queue', 'aria-label': 'Jobs to reconcile' },
    queue.map((job) => h('a', {
      class: 'fx-rec__item', href: `/reconcile/${job.id}`, 'aria-current': job.id === id ? 'true' : 'false', onclick: (event) => open(job.id, event),
    },
    h('span', { class: 'fx-rec__item-top' }, h('span', { class: 'fx-strong' }, job.clientName ?? 'No client'), h('span', { class: 'fx-num' }, money(job.totalCents))),
    h('span', { class: 'fx-dim' }, [job.practitioner, shortDate(job.jobDate), job.possible ? `${job.possible} possible` : 'no match'].filter(Boolean).join(' · ')))));

  const detail = h('section', { class: 'fx-rec__detail', 'aria-label': 'Job and its possible invoices' });
  host.replaceChildren(list, detail);
  if (!id) {
    detail.append(h('p', { class: 'fx-empty' }, 'Choose a job.'));
    return;
  }
  detail.append(h('p', { class: 'fx-dim' }, 'Loading…'));
  let body;
  try {
    body = await flow(`/api/invoicing/jobs/${id}/reconcile`);
  } catch (error) {
    detail.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
    return;
  }
  const { job, invoices, accountingName } = body;
  const system = SYSTEM_NAME[job.sourceSystem] ?? job.sourceSystem;

  async function act(button, run, done) {
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
  const linkButton = (invoice) => (canAct && job.open ? h('button', {
    class: `fx-btn${invoice.best ? ' fx-btn--primary' : ''}`, type: 'button',
    onclick: (event) => act(event.currentTarget,
      () => flow(`/api/invoicing/jobs/${job.id}/link`, { method: 'POST', body: JSON.stringify({ invoiceId: invoice.id }) }),
      `${invoice.number ?? 'The invoice'} is linked.`),
  }, 'Link this invoice') : null);
  const outLink = (invoice) => (invoice.url ? h('a', { class: 'fx-task__link', href: invoice.url, target: '_blank', rel: 'noopener' }, `Open in ${accountingName} ↗`) : null);
  const markOf = (mark) => (mark === 'same' ? h('span', { class: 'fx-rec__mark', 'data-mark': 'same', 'aria-label': 'Same' }, '✓')
    : mark === 'differs' ? h('span', { class: 'fx-rec__mark', 'data-mark': 'differs', 'aria-label': 'Different' }, '≠') : null);
  const valueOf = (fact) => (Array.isArray(fact.value)
    ? h('span', { class: 'fx-rec__lines' }, fact.value.map((v) => h('span', {}, v)))
    : h('span', {}, fact.value));
  const ours = jobFacts(job);
  const theirs = invoices.map((invoice) => candidateFacts(job, invoice));

  // Wide: one table, the job and each invoice a column. Narrow: one card each.
  const table = h('div', { class: 'fx-rec__table', role: 'table', style: `--cols: ${invoices.length}` },
    h('div', { class: 'fx-rec__row', role: 'row' },
      h('span', { role: 'columnheader' }),
      h('span', { role: 'columnheader', class: 'fx-rec__job' }, h('span', { class: 'fx-strong' }, 'This job'), h('span', { class: 'fx-dim' }, system)),
      invoices.map((invoice) => h('span', { role: 'columnheader' },
        h('span', { class: 'fx-strong' }, invoice.number ?? 'No number'),
        invoice.best ? h('span', { class: 'fx-rec__best' }, 'Best match') : null))),
    ours.map((fact, row) => h('div', { class: 'fx-rec__row', role: 'row' },
      h('span', { role: 'rowheader', class: 'fx-dim' }, fact.label),
      h('span', { role: 'cell', class: 'fx-rec__job' }, valueOf(fact)),
      theirs.map((facts) => h('span', { role: 'cell', 'data-mark': facts[row].mark ?? '' }, markOf(facts[row].mark), valueOf(facts[row]))))),
    h('div', { class: 'fx-rec__row', role: 'row' },
      h('span', { role: 'cell' }), h('span', { role: 'cell', class: 'fx-rec__job' }),
      invoices.map((invoice) => h('span', { role: 'cell', class: 'fx-rec__acts' }, linkButton(invoice), outLink(invoice)))));

  const cards = h('div', { class: 'fx-rec__cards' },
    h('div', { class: 'fx-rec__card fx-rec__job' },
      h('span', { class: 'fx-rec__label' }, `This job · ${system}`),
      ours.filter((f) => !['Client', 'Other jobs'].includes(f.label)).map((f) => h('span', {}, Array.isArray(f.value) ? f.value.join(', ') : f.value))),
    invoices.map((invoice, i) => h('div', { class: `fx-rec__card${invoice.best ? ' fx-rec__card--best' : ''}` },
      h('span', { class: 'fx-rec__card-top' }, h('span', { class: 'fx-strong' }, invoice.number ?? 'No number'), invoice.best ? h('span', { class: 'fx-rec__best' }, 'Best match') : null),
      h('span', { class: 'fx-rec__checks' }, theirs[i].filter((f) => f.mark).map((f) => h('span', { 'data-mark': f.mark }, markOf(f.mark), ` ${f.label}`))),
      h('span', { class: 'fx-dim' }, `${theirs[i].find((f) => f.label === 'Date').value} · ${money(invoice.totalCents)} · ${statusWords(invoice)}`),
      linkButton(invoice), outLink(invoice))));

  const position = index >= 0 ? `${index + 1} of ${queue.length}` : '';
  detail.replaceChildren(...[
    h('div', { class: 'fx-rec__head' },
      h('div', {},
        h('a', { class: 'fx-rec__back', href: '/reconcile', onclick: (event) => open(null, event) }, '← All jobs'),
        h('span', { class: 'fx-dim' }, position),
        h('h2', { class: 'fx-rec__title' }, job.clientName ?? 'No client')),
      job.link?.url ? h('a', { class: 'fx-task__link', href: job.link.url, target: '_blank', rel: 'noopener' }, job.link.exact ? `Open case in ${system} ↗` : `Open ${system} ↗`) : null),
    job.open ? null : h('p', { class: 'fx-notice' }, 'This job is settled already.'),
    invoices.length ? [table, cards] : h('p', { class: 'fx-empty' }, 'Flow found no invoice that may be for this job.'),
    h('div', { class: 'fx-rec__foot' },
      h('span', { class: 'fx-dim' }, invoices.length ? 'None of these?' : ''),
      h('div', { class: 'fx-rec__foot-acts' },
        queue.length > 1 ? h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', onclick: next }, 'Skip') : null,
        canAct && job.open ? h('button', {
          class: 'fx-btn', type: 'button',
          onclick: (event) => act(event.currentTarget, async () => {
            await flow(`/api/invoicing/jobs/${job.id}/no-invoice`, { method: 'POST', body: '{}' });
            await flow(`/api/invoicing/jobs/${job.id}/draft`, { method: 'POST', body: '{}' });
          }, 'Draft invoice made.'),
        }, 'No invoice · Make invoice') : null)),
  ].flat().filter(Boolean));
}
