// Xero › Import › Review: each Xero invoice in Flow's copy that a Flow invoice
// or a Flow job fits, one at a time, Xero beside Flow
// (server/integrations/xero/links.js). ?show=all is the history: every Xero
// invoice in the copy, with a search. The settings and the counts are rows on
// the Xero integration page. It reads Flow's database only: no Xero call.
import { formatCents } from '/assets/ui/invoicing.js';

const XERO_STATUS = { DRAFT: 'Draft', SUBMITTED: 'Waiting for approval', AUTHORISED: 'Approved', PAID: 'Paid' };
const shortDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const money = (cents) => (cents == null ? '—' : formatCents(cents));
const daysApart = (a, b) => (a && b ? Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000)) : 0);

export function xeroStatusWords(row) {
  if (row.status === 'AUTHORISED' && row.amountDueCents > 0 && row.amountDueCents < row.totalCents) return 'Part paid';
  return XERO_STATUS[row.status] ?? row.status;
}

// The Flow side of one fit: a Flow invoice, or a job with no invoice.
export function flowFit(row, index) {
  if (row.state === 'invoice_fits') {
    const i = row.invoices[index];
    return { kind: 'invoice', id: i.id, title: 'Flow invoice', name: i.number ?? 'Draft', date: i.date, totalCents: i.totalCents, count: row.invoices.length,
      action: `Link ${i.number ?? 'this draft'}`, path: 'link', body: { invoiceId: i.id }, done: `${row.number} linked to ${i.number ?? 'the draft'}.` };
  }
  const j = row.jobs[index];
  return { kind: 'job', id: j.id, title: 'Flow job, no invoice', name: j.caseRef ?? 'Job', practitioner: j.practitioner, date: j.jobDate, totalCents: j.totalCents, count: row.jobs.length,
    action: 'Make Flow invoice + link job', path: 'make', body: { jobId: j.id }, done: `Flow invoice made from ${row.number}, job linked.` };
}

