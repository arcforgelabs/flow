// Xero › Import: each sales invoice in Flow's copy of Xero against Flow's own
// invoices (server/integrations/xero/links.js). Flow's own records are the
// ones it works from; this page says which Flow invoice each Xero invoice is.
// A sure fit is linked by the import itself. A person links the rest, or
// makes the Flow invoice from the Xero one, with its job when one fits. It
// reads Flow's database only: no Xero call. API: /api/xero/import.
import { formatCents } from '/assets/ui/invoicing.js';

const SHOW = [
  ['job_fits', 'A job fits'],
  ['invoice_fits', 'A Flow invoice fits'],
  ['none', 'Nothing fits'],
  ['linked', 'Linked'],
  ['all', 'All'],
];
const XERO_STATUS = { DRAFT: 'Draft', SUBMITTED: 'Waiting for approval', AUTHORISED: 'Approved', PAID: 'Paid' };
const MATCHED_BY = { sent: 'sent from Flow', auto: 'matched by the import', person: 'linked by a person', made: 'made from Xero' };
const shortDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const money = (cents) => (cents == null ? '—' : formatCents(cents));

export function xeroStatusWords(row) {
  if (row.status === 'AUTHORISED' && row.amountDueCents > 0 && row.amountDueCents < row.totalCents) return 'Part paid';
  return XERO_STATUS[row.status] ?? row.status;
}

