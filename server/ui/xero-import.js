// Xero › Import › Review: each Xero invoice in Flow's copy that a Flow invoice
// or a Flow job fits (server/integrations/xero/links.js). Two views:
//   card  one Xero invoice beside its Flow fit, one fact per row, ✓ or ≠
//         between them; Skip, Other match, Link.
//   list  every one to check, ticked rows linked together from the bulk bar.
// ?show=all is the history: every Xero invoice in the copy, with a search;
// ticked rows with nothing in Flow get a Flow invoice from the bulk bar.
// The settings and the counts are rows on the Xero integration page. It reads
// Flow's database only: no Xero call.
import { bulkBar } from '/assets/ui/bulk-bar.js';
import { lucide } from '/assets/ui/custom-fields.js';
import { formatCents } from '/assets/ui/invoicing.js';
import { applyPhoneRule, assignPhoneSlots, phoneSlot } from './mobile.js';

// The list rows use the same phone slots as a column list.
const phoneAt = (defs) => {
  const columns = assignPhoneSlots(defs);
  return (index) => {
    const slot = phoneSlot(columns[index]);
    return slot ? { 'data-phone-slot': slot } : {};
  };
};

const XERO_STATUS = { DRAFT: 'Draft', SUBMITTED: 'Awaiting approval', AUTHORISED: 'Approved', PAID: 'Paid' };
const XERO_TONE = { DRAFT: 'neutral', SUBMITTED: 'warn', AUTHORISED: 'info', PAID: 'success' };
const shortDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const money = (cents) => (cents == null ? '—' : formatCents(cents));
const daysApart = (a, b) => (a && b ? Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000)) : 0);
const sameSet = (a = [], b = []) => a.length === b.length && a.every((c) => b.includes(c));
const words = (text) => String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export function xeroStatusWords(row) {
  if (row.status === 'AUTHORISED' && row.amountDueCents > 0 && row.amountDueCents < row.totalCents) return 'Part paid';
  return XERO_STATUS[row.status] ?? row.status;
}

// The Flow side of one fit: a Flow invoice, or a job with no invoice.
export function flowFit(row, index = 0) {
  if (row.state === 'invoice_fits') {
    const i = row.invoices[index];
    return { kind: 'invoice', id: i.id, name: i.number ?? 'Draft', date: i.date, totalCents: i.totalCents, reference: i.reference ?? null, itemCodes: i.itemCodes ?? [],
      count: row.invoices.length, hard: Boolean(i.hard), path: 'link', body: { invoiceId: i.id } };
  }
  const j = row.jobs[index];
  return { kind: 'job', id: j.id, name: j.caseRef ?? 'Job', date: j.jobDate, totalCents: j.totalCents, reference: j.practitioner ?? null, itemCodes: j.itemCodes ?? [],
    count: row.jobs.length, hard: Boolean(j.tied), path: 'make', body: { jobId: j.id } };
}

// ✓ same, ≠ different, nothing when a side is empty. `tip` says how.
export function agreement(left, right, same) {
  if (left == null || right == null || left === '' || right === '') return null;
  return same ? 'same' : 'differs';
}