export async function renderXeroImport(main, ui) {
  const { h, flow } = ui;
  const canAct = ['owner', 'admin'].includes(ui.me?.person?.role);
  const history = new URLSearchParams(location.search).get('show') === 'all';
  const host = h('div', { class: 'fx-xi' }, h('p', { class: 'fx-dim' }, 'Loading…'));
  const subtitle = h('span', {});
  main.append(
    h('nav', { class: 'fx-crumbs', 'aria-label': 'Breadcrumb' },
      h('a', { href: '/integrations', onclick: (event) => ui.go(event) }, 'Integrations'), h('span', { 'aria-hidden': 'true' }, '›'),
      h('a', { href: '/integrations/xero', onclick: (event) => ui.go(event) }, 'Xero'), h('span', { 'aria-hidden': 'true' }, '›'),
      h('span', {}, history ? 'Xero history' : 'Review')),
    ui.pageHeader(history ? 'Xero history' : 'Review Xero invoices', { subtitle }),
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
  const read = (show, { q = '', offset = 0, limit = 100 } = {}) =>
    flow(`/api/xero/import?organisationId=${organisationId}&show=${show}&limit=${limit}&offset=${offset}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`);
  const act = (xeroInvoiceId, path, body) =>
    flow(`/api/xero/import/${xeroInvoiceId}/${path}`, { method: 'POST', body: JSON.stringify({ organisationId, ...body }) });
  const go = (href, label) => h('a', { href, onclick: (event) => ui.go(event) }, label);

  if (history) return renderHistory();
  return renderReview();

  // One Xero invoice at a time. Skip moves on and changes nothing.
  async function renderReview() {
    let rows;
    try {
      rows = (await read('check')).rows;
    } catch (error) {
      host.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
      return;
    }
    let at = 0;
    let pick = 0;
    const show = () => {
      if (at >= rows.length) {
        subtitle.replaceChildren('Nothing to check.');
        host.replaceChildren(h('div', { class: 'fx-xi__done' },
          h('p', {}, 'Each Xero invoice that fits a Flow invoice or a job is done.'),
          go('/xero-import?show=all', 'Open Xero history')));
        return;
      }
      const row = rows[at];
      const fit = flowFit(row, pick);
      subtitle.replaceChildren(`${at + 1} of ${rows.length} to check`);
      const days = daysApart(row.issuedOn, fit.date);
      const side = (label, lines, accent) => h('section', { class: `fx-xi__side${accent ? ' fx-xi__side--flow' : ''}` },
        h('h2', { class: 'fx-xi__label' }, label),
        h('dl', { class: 'fx-xi__facts' }, lines.filter(Boolean).flatMap(([k, v, tone]) => [h('dt', {}, k), h('dd', { 'data-tone': tone ?? null }, v)])));
      const primary = canAct ? h('button', { class: 'fx-btn fx-btn--primary', type: 'button', onclick: async () => {
        primary.disabled = true;
        try {
          await act(row.xeroInvoiceId, fit.path, fit.body);
          ui.toast(fit.done, 'success');
          rows.splice(at, 1);
          pick = 0;
          show();
        } catch (error) {
          ui.toast(error.message, 'danger');
          primary.disabled = false;
        }
      } }, fit.action) : null;
      host.replaceChildren(
        h('div', { class: 'fx-xi__pair' },
          side('In Xero', [
            ['Invoice', h('span', { class: 'fx-num' }, row.number ?? '—')],
            ['Client', row.clientName ?? '—'],
            ['Date', shortDate(row.issuedOn)],
            ['Total', h('span', { class: 'fx-num' }, money(row.totalCents))],
            ['Status', xeroStatusWords(row)],
          ]),
          h('span', { class: 'fx-xi__eq', 'aria-hidden': 'true' }, '='),
          side(fit.title, [
            [fit.kind === 'invoice' ? 'Invoice' : 'Job', h('span', { class: 'fx-num' }, fit.name)],
            fit.practitioner ? ['Practitioner', fit.practitioner] : null,
            ['Client', row.clientName ?? '—'],
            ['Date', days ? `${shortDate(fit.date)} (${days} ${days === 1 ? 'day' : 'days'} apart)` : shortDate(fit.date), days ? 'warn' : null],
            ['Total', h('span', { class: 'fx-num' }, money(fit.totalCents))],
            ['Status', fit.kind === 'invoice' ? 'Finalised, not in Xero' : 'Ready, no invoice'],
          ], true)),
        h('div', { class: 'fx-xi__acts' },
          fit.count > 1 ? h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', onclick: () => { pick = (pick + 1) % fit.count; show(); } }, `Other match (${pick + 1} of ${fit.count})`) : null,
          h('button', { class: 'fx-btn', type: 'button', onclick: () => { at += 1; pick = 0; show(); } }, 'Skip'),
          primary),
        h('p', { class: 'fx-dim' }, 'Flow keeps its own invoice. The link only records which Xero invoice it is. ', go('/xero-import?show=all', 'Xero history')));
    };
    show();
  }

  // Every Xero invoice in the copy, newest first, with a search.
  async function renderHistory() {
    let q = '';
    let offset = 0;
    const search = h('input', { class: 'fx-input fx-xi__search', type: 'search', autocomplete: 'off', placeholder: 'Search number, client, Reference or amount', 'aria-label': 'Search Xero history' });
    const list = h('div', { class: 'fx-xi__list', role: 'list' });
    const more = h('div', {});
    host.replaceChildren(search, list, more);
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { q = search.value; offset = 0; load(); }, 300);
    });
    const inFlow = (row) => {
      if (row.state === 'linked') return go(`/invoices/${row.link.invoiceId}`, row.link.number ?? 'Flow invoice');
      if (row.state !== 'none') return go('/xero-import', 'To check');
      if (!canAct) return h('span', { class: 'fx-dim' }, 'Not in Flow');
      const button = h('button', { class: 'fx-btn fx-btn--sm', type: 'button', onclick: async () => {
        button.disabled = true;
        try {
          await act(row.xeroInvoiceId, 'make', {});
          ui.toast(`Flow invoice made from ${row.number}.`, 'success');
          offset = 0;
          await load();
        } catch (error) {
          ui.toast(error.message, 'danger');
          button.disabled = false;
        }
      } }, 'Make Flow invoice');
      return button;
    };
    const rowOf = (row) => h('div', { class: 'fx-xi__row', role: 'listitem' },
      h('span', { class: 'fx-num' }, row.number ?? '—'),
      h('span', {}, row.clientName ?? '—'),
      h('span', { class: 'fx-dim' }, shortDate(row.issuedOn)),
      h('span', { class: 'fx-num fx-xi__total' }, money(row.totalCents)),
      h('span', { class: 'fx-xi__flow' }, inFlow(row)));
    async function load() {
      let body;
      try {
        body = await read('all', { q, offset, limit: 50 });
      } catch (error) {
        list.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
        return;
      }
      const all = Object.values(body.counts).reduce((a, b) => a + b, 0);
      subtitle.replaceChildren(`${all} Xero invoices copied. ${body.counts.linked} in Flow.`);
      const rows = body.rows.map(rowOf);
      if (offset === 0) list.replaceChildren(...(rows.length ? rows : [h('p', { class: 'fx-empty' }, q.trim() ? 'No Xero invoice matches the search.' : 'No Xero invoices copied yet.')]));
      else list.append(...rows);
      const shown = offset + body.rows.length;
      more.replaceChildren(...(shown < body.total ? [h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', onclick: () => { offset = shown; load(); } }, `Show more (${body.total - shown})`)] : []));
    }
    await load();
  }
}