export async function renderXeroImport(main, ui) {
  const { h, flow } = ui;
  const canAct = ['owner', 'admin'].includes(ui.me?.person?.role);
  const params = new URLSearchParams(location.search);
  let show = SHOW.some(([s]) => s === params.get('show')) ? params.get('show') : 'job_fits';
  let q = '';
  let offset = 0;

  const host = h('div', { class: 'fx-xi' }, h('p', { class: 'fx-dim' }, 'Loading…'));
  main.append(
    h('nav', { class: 'fx-crumbs', 'aria-label': 'Breadcrumb' },
      h('a', { href: '/integrations', onclick: (event) => ui.go(event) }, 'Integrations'), h('span', { 'aria-hidden': 'true' }, '›'),
      h('a', { href: '/integrations/xero', onclick: (event) => ui.go(event) }, 'Xero'), h('span', { 'aria-hidden': 'true' }, '›'),
      h('span', {}, 'Import')),
    ui.pageHeader('Xero import', { subtitle: 'Each Xero invoice, and the Flow invoice it is. Read from Flow\'s copy of Xero.' }),
    host);

  let organisationId;
  try {
    organisationId = (await flow('/api/invoicing/context')).organisations?.[0]?.id;
  } catch (error) {
    host.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
    return;
  }
  if (!organisationId) {
    host.replaceChildren(h('p', { class: 'fx-empty' }, 'No organisation.'));
    return;
  }

  const chips = h('div', { class: 'fx-xi__chips', role: 'tablist' });
  const toggle = h('input', { type: 'checkbox', class: 'fx-xi__switch', disabled: !canAct, 'aria-label': 'Make a Flow invoice for each Xero invoice nothing fits' });
  const setting = h('label', { class: 'fx-xi__setting' },
    h('span', {}, 'Make a Flow invoice for each Xero invoice nothing fits'), toggle);
  const search = h('input', { class: 'fx-input fx-xi__search', type: 'search', autocomplete: 'off', placeholder: 'Search the copy: number, client, Reference, amount', 'aria-label': 'Search Xero invoices' });
  const match = canAct ? h('button', { class: 'fx-btn', type: 'button', onclick: () => run(match) }, 'Match now') : null;
  const list = h('div', { class: 'fx-xi__list', role: 'list' });
  const more = h('div', { class: 'fx-xi__more' });
  host.replaceChildren(chips, setting, h('div', { class: 'fx-xi__tools' }, search, match), list, more,
    h('p', { class: 'fx-dim' }, 'A Xero invoice with no Flow invoice stays here. Nothing is lost. Make its Flow invoice at any time.'));

  toggle.addEventListener('change', async () => {
    try {
      const { settings } = await flow('/api/xero/import/settings', { method: 'PUT', body: JSON.stringify({ organisationId, makeUnmatched: toggle.checked }) });
      toggle.checked = settings.makeUnmatched;
      ui.toast(settings.makeUnmatched ? 'On. Flow makes them at the next match.' : 'Off.', 'success');
    } catch (error) {
      toggle.checked = !toggle.checked;
      ui.toast(error.message, 'danger');
    }
  });
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { q = search.value; offset = 0; load(); }, 300);
  });

  async function run(button) {
    button.disabled = true;
    try {
      const result = await flow('/api/xero/import/match', { method: 'POST', body: JSON.stringify({ organisationId }) });
      ui.toast(`${result.linked} linked, ${result.made} made.`, 'success');
      offset = 0;
      await load();
    } catch (error) {
      ui.toast(error.message, 'danger');
    }
    button.disabled = false;
  }
  async function act(button, path, body, done) {
    button.disabled = true;
    try {
      await flow(`/api/xero/import/${path}`, { method: 'POST', body: JSON.stringify({ organisationId, ...body }) });
      ui.toast(done, 'success');
      await load();
    } catch (error) {
      ui.toast(error.message, 'danger');
      button.disabled = false;
    }
  }

  const inFlow = (href, label) => h('a', { class: 'fx-task__link', href, onclick: (event) => ui.go(event) }, label);
  function inFlowCell(row) {
    if (row.state === 'linked') {
      return [h('span', { 'data-state': 'linked' }, inFlow(`/invoices/${row.link.invoiceId}`, row.link.number ?? 'Flow invoice')),
        h('span', { class: 'fx-dim' }, MATCHED_BY[row.link.matchedBy] ?? '')];
    }
    if (row.state === 'invoice_fits') {
      return [h('span', { 'data-state': 'fits' }, `${row.invoices.length === 1 ? 'A Flow invoice fits' : `${row.invoices.length} Flow invoices fit`}`),
        h('span', { class: 'fx-dim' }, row.invoices.map((i) => `${i.number ?? 'Draft'} · ${shortDate(i.date)}`).join(', '))];
    }
    if (row.state === 'job_fits') {
      const job = row.jobs[0];
      return [h('span', { 'data-state': 'fits' }, `${row.jobs.length === 1 ? 'A job fits' : `${row.jobs.length} jobs fit`}`),
        h('span', { class: 'fx-dim' }, [job.tied ? 'Tied to this invoice' : null, shortDate(job.jobDate), job.practitioner, job.caseRef].filter(Boolean).join(' · '))];
    }
    return [h('span', { 'data-state': 'none' }, 'Nothing fits')];
  }
  function actions(row) {
    if (!canAct || row.state === 'linked') return [];
    if (row.state === 'invoice_fits') {
      return row.invoices.map((i, index) => h('button', {
        class: `fx-btn fx-btn--sm${index === 0 ? ' fx-btn--primary' : ''}`, type: 'button',
        onclick: (event) => act(event.currentTarget, `${row.xeroInvoiceId}/link`, { invoiceId: i.id }, `${row.number} is ${i.number ?? 'the draft'}.`),
      }, `Link ${i.number ?? 'draft'}`));
    }
    if (row.state === 'job_fits') {
      return [h('button', {
        class: 'fx-btn fx-btn--sm fx-btn--primary', type: 'button',
        onclick: (event) => act(event.currentTarget, `${row.xeroInvoiceId}/make`, { jobId: row.jobs[0].id }, 'Flow invoice made and linked.'),
      }, 'Make Flow invoice + link job')];
    }
    return [h('button', {
      class: 'fx-btn fx-btn--sm', type: 'button',
      onclick: (event) => act(event.currentTarget, `${row.xeroInvoiceId}/make`, {}, 'Flow invoice made.'),
    }, 'Make Flow invoice')];
  }
  const rowOf = (row) => h('div', { class: 'fx-xi__row', role: 'listitem', 'data-state': row.state },
    h('span', { class: 'fx-xi__num' }, h('span', { class: 'fx-strong' }, row.number ?? '—'), h('span', { class: 'fx-dim' }, xeroStatusWords(row))),
    h('span', { class: 'fx-xi__client' }, h('span', {}, row.clientName ?? '—'), h('span', { class: 'fx-dim' }, shortDate(row.issuedOn))),
    h('span', { class: 'fx-xi__total fx-num' }, money(row.totalCents)),
    h('span', { class: 'fx-xi__flow' }, inFlowCell(row)),
    h('span', { class: 'fx-xi__acts' }, actions(row)));

  async function load() {
    let body;
    try {
      body = await flow(`/api/xero/import?organisationId=${organisationId}&show=${show}&offset=${offset}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`);
    } catch (error) {
      list.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
      return;
    }
    toggle.checked = body.settings.makeUnmatched;
    const all = Object.values(body.counts).reduce((a, b) => a + b, 0);
    chips.replaceChildren(...SHOW.map(([name, label]) => h('button', {
      class: 'fx-rec__tab', type: 'button', role: 'tab', 'aria-selected': String(name === show),
      onclick: () => { show = name; offset = 0; history.replaceState(null, '', `/xero-import?show=${name}`); load(); },
    }, `${label} · ${name === 'all' ? all : body.counts[name]}`)));
    const rows = body.rows.map(rowOf);
    if (offset === 0) list.replaceChildren(...(rows.length ? rows : [h('p', { class: 'fx-empty' }, q.trim() ? 'No Xero invoice matches the search.' : 'None here.')]));
    else list.append(...rows);
    const shown = offset + body.rows.length;
    more.replaceChildren(...(shown < body.total ? [h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', onclick: () => { offset = shown; load(); } }, `Show more (${body.total - shown})`)] : []));
  }
  await load();
}