export async function renderXeroImport(main, ui) {
  const { h, flow } = ui;
  const canAct = ['owner', 'admin'].includes(ui.me?.person?.role);
  const params = new URLSearchParams(location.search);
  const history = params.get('show') === 'all';
  const icon = (name, label) => lucide(h, name, label);
  const host = h('div', { class: 'fx-xi' }, h('p', { class: 'fx-dim' }, 'Loading…'));
  const tally = h('span', {});
  const actions = [];
  let view = params.get('view') === 'list' ? 'list' : 'card';
  if (!history) {
    const toggle = (name, label, glyph) => h('button', {
      class: 'fx-xi__view', type: 'button', role: 'tab', 'aria-selected': String(view === name), 'aria-label': label, title: label, 'data-view': name,
      onclick: () => setView(name),
    }, icon(glyph));
    actions.push(h('div', { class: 'fx-xi__views', role: 'tablist', 'aria-label': 'View' }, toggle('card', 'One at a time', 'square'), toggle('list', 'List, tick many', 'list-checks')));
  }
  function setView(name) {
    view = name;
    window.history.replaceState(null, '', view === 'list' ? '/xero-import?view=list' : '/xero-import');
    for (const b of main.querySelectorAll('.fx-xi__view')) b.setAttribute('aria-selected', String(b.dataset.view === view));
    renderReview();
  }
  main.append(
    ui.crumbs(['/integrations', 'Integrations'], ['/integrations/xero', 'Xero'], history ? 'History' : 'Review'),
    ui.pageHeader(history ? 'Xero history' : 'Review', { count: tally, actions }),
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
  // Runs one step for each row, one at a time; answers how many went through.
  const each = async (rows, step) => {
    let done = 0;
    for (const row of rows) {
      try { await step(row); done += 1; } catch { /* the row stays; the toast counts it */ }
    }
    ui.toast(done === rows.length ? `${done} done.` : `${done} of ${rows.length} done. The rest stay here.`, done === rows.length ? 'success' : 'warn');
  };
  const go = (href, label) => h('a', { href, onclick: (event) => ui.go(event) }, label);
  const xeroMark = () => h('img', { class: 'fx-xi__mark', src: '/assets/ui/logos/xero.svg', alt: 'Xero' });
  const flowMark = () => h('img', { class: 'fx-xi__mark', src: '/assets/ui/flow-mark.svg', alt: 'Flow' });
  const pill = (row) => h('span', { class: 'fx-status', 'data-tone': XERO_TONE[row.status] ?? 'neutral' }, xeroStatusWords(row));
  const fitIcon = (fit) => (fit.hard ? icon('link-2', 'Tied by Seazona or the matcher') : fit.kind === 'job' ? icon('briefcase', 'A job fits') : icon('receipt', 'A Flow invoice fits'));
  const bulk = bulkBar(ui);
  main.append(bulk.element);

  if (history) return renderHistory();
  return renderReview();

  async function renderReview() {
    bulk.draw({ count: 0 });
    let rows;
    try {
      rows = (await read('check')).rows;
    } catch (error) {
      host.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
      return;
    }
    if (!rows.length) {
      tally.replaceChildren('');
      host.replaceChildren(h('div', { class: 'fx-xi__done' }, icon('check-check'), h('p', {}, 'Nothing to check.'), go('/xero-import?show=all', 'Xero history')));
      return;
    }
    return view === 'list' ? reviewList(rows) : reviewCard(rows);
  }

  // One Xero invoice at a time. Skip moves on and changes nothing.
  function reviewCard(rows) {
    let at = 0;
    let pick = 0;
    const show = () => {
      if (at >= rows.length) return renderReview();
      const row = rows[at];
      const fit = flowFit(row, pick);
      const bar = h('span', { class: 'fx-xi__progress', role: 'progressbar', 'aria-valuemin': '1', 'aria-valuemax': String(rows.length), 'aria-valuenow': String(at + 1) },
        h('span', { style: { width: `${((at + 1) / rows.length) * 100}%` } }));
      tally.replaceChildren(h('span', { class: 'fx-xi__count' }, bar, `${at + 1} / ${rows.length}`));
      const days = daysApart(row.issuedOn, fit.date);
      const facts = [
        ['hash', 'Number', h('span', { class: 'fx-num' }, row.number ?? '—'), h('span', { class: 'fx-num' }, fit.name), null],
        ['building-2', 'Client', row.clientName ?? '—', row.clientName ?? '—', 'same'],
        ['calendar', 'Date', shortDate(row.issuedOn), shortDate(fit.date), days ? 'differs' : 'same', days ? `${days} ${days === 1 ? 'day' : 'days'} apart` : null],
        ['dollar-sign', 'Total', h('span', { class: 'fx-num' }, money(row.totalCents)), h('span', { class: 'fx-num' }, money(fit.totalCents)), agreement(row.totalCents, fit.totalCents, row.totalCents === fit.totalCents)],
        ['list', 'Items', (row.itemCodes ?? []).join(', ') || '—', fit.itemCodes.join(', ') || '—', agreement(row.itemCodes?.length || null, fit.itemCodes.length || null, sameSet(row.itemCodes, fit.itemCodes))],
        ['tag', fit.kind === 'job' ? 'Reference / practitioner' : 'Reference', row.reference ?? '—', fit.reference ?? '—',
          agreement(row.reference, fit.reference, fit.kind === 'job' ? words(row.reference).includes(words(fit.reference)) : words(row.reference) === words(fit.reference))],
        ['circle-dot', 'Status', pill(row), h('span', { class: 'fx-status', 'data-tone': 'warn' }, fit.kind === 'job' ? 'No invoice' : 'Not in Xero'), null],
      ];
      const mark = (state, tip) => (state === 'same' ? h('span', { class: 'fx-xi__agree', 'data-state': 'same' }, icon('equal', tip ?? 'Same'))
        : state === 'differs' ? h('span', { class: 'fx-xi__agree', 'data-state': 'differs' }, icon('equal-not', tip ?? 'Different')) : h('span', {}));
      const table = h('table', { class: 'fx-xi-cmp' },
        h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, xeroMark()), h('th', {}), h('th', {}, flowMark(), fitIcon(fit)))),
        h('tbody', {}, facts.map(([glyph, label, left, right, state, tip]) => h('tr', {},
          h('th', { scope: 'row' }, icon(glyph, label)),
          h('td', {}, left), h('td', { class: 'fx-xi-cmp__mid' }, mark(state, tip)), h('td', {}, right)))));
      const primary = canAct ? h('button', { class: 'fx-btn fx-btn--primary', type: 'button', onclick: async () => {
        primary.disabled = true;
        try {
          await act(row.xeroInvoiceId, fit.path, fit.body);
          ui.toast(fit.kind === 'job' ? 'Made and linked.' : 'Linked.', 'success');
          rows.splice(at, 1);
          pick = 0;
          show();
        } catch (error) {
          ui.toast(error.message, 'danger');
          primary.disabled = false;
        }
      } }, icon(fit.kind === 'job' ? 'file-plus-2' : 'link-2'), fit.kind === 'job' ? 'Make + link' : 'Link') : null;
      host.replaceChildren(
        bulkStrip(rows),
        table,
        h('div', { class: 'fx-xi__acts' },
          fit.count > 1 ? h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', title: 'Other match', 'aria-label': 'Other match', onclick: () => { pick = (pick + 1) % fit.count; show(); } },
            icon('arrow-left-right'), `${pick + 1}/${fit.count}`) : null,
          h('button', { class: 'fx-btn', type: 'button', onclick: () => { at += 1; pick = 0; show(); } }, icon('skip-forward'), 'Skip'),
          primary));
    };
    show();
  }

  // The bulk shortcut on the card view: every sure one at once, or the list.
  function bulkStrip(rows) {
    const sure = rows.filter((r) => r.sure);
    return h('div', { class: 'fx-xi__bulk' },
      icon('list-checks'),
      h('span', { class: 'fx-xi__bulk-text' }, `${rows.length} to check`),
      canAct && sure.length ? h('button', { class: 'fx-btn fx-btn--sm fx-btn--primary', type: 'button', onclick: async (event) => {
        event.currentTarget.disabled = true;
        await each(sure, (row) => { const fit = flowFit(row); return act(row.xeroInvoiceId, fit.path, fit.body); });
        renderReview();
      } }, icon('check-check'), `Link ${sure.length} sure`) : null,
      h('button', { class: 'fx-btn fx-btn--sm', type: 'button', onclick: () => setView('list') },
        icon('list-checks'), 'Tick many'));
  }

  // Every one to check, best fit beside it; ticked rows go from the bulk bar.
  function reviewList(rows) {
    tally.replaceChildren(`${rows.length} to check`);
    const ticked = new Set();
    const boxes = new Map();
    const drawBar = () => {
      const picked = rows.filter((r) => ticked.has(r.xeroInvoiceId));
      bulk.draw({
        count: canAct ? picked.length : 0,
        onClear: () => { ticked.clear(); for (const b of boxes.values()) b.checked = false; all.checked = false; drawBar(); },
        groups: [[{ icon: 'link-2', label: 'Link', title: 'Link each to its best match', primary: true, run: async () => {
          await each(picked, (row) => { const fit = flowFit(row); return act(row.xeroInvoiceId, fit.path, fit.body); });
          renderReview();
        } }]],
      });
    };
    const all = h('input', { type: 'checkbox', class: 'fx-tick', 'aria-label': 'Tick all', onchange: () => {
      for (const r of rows) { if (all.checked) ticked.add(r.xeroInvoiceId); else ticked.delete(r.xeroInvoiceId); }
      for (const b of boxes.values()) b.checked = all.checked;
      drawBar();
    } });
    const sure = rows.filter((r) => r.sure);
    const at = phoneAt([
      { kind: 'text', label: 'Number' },
      { kind: 'client', label: 'Client', phone: 'title' },
      { kind: 'date', label: 'Date', phone: 'meta' },
      { kind: 'total', num: true, label: 'Total' },
      { kind: 'status', label: 'Match', phone: 'meta' },
      { kind: 'text', label: 'Flow', phone: 'meta' },
      { kind: 'date', label: 'Flow date', phone: 'hide' },
      { kind: 'total', label: 'Flow total', phone: 'hide' },
    ]);
    host.replaceChildren(
      h('div', { class: 'fx-xi__bulk' }, icon('list-checks'), h('span', { class: 'fx-xi__bulk-text' }, 'Tick rows, then use the bar below.'),
        canAct && sure.length ? h('button', { class: 'fx-btn fx-btn--sm', type: 'button', onclick: () => {
          for (const r of sure) { ticked.add(r.xeroInvoiceId); boxes.get(r.xeroInvoiceId).checked = true; }
          drawBar();
        } }, icon('check-check'), `Tick ${sure.length} sure`) : null),
      applyPhoneRule(h('div', { class: 'fx-xi__scroll' }, h('table', { class: 'fx-table fx-table--rows fx-xi-list' },
        h('thead', {}, h('tr', {},
          canAct ? h('th', { class: 'fx-tick-cell' }, all) : null,
          h('th', { colspan: '4' }, xeroMark()), h('th', { class: 'fx-xi-list__mid' }), h('th', { colspan: '3' }, flowMark()))),
        h('tbody', {}, rows.map((row) => {
          const fit = flowFit(row);
          const box = h('input', { type: 'checkbox', class: 'fx-tick', 'aria-label': `Tick ${row.number}`, onchange: () => {
            if (box.checked) ticked.add(row.xeroInvoiceId); else ticked.delete(row.xeroInvoiceId);
            drawBar();
          } });
          boxes.set(row.xeroInvoiceId, box);
          return h('tr', {},
            canAct ? h('td', { class: 'fx-tick-cell' }, box) : null,
            h('td', { class: 'fx-num', ...at(0) }, row.number ?? '—'),
            h('td', { ...at(1) }, row.clientName ?? '—'),
            h('td', { class: 'fx-dim', ...at(2) }, shortDate(row.issuedOn)),
            h('td', { class: 'fx-num fx-strong', ...at(3) }, money(row.totalCents)),
            h('td', { class: 'fx-xi-list__mid', ...at(4) }, row.sure ? icon('check-check', 'Sure') : fitIcon(fit), fit.count > 1 ? h('span', { class: 'fx-dim' }, `${fit.count}`) : null),
            h('td', { class: 'fx-num', ...at(5) }, fit.name),
            h('td', { class: 'fx-dim', ...at(6) }, shortDate(fit.date)),
            h('td', { class: 'fx-num fx-strong', ...at(7) }, money(fit.totalCents)));
        })))), 'columnTable'));
    drawBar();
  }

  // Every Xero invoice in the copy, newest first, with a search. Ticked rows
  // that nothing in Flow fits get a Flow invoice from the bulk bar.
  async function renderHistory() {
    let q = '';
    let offset = 0;
    let shown = [];
    const ticked = new Set();
    const search = h('input', { class: 'fx-input fx-xi__search', type: 'search', autocomplete: 'off', placeholder: 'Number, client, Reference or amount', 'aria-label': 'Search Xero history' });
    const body = h('tbody', {});
    const all = h('input', { type: 'checkbox', class: 'fx-tick', 'aria-label': 'Tick all shown', onchange: () => {
      for (const r of shown) { if (all.checked) ticked.add(r.xeroInvoiceId); else ticked.delete(r.xeroInvoiceId); }
      for (const b of body.querySelectorAll('.fx-tick')) b.checked = all.checked;
      drawBar();
    } });
    const more = h('div', {});
    const STATE = { linked: ['check', 'In Flow'], invoice_fits: ['receipt', 'A Flow invoice fits'], job_fits: ['briefcase', 'A job fits'], none: ['circle-dashed', 'Not in Flow'] };
    const at = phoneAt([
      { kind: 'status', label: 'State', phone: 'meta' },
      { kind: 'text', label: 'Number' },
      { kind: 'client', label: 'Client', phone: 'title' },
      { kind: 'date', label: 'Date', phone: 'meta' },
      { kind: 'total', num: true, label: 'Total' },
      { kind: 'status', label: 'Xero', phone: 'meta' },
      { kind: 'text', label: 'Flow', phone: 'hide' },
    ]);
    host.replaceChildren(
      h('div', { class: 'fx-xi__bulk' }, icon('search'), search),
      applyPhoneRule(h('div', { class: 'fx-xi__scroll' }, h('table', { class: 'fx-table fx-table--rows fx-xi-list' },
        h('thead', {}, h('tr', {},
          canAct ? h('th', { class: 'fx-tick-cell' }, all) : null,
          h('th', {}, ''), h('th', {}, 'Number'), h('th', {}, 'Client'), h('th', {}, 'Date'), h('th', { class: 'fx-num' }, 'Total'), h('th', {}, xeroMark()), h('th', {}, flowMark()))),
        body)), 'columnTable'),
      more);
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { q = search.value; offset = 0; load(); }, 300);
    });
    function drawBar() {
      const picked = shown.filter((r) => ticked.has(r.xeroInvoiceId));
      const free = picked.filter((r) => r.state === 'none');
      bulk.draw({
        count: canAct ? picked.length : 0,
        onClear: () => { ticked.clear(); for (const b of body.querySelectorAll('.fx-tick')) b.checked = false; all.checked = false; drawBar(); },
        groups: [[{ icon: 'file-plus-2', label: free.length === picked.length ? 'Make Flow invoices' : `Make ${free.length} Flow invoices`, title: 'Make a Flow invoice for each ticked one not in Flow', primary: true, run: async () => {
          if (!free.length) { ui.toast('Each ticked one is in Flow or fits something. Use Review.', 'warn'); return; }
          await each(free, (row) => act(row.xeroInvoiceId, 'make', {}));
          ticked.clear();
          offset = 0;
          await load();
        } }]],
      });
    }
    const rowOf = (row) => {
      const [glyph, label] = STATE[row.state];
      const box = h('input', { type: 'checkbox', class: 'fx-tick', 'aria-label': `Tick ${row.number}`, ...(ticked.has(row.xeroInvoiceId) ? { checked: true } : {}), onchange: () => {
        if (box.checked) ticked.add(row.xeroInvoiceId); else ticked.delete(row.xeroInvoiceId);
        drawBar();
      } });
      return h('tr', { 'data-state': row.state },
        canAct ? h('td', { class: 'fx-tick-cell' }, box) : null,
        h('td', { class: 'fx-xi-list__mid', ...at(0) }, row.state === 'linked' || row.state === 'none' ? icon(glyph, label) : h('a', { href: '/xero-import', onclick: (event) => ui.go(event), 'aria-label': label, title: label }, icon(glyph))),
        h('td', { class: 'fx-num', ...at(1) }, row.number ?? '—'),
        h('td', { ...at(2) }, row.clientName ?? '—'),
        h('td', { class: 'fx-dim', ...at(3) }, shortDate(row.issuedOn)),
        h('td', { class: 'fx-num fx-strong', ...at(4) }, money(row.totalCents)),
        h('td', { ...at(5) }, pill(row)),
        h('td', { class: 'fx-num', ...at(6) }, row.state === 'linked' ? go(`/invoices/${row.link.invoiceId}`, row.link.number ?? 'Draft') : ''));
    };
    async function load() {
      let page;
      try {
        page = await read('all', { q, offset, limit: 50 });
      } catch (error) {
        body.replaceChildren(h('tr', {}, h('td', { colspan: '8', class: 'fx-empty' }, error.message)));
        return;
      }
      const total = Object.values(page.counts).reduce((a, b) => a + b, 0);
      tally.replaceChildren(h('span', { class: 'fx-xi__count' }, icon('check', 'In Flow'), `${page.counts.linked} / ${total}`));
      shown = offset === 0 ? page.rows : [...shown, ...page.rows];
      const rows = page.rows.map(rowOf);
      if (offset === 0) body.replaceChildren(...(rows.length ? rows : [h('tr', {}, h('td', { colspan: '8', class: 'fx-empty' }, q.trim() ? 'No match.' : 'No Xero invoices copied yet.'))]));
      else body.append(...rows);
      const seen = offset + page.rows.length;
      more.replaceChildren(...(seen < page.total ? [h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', onclick: () => { offset = seen; load(); } }, `Show more (${page.total - seen})`)] : []));
      drawBar();
    }
    await load();
  }
}
