// Invoices: the list (/invoices) and one invoice (/invoices/new,
// /invoices/<id>). A draft is edited in place; issuing gives it its number
// and keeps the document exactly as sent. Money is whole cents on the wire
// and dollars on screen. The server works out every total; the totals here
// are a preview with the same rule (GST 10% per line, rounded half away from
// zero, server/core/money.js). Data comes from /api/invoicing
// (server/api/invoicing.js). app.js passes in its shared pieces as `ui`.
import { alertStrip } from '/assets/ui/alerts.js';
import { bulkBar } from '/assets/ui/bulk-bar.js';
import { draftNote, sendModeNote } from '/assets/ui/invoice-notes.js';
import { caseNumber } from '/assets/ui/job-board.js';
import { jobChangeBanner } from '/assets/ui/job-change.js';

// The tabs, left to right (server/api/invoicing.js, TABS): Pending (a
// person must look), Ready (checks pass), then the accounting system's
// stages: Draft (a draft there, or on its way), Approved, Sent (to the
// customer). With no accounting system, an issued invoice is Approved.
const TABS = [['pending', 'Pending'], ['ready', 'Ready'], ['draft', 'Draft'], ['approved', 'Approved'], ['sent', 'Sent'], ['void', 'Void']];
const TAB_LABEL = Object.fromEntries(TABS);
const TAB_TONE = { pending: 'danger', ready: 'success', draft: 'info', approved: 'info', sent: 'success', void: 'mute' };
// Tab names an earlier Flow kept in this browser.
const OLD_TAB = { problem: 'pending', to_check: 'ready', issued: 'approved' };
const NUMBERED = ['draft', 'approved', 'sent', 'void'];
const EMPTY = {
  pending: 'Nothing needs a look.',
  ready: 'Nothing is ready. Press New invoice to start one.',
};
// Every tab's rows can be ticked; the bulk bar (bulkActions) says what the
// ticked rows can do there.

const money = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
export const formatCents = (cents) => money.format((cents ?? 0) / 100);

// Xero's status of an issued invoice, from Flow's copy of Xero (issue #132).
// A finding (a difference, or a void on one side only) shows as Out of sync.
const XERO_TONE = {
  not_sent: 'mute', sending: 'info', not_copied: 'info', draft: 'info',
  approved: 'success', part_paid: 'success', paid: 'success', voided: 'mute', deleted: 'mute',
};
const FIELD_LABEL = { contact: 'Client', subtotal: 'Subtotal', tax: 'GST', total: 'Total', 'line count': 'Lines', items: 'Items', date: 'Date' };

export function xeroTag(ui, status) {
  const { h } = ui;
  if (!status) return null;
  return status.finding
    ? h('span', { class: 'fx-status', 'data-tone': 'danger', title: status.message }, 'Out of sync with Xero')
    : h('span', { class: 'fx-status', 'data-tone': XERO_TONE[status.state] ?? 'mute' }, status.label);
}

// The Linked column: one icon for each connected system (linksTo), with a
// dot for the state of this invoice's link there. An icon with a link opens
// the record in that system. Accounting icons show on numbered invoices only.
const LINK_TONE = {
  not_sent: 'warn', sending: 'warn', not_copied: 'warn', draft: 'success',
  approved: 'success', part_paid: 'success', paid: 'success', voided: 'mute', deleted: 'mute',
};
export function linkIcon(ui, system, { tone = null, title, url = null } = {}) {
  const { h } = ui;
  const kids = [h('img', { src: `/assets/ui/logos/${system.id}.svg`, alt: '' }), tone ? h('i', { class: 'fx-link__dot', 'data-tone': tone }) : null];
  const props = { class: `fx-link${tone ? '' : ' fx-link--none'}`, title, 'aria-label': title };
  return url
    ? h('a', { ...props, href: url, target: '_blank', rel: 'noopener', onclick: (event) => event.stopPropagation() }, ...kids)
    : h('span', props, ...kids);
}

function workIcon(ui, system, job) {
  if (job?.sourceSystem !== system.id) return linkIcon(ui, system, { title: `Not linked to ${system.name}` });
  const ref = job.caseRef ?? job.sourceJobRef;
  return linkIcon(ui, system, { tone: 'success', title: `${system.name} ${ref}${job.link?.url ? `. Open in ${system.name}.` : ''}`, url: job.link?.url ?? null });
}

export function accountingIcon(ui, system, status) {
  const tone = status.finding ? 'danger' : LINK_TONE[status.state] ?? 'mute';
  const number = status.xero?.number ? ` ${status.xero.number}` : '';
  const title = `${system.name}${number}: ${status.finding ? status.message : status.label}${status.xero?.url ? ` Open in ${system.name}.` : ''}`;
  return linkIcon(ui, system, { tone, title, url: status.xero?.url ?? null });
}

const showField = (field, value) => (['subtotal', 'tax', 'total'].includes(field) && Number.isFinite(value) ? formatCents(value) : String(value ?? '—'));

// Xero's status for some invoices, or an empty map while Xero is off.
async function xeroStatuses(ui, organisationId, invoiceIds) {
  if (!organisationId || !invoiceIds.length) return new Map();
  const res = await ui.flow('/api/xero/invoices/status', { method: 'POST', body: JSON.stringify({ organisationId, invoiceIds }) }).catch(() => null);
  return new Map((res?.invoices ?? []).map((s) => [s.invoiceId, s]));
}

function gstCents(lineAmountCents) {
  const sign = Math.sign(lineAmountCents);
  const abs = Math.abs(lineAmountCents) * 1000;
  return sign * Math.floor((abs * 2 + 10_000) / 20_000);
}

// Dollars typed by a person, to whole cents; null when it is not a number.
function toCents(text) {
  const clean = String(text ?? '').replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{0,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

const fromCents = (cents) => (cents == null ? '' : (cents / 100).toFixed(2));

function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const showDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

// ── The list ───────────────────────────────────────────────────────────────

export async function renderInvoiceList(main, ui) {
  const { h, flow, pageHeader, notice, go, toast } = ui;
  const saved = OLD_TAB[sessionStorage.getItem('flow_invoice_tab')] ?? sessionStorage.getItem('flow_invoice_tab');
  // Back from an invoice comes here with the tab, search and scroll it left.
  const back = readNav();
  const returning = sessionStorage.getItem(NAV_BACK) === '1';
  sessionStorage.removeItem(NAV_BACK);
  const state = { status: TABS.some(([id]) => id === saved) ? saved : 'ready', q: returning ? back?.q ?? '' : '', ticked: new Set() };
  const tabs = h('div', { class: 'fx-tabs', role: 'tablist' });
  const search = h('input', { class: 'fx-input fx-search', type: 'search', placeholder: 'Find a number, client or reference', 'aria-label': 'Find an invoice', value: state.q });
  const host = h('div', { class: 'fx-panel' }, h('div', { class: 'fx-skeleton' }));
  const bulk = bulkBar(ui);
  const context = await flow('/api/invoicing/context').catch(() => ({ canIssue: false }));
  let body = null;
  const openTab = (id) => { state.status = id; state.ticked.clear(); sessionStorage.setItem('flow_invoice_tab', id); load(); };
  const alerts = alertStrip(ui, 'invoices', { onTab: openTab });
  // The tabs and search stay at the top while the rows scroll up under them;
  // the bulk bar floats at the foot (ClickUp's layout). Sending is a bulk
  // action: tick rows (the head tick takes every row shown), then Send.
  const head = h('div', { class: 'fx-listhead' }, h('div', { class: 'fx-toolbar' }, tabs, search));
  const edge = h('div', { class: 'fx-listhead__edge', 'aria-hidden': 'true' });
  main.append(
    pageHeader('Invoices', {
      actions: [h('a', { class: 'fx-btn fx-btn--primary', href: '/invoices/new', onclick: go }, 'New invoice')],
    }),
    alerts.element,
    edge,
    head,
    host,
    bulk.element);
  // A shadow under the head shows once rows scroll under it.
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver(([entry]) => head.toggleAttribute('data-stuck', !entry.isIntersecting), { rootMargin: `-${head.offsetTop > 0 && window.matchMedia?.('(max-width: 820px)').matches ? 61 : 1}px 0px 0px 0px` }).observe(edge);
  }

  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = search.value.trim(); load(); }, 200);
  });

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // The bulk bar for the ticked rows: what a person can do with this view.
  function drawBar() {
    const ticked = [...state.ticked];
    bulk.draw({ count: ticked.length, onClear: () => setTicks([]), ...bulkActions(ticked) });
  }

  // Ticks changed from the bar: the rows draw again with the new ticks.
  function setTicks(ids) {
    state.ticked = new Set(ids);
    if (body) draw(body);
  }

  // A bulk step on the server: on success the ticks clear and the list loads
  // again; on a failure the ticks stay, so a person can try again.
  async function post(path, payload, done) {
    try {
      const res = await flow(`/api/invoicing/invoices/${path}`, { method: 'POST', body: JSON.stringify(payload) });
      toast(...done(res));
      state.ticked.clear();
      seen.clear();
      await load();
      alerts.refresh();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  // What the ticked rows can do on this tab. The bar shows the main ones;
  // More shows them all, with Selection steps under them.
  function bulkActions(ticked) {
    const to = body.sendsTo;
    const rows = body.invoices.filter((i) => state.ticked.has(i.id));
    const numbered = NUMBERED.includes(state.status);
    const status = [];
    const apply = [];
    if (state.status === 'ready' && context.canIssue) {
      status.push({
        icon: to ? 'send' : 'circle-check-big', label: to ? `Send to ${to}` : 'Approve', primary: true,
        title: to ? `Send to ${to}` : 'Approve',
        run: async () => {
          const ok = await ui.dialog({
            title: to ? `Send ${plural(ticked.length, 'invoice', 'invoices')} to ${to}?` : `Approve ${plural(ticked.length, 'invoice', 'invoices')}?`,
            body: h('p', {}, to ? sendModeNote(to, body.sendMode, 'each one') : 'Each one gets the next number and is locked.'),
            confirm: to ? `Send ${ticked.length}` : `Approve ${ticked.length}`,
          });
          if (!ok) return;
          await post('send-ready', { issueDate: localDate(), invoiceIds: ticked },
            (res) => [`${to ? `${res.issued} on the way to ${to}.` : `${res.issued} approved.`}${res.remaining ? ` ${res.remaining} more stay in Ready: tick them and press again.` : ''}`, 'success']);
        },
      });
    }
    const failed = rows.filter((i) => i.status === 'issued').map((i) => i.id);
    if (state.status === 'pending' && context.canIssue && to && failed.length) {
      status.push({
        icon: 'refresh-cw', label: 'Retry', primary: true, title: `Send again to ${to}`,
        run: () => post('send-again', { invoiceIds: failed }, (res) => [`${res.queued} on the way to ${to} again.`, 'success']),
      });
    }
    apply.push({
      icon: 'copy', label: 'Copy', iconOnly: true, title: numbered ? 'Copy numbers' : 'Copy references',
      run: () => copyLines(rows.map((i) => (numbered ? i.number : i.reference) ?? i.contactName ?? '')),
    });
    apply.push({ icon: 'download', label: 'Export', iconOnly: true, title: 'Export CSV', run: () => exportCsv(rows) });
    if (numbered) apply.push({ icon: 'file-down', label: 'PDFs', iconOnly: true, title: 'Download PDFs', run: () => downloadPdfs(rows) });
    const danger = [];
    const voidable = rows.filter((i) => i.status === 'issued');
    if (['draft', 'approved', 'sent'].includes(state.status) && context.canIssue && voidable.length) {
      danger.push({
        icon: 'ban', label: 'Void', iconOnly: true, tone: 'danger', title: 'Void',
        run: () => voidAll(voidable),
      });
    }
    const all = body.invoices.map((i) => i.id);
    const selection = [
      { icon: 'list-checks', label: 'Tick all shown', run: () => setTicks(all) },
      { icon: 'square-check', label: 'Invert ticks', run: () => setTicks(all.filter((id) => !state.ticked.has(id))) },
      { icon: 'square-x', label: 'Clear ticks', run: () => setTicks([]) },
    ];
    return {
      groups: [status, apply, danger],
      more: [
        { head: 'Change status', actions: [...status, ...danger] },
        { head: 'Apply an action', actions: apply },
        { head: 'Selection', actions: selection },
      ],
    };
  }

  async function copyLines(lines) {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast(`${plural(lines.length, 'line', 'lines')} copied.`, 'success');
    } catch {
      toast('The browser did not allow a copy.', 'danger');
    }
  }

  // The ticked rows as a CSV file, with the columns on the screen.
  function exportCsv(rows) {
    const cell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    const lines = [['Number', 'Client', 'Reference', 'Date', 'Total', 'Status']]
      .concat(rows.map((i) => [i.number ?? '', i.contactName ?? '', i.reference ?? '', i.issueDate ?? i.createdAt?.slice(0, 10) ?? '',
        ((i.totalCents ?? 0) / 100).toFixed(2), TAB_LABEL[i.tab] ?? '']));
    save(new Blob([lines.map((l) => l.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }), `invoices-${state.status}-${localDate()}.csv`);
    toast(`${plural(rows.length, 'invoice', 'invoices')} exported.`, 'success');
  }

  async function downloadPdfs(rows) {
    const token = await window.Clerk?.session?.getToken();
    let saved = 0;
    for (const invoice of rows) {
      try {
        const res = await fetch(`/api/invoicing/invoices/${invoice.id}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        save(await res.blob(), `${invoice.number ?? invoice.id}.pdf`);
        saved += 1;
      } catch {
        // The toast below counts the ones that did not save.
      }
    }
    toast(saved === rows.length ? `${plural(saved, 'PDF', 'PDFs')} saved.` : `${saved} of ${rows.length} PDFs saved.`, saved === rows.length ? 'success' : 'danger');
  }

  // Void, one invoice after the other, as on one invoice's page.
  async function voidAll(rows) {
    const ok = await ui.dialog({
      title: `Void ${plural(rows.length, 'invoice', 'invoices')}?`,
      body: h('div', {}, h('p', {}, 'Their numbers stay used. A void invoice cannot be used again.'),
        body.sendsTo ? h('p', { class: 'fx-problem' }, `Flow does not change ${body.sendsTo}: void them in ${body.sendsTo} too.`) : null),
      confirm: `Void ${rows.length}`, tone: 'danger',
    });
    if (!ok) return;
    let done = 0;
    let error = null;
    for (const invoice of rows) {
      try {
        await flow(`/api/invoicing/invoices/${invoice.id}/void`, { method: 'POST', body: '{}' });
        done += 1;
      } catch (e) { error = e; }
    }
    toast(error ? `${done} of ${rows.length} void. ${error.message}` : `${plural(done, 'invoice', 'invoices')} void.`, error ? 'danger' : 'success');
    state.ticked.clear();
    seen.clear();
    await load();
    alerts.refresh();
  }

  // A tab switch shows at once: the tab is selected, the last list seen for
  // it (if any) is drawn and dimmed, and the fresh list replaces it. Only the
  // newest request draws, so quick clicks never show an older tab's list.
  const seen = new Map();
  let asked = 0;
  async function load() {
    const query = new URLSearchParams({ status: state.status, ...(state.q ? { q: state.q } : {}) });
    const key = String(query);
    const mine = ++asked;
    if (seen.has(key)) {
      delete host.dataset.stale;
      draw(seen.get(key));
    } else if (body) {
      drawTabs(body.counts);
      host.dataset.stale = '';
    }
    host.setAttribute('aria-busy', 'true');
    let answer;
    try {
      answer = await flow(`/api/invoicing/invoices?${query}`);
    } catch (error) {
      if (mine !== asked) return;
      host.removeAttribute('aria-busy');
      delete host.dataset.stale;
      host.replaceChildren(notice(error.message, 'danger'));
      return;
    }
    if (mine !== asked) return;
    seen.set(key, answer);
    host.removeAttribute('aria-busy');
    delete host.dataset.stale;
    draw(answer);
  }

  function drawTabs(counts) {
    tabs.replaceChildren(...TABS.map(([id, label]) => h('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(state.status === id),
      ...(id === 'pending' && counts?.pending ? { 'data-tone': 'danger' } : {}),
      onclick: () => { if (state.status !== id) openTab(id); },
    }, label, h('span', { class: 'fx-tabs__count' }, String(counts?.[id] ?? 0)))));
  }

  async function draw(answer) {
    body = answer;
    const shown = new Set(body.invoices.map((i) => i.id));
    for (const id of state.ticked) if (!shown.has(id)) state.ticked.delete(id);
    drawTabs(body.counts);
    drawBar();
    if (!body.invoices.length) {
      host.replaceChildren(h('p', { class: 'fx-empty' }, state.q
        ? 'No invoice matches that search.'
        : EMPTY[state.status] ?? `No ${TAB_LABEL[state.status].toLowerCase()} invoices.`));
      return;
    }
    // The invoice page steps through this list, in this order (navBar).
    saveNav({ tab: state.status, q: state.q, ids: body.invoices.map((i) => i.id) });
    const open = (href) => { saveNav({ ...readNav(), scrollY: window.scrollY }); go(href); };
    const link = (href, label) => h('a', { class: 'fx-strong', href, onclick: (event) => { event.preventDefault(); event.stopPropagation(); open(href); } }, label);
    const showProblem = state.status === 'pending';
    const created = ['pending', 'ready'].includes(state.status);
    // An invoice gets its number when it is sent or issued, so only the
    // Numbered tabs show a Number column; the others open on Client.
    const numbered = !created;
    // With an integration on, every tab has a Linked column (linkIcon).
    const systems = body.linksTo ?? [];
    const linked = systems.length > 0;
    const accountingSystem = systems.find((s) => s.kind === 'accounting') ?? null;
    const boxes = [];
    const tickBox = (invoice) => {
      const box = h('input', {
        type: 'checkbox', class: 'fx-tick', 'aria-label': `Tick ${invoice.number ?? 'draft'} for ${invoice.contactName ?? 'no client'}`,
        ...(state.ticked.has(invoice.id) ? { checked: true } : {}),
        onclick: (event) => event.stopPropagation(),
        onchange: () => { if (box.checked) state.ticked.add(invoice.id); else state.ticked.delete(invoice.id); all.checked = state.ticked.size === body.invoices.length; drawBar(); },
      });
      boxes.push(box);
      return box;
    };
    const all = h('input', {
      type: 'checkbox', class: 'fx-tick', 'aria-label': 'Tick every invoice shown',
      ...(state.ticked.size && body.invoices.every((i) => state.ticked.has(i.id)) ? { checked: true } : {}),
      onchange: () => {
        for (const invoice of body.invoices) { if (all.checked) state.ticked.add(invoice.id); else state.ticked.delete(invoice.id); }
        for (const box of boxes) box.checked = all.checked;
        drawBar();
      },
    });
    const statusCells = new Map();
    host.replaceChildren(h('table', { class: 'fx-table fx-table--rows' },
      h('thead', {}, h('tr', {},
        h('th', { class: 'fx-tick-cell' }, all),
        numbered ? h('th', {}, 'Number') : null, h('th', {}, 'Client'), h('th', {}, showProblem ? 'Problem' : 'Reference'),
        h('th', {}, created ? 'Created' : 'Date'), h('th', { class: 'fx-num' }, 'Total'), h('th', {}, 'Status'),
        linked ? h('th', {}, 'Linked') : null)),
      h('tbody', {}, body.invoices.map((invoice) => {
        const href = `/invoices/${invoice.id}`;
        const first = invoice.problems?.[0];
        return h('tr', { tabindex: '0', onclick: () => open(href), onkeydown: (event) => { if (event.key === 'Enter') open(href); } },
          h('td', { class: 'fx-tick-cell', onclick: (event) => event.stopPropagation() }, tickBox(invoice)),
          numbered ? h('td', {}, link(href, invoice.number ?? 'Draft')) : null,
          h('td', {}, numbered ? (invoice.contactName ?? '—') : link(href, invoice.contactName ?? 'No client')),
          showProblem
            ? h('td', { class: 'fx-problem', title: invoice.problems.map((p) => p.message).join(' ') }, first?.short ?? first?.message ?? '—', invoice.problems.length > 1 ? h('span', { class: 'fx-dim' }, ` +${invoice.problems.length - 1}`) : null)
            : h('td', { class: 'fx-dim' }, invoice.reference ?? '—'),
          h('td', { class: 'fx-dim' }, showDate(invoice.issueDate ?? invoice.createdAt?.slice(0, 10))),
          h('td', { class: 'fx-num fx-strong' }, formatCents(invoice.totalCents)),
          (() => {
            const cell = h('td', { class: 'fx-status-cell' }, invoice.sending
              ? h('span', { class: 'fx-status', 'data-tone': 'info' }, 'Sending')
              : h('span', { class: 'fx-status', 'data-tone': TAB_TONE[invoice.tab] ?? 'mute' }, TAB_LABEL[invoice.tab] ?? ''));
            if (!linked) statusCells.set(invoice.id, cell);
            return cell;
          })(),
          linked ? (() => {
            const cell = h('td', { class: 'fx-links' }, systems.filter((s) => s.kind === 'work').map((s) => workIcon(ui, s, invoice.job)));
            statusCells.set(invoice.id, cell);
            return cell;
          })() : null);
      }))));
    // Issued and void invoices also show Xero's status, from Flow's copy:
    // in the Linked column every one gets an icon, so one not in Xero
    // stands out.
    if (numbered) {
      const shownBody = body;
      const statuses = await xeroStatuses(ui, context.organisations?.[0]?.id, body.invoices.map((i) => i.id));
      if (shownBody !== body) return;
      for (const [invoiceId, status] of statuses) {
        if (linked) { if (accountingSystem) statusCells.get(invoiceId)?.append(accountingIcon(ui, accountingSystem, status)); }
        else if (status.state !== 'not_sent' || status.finding) statusCells.get(invoiceId)?.append(' ', xeroTag(ui, status));
      }
    }
  }
  await load();
  if (returning && back?.scrollY) window.scrollTo(0, back.scrollY);
}

// A file the browser saves, from a blob made on this page.
function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// The list an invoice was opened from: its tab, search, invoice ids in order,
// and scroll. The invoice page's bar steps through it and goes back to it.
const NAV = 'flow_invoice_nav';
const NAV_BACK = 'flow_invoice_back';
function readNav() {
  try { return JSON.parse(sessionStorage.getItem(NAV) ?? 'null'); } catch { return null; }
}
function saveNav(nav) {
  try { sessionStorage.setItem(NAV, JSON.stringify(nav)); } catch { /* the bar then shows Back only */ }
}

// The bar above one invoice: Back to the list as it was, and the previous and
// next invoice of that list. An invoice opened from elsewhere (the job board,
// search, a link) steps through its own tab, read once here.
function navBar(ui, invoice) {
  const { h, go, flow } = ui;
  const id = invoice?.id ?? null;
  const back = () => { sessionStorage.setItem(NAV_BACK, '1'); go('/invoices'); };
  const step = (to, label, path) => {
    const button = h('button', {
      class: 'fx-pager__step', type: 'button', disabled: !to, 'aria-label': label, title: label,
      onclick: () => go(`/invoices/${to}`),
    });
    button.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return button;
  };
  const bar = h('nav', { class: 'fx-pager', 'aria-label': 'Invoices' },
    h('button', { class: 'fx-pager__back', type: 'button', onclick: back }, '← Back'));
  const fill = (ids) => {
    const at = ids.indexOf(id);
    if (at < 0) return false;
    bar.replaceChildren(bar.firstChild,
      h('span', { class: 'fx-pager__count' }, `${at + 1} of ${ids.length}`),
      h('span', { class: 'fx-pager__steps' }, step(ids[at - 1], 'Previous invoice', 'M14.5 6l-6 6 6 6'), step(ids[at + 1], 'Next invoice', 'M9.5 6l6 6-6 6')));
    return true;
  };
  const tab = invoice?.tab ?? null;
  if (id && !fill(readNav()?.ids ?? []) && TABS.some(([t]) => t === tab)) {
    flow(`/api/invoicing/invoices?${new URLSearchParams({ status: tab })}`).then((body) => {
      const ids = body.invoices.map((i) => i.id);
      if (!fill(ids)) return;
      saveNav({ tab, q: '', ids });
      try { sessionStorage.setItem('flow_invoice_tab', tab); } catch { /* Back opens the last tab */ }
    }).catch(() => { /* Back only */ });
  }
  return bar;
}

// After a send, an Approve or a Save as draft, the next invoice of the list
// opens; at its end, the list. So a person reviews drafts one after another
// without going back. The invoice stays in the bar's list, so the count holds
// (2 of 35) and Previous opens it again, now done. Back reloads the list
// without it.
export function openNext(ui, id) {
  const ids = readNav()?.ids ?? [];
  const at = ids.indexOf(id);
  const next = at >= 0 ? ids[at + 1] : null;
  if (next) ui.go(`/invoices/${next}`);
  else { sessionStorage.setItem(NAV_BACK, '1'); ui.go('/invoices'); }
}

// ── One invoice ────────────────────────────────────────────────────────────

export async function renderInvoice(main, ui, id) {
  const { h, flow, notice } = ui;
  const host = h('div', { class: 'fx-invoice' }, h('div', { class: 'fx-skeleton' }));
  main.append(host);
  let context;
  let invoice = null;
  try {
    [context, invoice] = await Promise.all([
      flow('/api/invoicing/context'),
      id === 'new' ? null : flow(`/api/invoicing/invoices/${id}`).then((body) => body.invoice),
    ]);
  } catch (error) {
    host.replaceChildren(notice(error.status === 404 ? 'No invoice here. It may have been removed.' : error.message, 'danger'));
    return;
  }
  // Send to Xero shows only when Xero is on and connected (404 while it is off).
  const organisationId = context.organisations[0]?.id;
  const xero = organisationId ? await flow(`/api/xero/status?organisationId=${organisationId}`).catch(() => null) : null;
  context.xero = Boolean(xero?.connected);
  const draw = (current) => {
    host.replaceChildren(...(current?.status && current.status !== 'draft'
      ? issuedView(current, ui, context, draw)
      : draftView(current, ui, context, draw)).filter(Boolean));
  };
  draw(invoice);
}

function totalsBox(ui, { subtotalCents, taxCents, totalCents }) {
  const { h } = ui;
  return h('dl', { class: 'fx-totals' },
    h('dt', {}, 'Subtotal'), h('dd', {}, formatCents(subtotalCents)),
    h('dt', {}, 'GST'), h('dd', {}, formatCents(taxCents)),
    h('dt', { class: 'fx-totals__grand' }, 'Total'), h('dd', { class: 'fx-totals__grand' }, formatCents(totalCents)));
}

// The job's number a person reads: its case number, else its order number.
// A system's own record id (a UUID) is never shown (job-board.js).
const jobRef = (job) => caseNumber(job) ?? (job.sourceInvoiceRef ? `#${job.sourceInvoiceRef}` : null);

// The Linked card: this invoice's link in each connected system (linksTo).
// A work system row names the job's order and opens it there; the
// accounting row gives the number and state there (from Flow's copy). A
// system with no link shows a dashed row. With no system on, the card holds
// the job's facts only.
function linkedCard(ui, invoice, accountingStatus = null) {
  const { h } = ui;
  const job = invoice?.job ?? null;
  const systems = invoice?.linksTo ?? [];
  if (!job && !systems.length) return null;
  const facts = job && (job.practitioner || job.shippedOn) ? h('dl', { class: 'fx-facts' },
    job.practitioner ? [h('dt', {}, 'Practitioner'), h('dd', {}, job.practitioner)] : null,
    job.shippedOn ? [h('dt', {}, 'Shipped'), h('dd', {}, showDate(job.shippedOn))] : null) : null;
  const row = (system, { tone = null, ref = null, state = null, url = null, none = null }) => h('div', { class: 'fx-linked__row' },
    linkIcon(ui, system, { tone, title: none ?? `${system.name}${ref ? ` ${ref}` : ''}` }),
    h('span', { class: 'fx-strong' }, system.name),
    ref ? h('span', { class: 'fx-linked__ref' }, ref) : null,
    state ? h('span', { class: 'fx-status', 'data-tone': tone ?? 'mute' }, state) : null,
    none ? h('span', { class: 'fx-dim' }, none) : null,
    url ? h('a', { class: 'fx-linked__open', href: url, target: '_blank', rel: 'noopener', title: `Open in ${system.name}` }, 'Open ↗') : null);
  const rows = systems.map((system) => {
    if (system.kind === 'work') {
      return job?.sourceSystem === system.id
        ? row(system, { tone: 'success', ref: jobRef(job), url: job.link?.url ?? null })
        : row(system, { none: 'No job linked' });
    }
    const status = accountingStatus;
    if (!status || (status.state === 'not_sent' && !status.finding)) {
      return row(system, { none: invoice?.status === 'draft' ? 'Goes there when sent' : `Not in ${system.name} yet` });
    }
    const tone = status.finding ? 'danger' : LINK_TONE[status.state] ?? 'mute';
    const state = status.finding ? 'Out of sync' : status.label.replace(` in ${system.name}`, '');
    return row(system, { tone, ref: status.xero?.number ?? null, state, url: status.xero?.url ?? null });
  });
  const workRows = systems.some((s) => s.kind === 'work');
  return h('section', { class: 'fx-card fx-side-card' },
    h('h3', { class: 'fx-label' }, 'Linked'),
    !workRows && job ? h('p', { class: 'fx-dim' }, `Job from ${job.systemName ?? job.sourceSystem}`) : null,
    h('div', { class: 'fx-linked' }, rows),
    facts);
}

// A draft, or a new invoice before its first save.
function draftView(invoice, ui, context, redraw) {
  const { h, flow, toast, go, notice } = ui;
  const isNew = !invoice;
  const lines = (invoice?.lines ?? []).map((line) => ({ ...line }));
  if (!lines.length) lines.push({ description: '', quantity: 1, unitAmountCents: null, taxCode: 'GST', priceItemId: null });
  let contact = invoice?.contact ?? null;
  // Approve waits for a client and a due date (syncIssue, below).
  let onContact = () => {};

  // Client: type to find a customer.
  const clientInput = h('input', { class: 'fx-input', type: 'text', autocomplete: 'off', placeholder: 'Type a client name', value: contact?.name ?? '', 'aria-label': 'Client' });
  const clientList = h('div', { class: 'fx-suggest', role: 'listbox', hidden: true });
  let clientTimer;
  clientInput.addEventListener('input', () => {
    contact = null;
    clearTimeout(clientTimer);
    clientTimer = setTimeout(async () => {
      const q = clientInput.value.trim();
      if (!q) { clientList.hidden = true; return; }
      try {
        const { contacts } = await flow(`/api/invoicing/contacts?${new URLSearchParams({ q, limit: '8' })}`);
        clientList.replaceChildren(...(contacts.length ? contacts.map((c) => h('button', {
          type: 'button',
          role: 'option',
          onmousedown: (event) => {
            event.preventDefault();
            contact = c;
            clientInput.value = c.name;
            clientList.hidden = true;
            onContact();
          },
        }, c.name, c.email ? h('span', { class: 'fx-dim' }, c.email) : null)) : [h('p', { class: 'fx-dim fx-suggest__none' }, 'No client by that name.')]));
        clientList.hidden = false;
      } catch (error) {
        toast(error.message, 'danger');
      }
    }, 180);
  });
  clientInput.addEventListener('blur', () => { setTimeout(() => { clientList.hidden = true; }, 120); });

  const reference = h('input', { class: 'fx-input', type: 'text', value: invoice?.reference ?? '', placeholder: 'Practitioner - Patient' });
  const dueDate = h('input', { class: 'fx-input', type: 'date', value: invoice?.dueDate ?? '' });

  // Lines.
  let items = null;
  const itemsReady = flow('/api/invoicing/price-items').then((body) => { items = body.priceItems ?? body.items ?? []; return items; }).catch(() => { items = []; return items; });
  const tbody = h('tbody');
  const datalist = h('datalist', { id: 'fx-price-items' });
  const totalsHost = h('div');
  const preview = () => {
    let subtotalCents = 0;
    let taxCents = 0;
    for (const line of lines) {
      if (line.unitAmountCents == null || !(line.quantity > 0)) continue;
      const amount = line.quantity * line.unitAmountCents;
      subtotalCents += amount;
      taxCents += line.taxCode === 'GST' ? gstCents(amount) : 0;
    }
    totalsHost.replaceChildren(totalsBox(ui, { subtotalCents, taxCents, totalCents: subtotalCents + taxCents }));
  };

  const drawLines = () => {
    tbody.replaceChildren(...lines.map((line, index) => {
      const amount = h('td', { class: 'fx-num fx-strong' });
      const showAmount = () => {
        amount.textContent = line.unitAmountCents == null || !(line.quantity > 0) ? '—' : formatCents(line.quantity * line.unitAmountCents);
      };
      showAmount();
      const item = h('input', {
        class: 'fx-input', type: 'text', list: 'fx-price-items', placeholder: 'Code or name', autocomplete: 'off',
        value: line.itemCode ?? '', 'aria-label': `Item, line ${index + 1}`,
      });
      const description = h('input', { class: 'fx-input', type: 'text', value: line.description ?? '', 'aria-label': `Description, line ${index + 1}` });
      const quantity = h('input', { class: 'fx-input fx-num', type: 'number', min: '1', step: '1', value: String(line.quantity ?? 1), 'aria-label': `Quantity, line ${index + 1}` });
      const price = h('input', { class: 'fx-input fx-num', type: 'text', inputmode: 'decimal', value: fromCents(line.unitAmountCents), placeholder: '0.00', 'aria-label': `Unit price, line ${index + 1}` });
      const gst = h('select', { class: 'fx-select', 'aria-label': `GST, line ${index + 1}` },
        h('option', { value: 'GST', selected: line.taxCode !== 'GST_FREE' }, 'GST'),
        h('option', { value: 'GST_FREE', selected: line.taxCode === 'GST_FREE' }, 'GST free'));
      item.addEventListener('change', async () => {
        const list = items ?? await itemsReady;
        const typed = item.value.trim().toLowerCase();
        const match = list.find((i) => i.code.toLowerCase() === typed || `${i.code} · ${i.name}`.toLowerCase() === typed || i.name.toLowerCase() === typed);
        if (!match) { line.priceItemId = null; line.itemCode = null; return; }
        Object.assign(line, { priceItemId: match.id, itemCode: match.code, description: match.name, unitAmountCents: match.unitAmountCents, taxCode: match.taxCode });
        item.value = match.code;
        description.value = match.name;
        price.value = fromCents(match.unitAmountCents);
        gst.value = match.taxCode;
        showAmount();
        preview();
      });
      description.addEventListener('input', () => { line.description = description.value; });
      quantity.addEventListener('input', () => { line.quantity = Number.parseInt(quantity.value, 10); showAmount(); preview(); });
      price.addEventListener('input', () => { line.unitAmountCents = toCents(price.value); showAmount(); preview(); });
      gst.addEventListener('change', () => { line.taxCode = gst.value; preview(); });
      const remove = h('button', {
        class: 'fx-btn fx-btn--ghost fx-btn--sm fx-btn--icon', type: 'button', title: 'Remove line', 'aria-label': `Remove line ${index + 1}`,
        onclick: () => { lines.splice(index, 1); if (!lines.length) lines.push({ description: '', quantity: 1, unitAmountCents: null, taxCode: 'GST', priceItemId: null }); drawLines(); preview(); },
      }, '×');
      return h('tr', {},
        h('td', { class: 'fx-lines__item' }, item),
        h('td', {}, description),
        h('td', { class: 'fx-lines__qty' }, quantity),
        h('td', { class: 'fx-lines__price' }, price),
        h('td', { class: 'fx-lines__gst' }, gst),
        amount,
        h('td', {}, remove));
    }));
  };
  drawLines();
  preview();
  itemsReady.then((list) => {
    // A saved line knows its price item by id; show the item's code.
    const codes = new Map(list.map((i) => [i.id, i.code]));
    let named = false;
    for (const line of lines) {
      if (line.priceItemId && !line.itemCode && codes.has(line.priceItemId)) { line.itemCode = codes.get(line.priceItemId); named = true; }
    }
    if (named) drawLines();
    datalist.replaceChildren(...list.map((i) => h('option', { value: i.code }, `${i.name} · ${formatCents(i.unitAmountCents)}`)));
  });

  const body = () => ({
    contactId: contact?.id,
    reference: reference.value.trim() || null,
    dueDate: dueDate.value || null,
    lines: lines
      .filter((line) => line.description?.trim() || line.priceItemId || line.unitAmountCents != null)
      .map(({ priceItemId, description, quantity, unitAmountCents, taxCode }) => ({
        ...(priceItemId ? { priceItemId } : {}),
        description: description?.trim() || undefined,
        quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
        ...(unitAmountCents == null ? {} : { unitAmountCents }),
        taxCode,
      })),
  });

  const check = () => {
    if (!contact) return 'Choose a client from the list.';
    if (lines.some((line) => (line.description?.trim() || line.priceItemId) && line.unitAmountCents == null)) return 'Each line needs a price.';
    return null;
  };

  const save = async () => {
    const problem = check();
    if (problem) { toast(problem, 'danger'); return null; }
    try {
      const res = isNew
        ? await flow('/api/invoicing/invoices', { method: 'POST', body: JSON.stringify(body()) })
        : await flow(`/api/invoicing/invoices/${invoice.id}`, { method: 'PATCH', body: JSON.stringify(body()) });
      return res.invoice;
    } catch (error) {
      toast(error.message, 'danger');
      return null;
    }
  };

  // Save shows only when there is something to save: a new invoice, or a
  // change since the page opened. Save as draft opens the next invoice.
  // Save as draft: a draft that is not ready always offers it. A ready
  // invoice offers Save changes only once something changed.
  const keepsSave = isNew || invoice?.view !== 'ready';
  const saveButton = h('button', {
    class: 'fx-btn', type: 'button', hidden: !keepsSave,
    onclick: async () => {
      const saved = await save();
      if (!saved) return;
      toast(keepsSave ? 'Saved as a draft.' : 'Changes saved.', 'success');
      if (isNew) go(`/invoices/${saved.id}`, { replace: true });
      else if (keepsSave) openNext(ui, invoice.id);
      else redraw(saved);
    },
  }, keepsSave ? 'Save as draft' : 'Save changes');
  const opened = JSON.stringify(body());
  const changed = () => !isNew && JSON.stringify(body()) !== opened;
  const watchChanges = () => { if (!keepsSave) saveButton.hidden = !changed(); };
  // With an accounting system on, a ready invoice is sent there: Flow issues
  // it and queues it, the same as Send all ready. With none, Flow issues it
  // and keeps it. A Pending draft has no send: fix its problem first.
  const to = invoice?.sendsTo ?? context.sendsTo ?? null;
  const ready = invoice?.view === 'ready';
  const nextNumber = `${context.organisations[0]?.invoicePrefix ?? ''}${String(context.organisations[0]?.nextInvoiceNumber ?? '').padStart(4, '0')}`;
  const emails = invoice?.sendMode?.mode === 'approve_and_email';
  const sendButton = context.canIssue && to && ready ? h('button', {
    class: 'fx-btn fx-btn--primary', type: 'button',
    onclick: async () => {
      if (changed() && !(await save())) return;
      const ok = await ui.dialog({
        title: `Send this invoice to ${to}?`,
        body: h('p', {}, `It gets the next number (${nextNumber}). ${sendModeNote(to, invoice.sendMode, 'it')}`),
        confirm: emails ? 'Send and email' : 'Send',
      });
      if (!ok) return;
      try {
        await flow('/api/invoicing/invoices/send-ready', { method: 'POST', body: JSON.stringify({ issueDate: localDate(), invoiceIds: [invoice.id] }) });
        const { invoice: fresh } = await flow(`/api/invoicing/invoices/${invoice.id}`);
        toast(`${fresh.number} is on the way to ${to}.`, 'success');
        openNext(ui, invoice.id);
      } catch (error) {
        toast(error.message, 'danger');
      }
    },
  }, emails ? `Send to ${to} and email` : `Send to ${to}`) : null;
  // With no accounting system, Approve gives the draft its number and locks
  // it. A changed job blocks it.
  const issueButton = context.canIssue && !to ? h('button', {
    class: 'fx-btn fx-btn--primary', type: 'button',
    onclick: async () => {
      const saved = await save();
      if (!saved) return;
      const ok = await ui.dialog({
        title: 'Approve this invoice?',
        body: h('p', {}, `It gets the next number (${nextNumber}). Flow keeps it exactly as issued. To change it later, revise it.`),
        confirm: 'Approve',
      });
      if (!ok) { if (isNew) go(`/invoices/${saved.id}`, { replace: true }); else redraw(saved); return; }
      try {
        const { invoice: issued } = await flow(`/api/invoicing/invoices/${saved.id}/issue`, { method: 'POST', body: JSON.stringify({ issueDate: localDate() }) });
        toast(`${issued.number} approved.`, 'success');
        if (isNew) go(`/invoices/${issued.id}`, { replace: true });
        else openNext(ui, invoice.id);
      } catch (error) {
        toast(error.message, 'danger');
      }
    },
  }, 'Approve') : null;
  // Issue needs a client and a due date: until both are set it is greyed.
  // A changed job greys it too.
  const syncIssue = () => {
    if (!issueButton) return;
    const missing = [contact ? null : 'a client', dueDate.value ? null : 'a due date'].filter(Boolean);
    issueButton.disabled = missing.length > 0 || Boolean(invoice?.jobChange);
    issueButton.title = invoice?.jobChange ? 'Fix the problem first.' : missing.length ? `Choose ${missing.join(' and ')} first.` : 'Gives it the next number and locks it. Nothing is sent.';
  };
  onContact = syncIssue;
  clientInput.addEventListener('input', syncIssue);
  dueDate.addEventListener('input', syncIssue);
  dueDate.addEventListener('change', syncIssue);
  syncIssue();

  // A new invoice can start from a job that has no invoice yet: a quiet
  // strip above the form says so. Flow drafts it the way the invoicing rules
  // do (client, Reference, lines) and links it to the job. An invoice with
  // no job is fine too.
  const fromJob = isNew && context.canIssue ? h('section', { class: 'fx-fromjob' },
    h('div', { class: 'fx-fromjob__text' },
      h('span', { class: 'fx-strong' }, 'Billing a job?'),
      h('span', { class: 'fx-dim' }, 'Flow fills in the details.')),
    h('button', { class: 'fx-btn', type: 'button', onclick: () => pickJob(ui) }, 'Choose a job')) : null;

  // A draft with no problem is in Ready by itself; one with a problem is
  // Pending. A changed job is fixed at its source or accepted here.
  const jobChange = invoice?.jobChange ?? null;
  // The job changed after the invoice was made: its own banner shows what
  // changed. Other problems stay one line.
  const otherProblems = (invoice?.problems ?? []).filter((p) => !(jobChange && p.code === 'job_review'));
  const problems = [
    jobChange ? jobChangeBanner(ui, jobChange, {
      money: formatCents,
      // Accepting changes the draft for the business: owners and admins only.
      onAccept: !context.canIssue ? null : async () => {
        const system = jobChange.systemName;
        const lost = [jobChange.outcome === 'conflict' ? 'Your own line changes here are replaced.' : null, changed() ? 'Unsaved changes are lost.' : null].filter(Boolean);
        if (lost.length) {
          const ok = await ui.dialog({ title: 'Accept change?', body: h('p', {}, lost.join(' ')), confirm: 'Accept change' });
          if (!ok) return;
        }
        try {
          const res = await flow(`/api/invoicing/jobs/${jobChange.jobId}/use-new-lines`, { method: 'POST', body: JSON.stringify({ accept: true }) });
          toast(`Matches ${system}.${res.invoice.view === 'ready' ? ' In Ready.' : ''}`, 'success');
          redraw(res.invoice);
        } catch (error) {
          toast(error.message, 'danger');
        }
      },
      // Reads this one job from the work system again, then every check runs.
      onRecheck: async () => {
        try {
          const res = await flow(`/api/invoicing/jobs/${jobChange.jobId}/recheck`, { method: 'POST', body: '{}' });
          toast(res.invoice?.jobChange ? `Still changed in ${jobChange.systemName}.` : 'Fixed. It matches now.', res.invoice?.jobChange ? 'danger' : 'success');
          if (res.invoice) redraw(res.invoice);
        } catch (error) {
          toast(error.message, 'danger');
        }
      },
    }) : null,
    otherProblems.length ? notice(otherProblems.map((p) => p.message).join(' '), 'danger', 'Problem.') : null,
  ];

  return [
    navBar(ui, invoice),
    h('header', { class: 'fx-ph' },
      h('div', { class: 'fx-ph__text' },
        h('h1', { class: 'fx-title' }, isNew ? 'New invoice' : ready ? 'Ready invoice' : 'Pending invoice'),
        h('p', { class: 'fx-ph__sub' }, draftNote(to, invoice, ready))),
      h('div', { class: 'fx-ph__actions' }, isNew ? null : previewButton(ui, invoice.id, 'Shows the saved invoice.'), saveButton, sendButton ?? issueButton)),
    ...problems,
    fromJob,
    h('div', { class: 'fx-invoice__grid' },
      h('div', { class: 'fx-invoice__main' },
        h('section', { class: 'fx-card fx-invoice__head' },
          h('label', { class: 'fx-field fx-field--client' }, h('span', { class: 'fx-label' }, 'Client'), h('div', { class: 'fx-suggest-host' }, clientInput, clientList)),
          h('label', { class: 'fx-field' }, h('span', { class: 'fx-label' }, 'Reference'), reference),
          h('label', { class: 'fx-field' }, h('span', { class: 'fx-label' }, 'Due date'), dueDate)),
        h('section', { class: 'fx-card fx-lines' },
          datalist,
          h('table', { class: 'fx-lines__table' },
            h('thead', {}, h('tr', {},
              h('th', {}, 'Item'), h('th', {}, 'Description'), h('th', { class: 'fx-num' }, 'Qty'),
              h('th', { class: 'fx-num' }, 'Unit price'), h('th', {}, 'Tax'), h('th', { class: 'fx-num' }, 'Amount'),
              h('th', {}, h('span', { class: 'fx-sr' }, 'Remove')))),
            tbody),
          h('div', { class: 'fx-lines__foot' },
            h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', onclick: () => { lines.push({ description: '', quantity: 1, unitAmountCents: null, taxCode: 'GST', priceItemId: null }); drawLines(); } }, '+ Add line'),
            totalsHost))),
      h('aside', { class: 'fx-invoice__aside' }, linkedCard(ui, invoice))),
  ].map((part) => {
    // Any edit on the page shows Save changes; undoing it hides it again.
    for (const kind of ['input', 'change', 'click']) part?.addEventListener?.(kind, () => setTimeout(watchChanges));
    return part;
  });
}

// Preview: the invoice as a PDF in a new tab (GET /api/invoicing/invoices/:id/pdf).
// The tab opens at once, because a browser blocks a tab opened after a wait,
// and shows the PDF when it is ready. If Flow cannot make it, the tab closes
// and a toast says why.
function previewButton(ui, invoiceId, title = 'Shows the invoice as a PDF.') {
  const { h, toast } = ui;
  return h('button', {
    class: 'fx-btn', type: 'button', title,
    onclick: async () => {
      const tab = window.open('', '_blank');
      if (tab) {
        tab.document.title = 'Preparing PDF';
        tab.document.body.textContent = 'Preparing PDF…';
      }
      try {
        const token = await window.Clerk.session?.getToken();
        const res = await fetch(`/api/invoicing/invoices/${invoiceId}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const url = URL.createObjectURL(await res.blob());
        if (tab) tab.location.href = url;
        else window.location.assign(url);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (error) {
        tab?.close();
        toast(`The PDF could not be made. ${error.message}`, 'danger');
      }
    },
  }, 'Preview');
}

// An issued or void invoice: the document as sent, and what can happen next.
function issuedView(invoice, ui, context, redraw) {
  const { h, flow, toast } = ui;
  const act = async (path, done, confirmText) => {
    if (confirmText) {
      const ok = await ui.dialog(confirmText);
      if (!ok) return;
    }
    try {
      const res = await flow(`/api/invoicing/invoices/${invoice.id}/${path}`, { method: 'POST', body: '{}' });
      toast(done, 'success');
      redraw(res.invoice);
    } catch (error) {
      toast(error.message, 'danger');
    }
  };
  const organisationId = context.organisations?.[0]?.id;
  const xeroHost = h('div');
  const linkedHost = h('div', {}, linkedCard(ui, invoice) ?? '');
  let xeroStatus = null;
  const send = invoice.status === 'issued' && context.canIssue ? sendToXero(invoice, ui, context) : null;
  const loadXero = async () => {
    if (!context.xero) return;
    xeroStatus = (await xeroStatuses(ui, organisationId, [invoice.id])).get(invoice.id) ?? null;
    xeroHost.replaceChildren(xeroCard(invoice, ui, context, xeroStatus, loadXero) ?? '');
    linkedHost.replaceChildren(linkedCard(ui, invoice, xeroStatus) ?? '');
    if (xeroStatus && xeroStatus.state !== 'not_sent') showSent(send);
  };
  loadXero();
  // Voiding in Flow never changes Xero: say so while Xero still holds it live.
  const voidBody = () => {
    const live = xeroStatus?.xero && !['VOIDED', 'DELETED'].includes(xeroStatus.xero.status);
    return h('div', {},
      h('p', {}, 'The number stays used. A void invoice cannot be used again.'),
      live ? h('p', { class: 'fx-problem' }, `Xero still holds it as ${xeroStatus.label.replace(/ in Xero$/, '').toLowerCase()}${xeroStatus.xero.number ? ` (${xeroStatus.xero.number})` : ''}. Flow does not change Xero: void it in Xero too.`) : null);
  };
  const actions = invoice.status === 'issued' && context.canIssue ? [
    h('button', {
      class: 'fx-btn fx-btn--ghost fx-btn--danger', type: 'button',
      onclick: () => act('void', `${invoice.number} is void.`, { title: `Void ${invoice.number}?`, body: voidBody(), confirm: 'Void', tone: 'danger' }),
    }, 'Void'),
    h('button', { class: 'fx-btn', type: 'button', onclick: () => act('revise', `${invoice.number} is a draft again.`) }, 'Revise'),
  ] : [];
  return [
    navBar(ui, invoice),
    h('header', { class: 'fx-ph' },
      h('div', { class: 'fx-ph__text' },
        h('div', { class: 'fx-row' },
          h('h1', { class: 'fx-title' }, invoice.number),
          h('span', { class: 'fx-status', 'data-tone': TAB_TONE[invoice.tab] }, TAB_LABEL[invoice.tab] ?? 'Approved')),
        h('p', { class: 'fx-ph__sub' }, `${invoice.contact?.name ?? ''} · ${showDate(invoice.issueDate)}`)),
      h('div', { class: 'fx-ph__actions' }, actions, previewButton(ui, invoice.id), send)),
    h('div', { class: 'fx-invoice__grid' },
      h('div', { class: 'fx-invoice__main' },
        h('section', { class: 'fx-card fx-doc' },
          h('dl', { class: 'fx-doc__meta' },
            h('div', {}, h('dt', { class: 'fx-label' }, 'Bill to'), h('dd', {}, invoice.contact?.name ?? '—', invoice.contact?.email ? h('span', { class: 'fx-dim' }, invoice.contact.email) : null)),
            h('div', {}, h('dt', { class: 'fx-label' }, 'Reference'), h('dd', {}, invoice.reference ?? '—')),
            h('div', {}, h('dt', { class: 'fx-label' }, 'Date'), h('dd', {}, showDate(invoice.issueDate))),
            h('div', {}, h('dt', { class: 'fx-label' }, 'Due'), h('dd', {}, showDate(invoice.dueDate)))),
          h('table', { class: 'fx-lines__table fx-lines__table--read' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Description'), h('th', { class: 'fx-num' }, 'Qty'), h('th', { class: 'fx-num' }, 'Unit price'), h('th', {}, 'Tax'), h('th', { class: 'fx-num' }, 'Amount'))),
            h('tbody', {}, invoice.lines.map((line) => h('tr', {},
              h('td', {}, line.description),
              h('td', { class: 'fx-num' }, String(line.quantity)),
              h('td', { class: 'fx-num' }, formatCents(line.unitAmountCents)),
              h('td', { class: 'fx-dim' }, line.taxCode === 'GST' ? 'GST' : 'GST free'),
              h('td', { class: 'fx-num fx-strong' }, formatCents(line.lineAmountCents)))))),
          h('div', { class: 'fx-lines__foot' }, h('span'), totalsBox(ui, invoice)))),
      h('aside', { class: 'fx-invoice__aside' },
        linkedHost,
        xeroHost,
        invoice.versions?.length ? h('section', { class: 'fx-card fx-side-card' },
          h('h3', { class: 'fx-label' }, 'History'),
          h('ol', { class: 'fx-timeline' }, invoice.versions.map((v) => h('li', {},
            h('span', { class: 'fx-strong' }, v.version === 1 ? 'Version 1' : `Revised (version ${v.version})`),
            h('span', { class: 'fx-dim' }, new Date(v.issuedAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })))))) : null)),
  ];
}

// Xero's copy of this invoice: its status, any difference from what Flow
// sent, and Mark resolved, which reads Xero's changes and checks again. It
// never writes to Xero: a person fixes the difference where they choose.
function xeroCard(invoice, ui, context, status, reload) {
  const { h, flow, toast } = ui;
  // The Linked card shows Xero's number and state; this card shows only a
  // difference to resolve.
  if (!status?.finding) return null;
  const rows = status.differences.map((d) => h('tr', {},
    h('td', {}, FIELD_LABEL[d.field] ?? d.field),
    h('td', { class: 'fx-num' }, showField(d.field, d.flow)),
    h('td', { class: 'fx-num' }, showField(d.field, d.xero))));
  const resolve = status.finding && context.canIssue ? h('button', {
    class: 'fx-btn fx-btn--sm', type: 'button',
    onclick: async () => {
      resolve.disabled = true;
      try {
        const res = await flow(`/api/xero/invoices/${invoice.id}/recheck`, { method: 'POST', body: JSON.stringify({ organisationId: context.organisations[0].id }) });
        toast(res.resolved ? 'Flow and Xero agree now.' : 'Still different. Fix it in Xero or in Flow, then try again.', res.resolved ? 'success' : 'danger');
        await reload();
      } catch (error) {
        toast(error.message, error.status === 429 ? 'info' : 'danger');
        resolve.disabled = false;
        ui.holdButton(resolve, error.retryAfterMs);
      }
    },
  }, 'Mark resolved') : null;
  return h('section', { class: 'fx-card fx-side-card' },
    h('h3', { class: 'fx-label' }, 'Xero'),
    h('div', { class: 'fx-row' }, xeroTag(ui, status), status.xero?.number ? h('span', { class: 'fx-dim' }, status.xero.number) : null),
    status.finding ? h('p', { class: 'fx-problem' }, status.message) : null,
    rows.length ? h('table', { class: 'fx-table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'fx-num' }, 'Flow sent'), h('th', { class: 'fx-num' }, 'Xero now'))),
      h('tbody', {}, rows)) : null,
    h('div', { class: 'fx-row' },
      status.xero?.url ? h('a', { class: 'fx-btn fx-btn--sm fx-btn--ghost', href: status.xero.url, target: '_blank', rel: 'noopener' }, 'Open in Xero') : null,
      resolve));
}

// Send to Xero (POST /api/xero/invoices/push). The customer's send mode
// (Settings, Invoice rules) decides what Xero gets: a draft that a person approves
// there, or an approved invoice that Xero emails to the customer.
function sendToXero(invoice, ui, context) {
  const { h, flow, toast } = ui;
  const organisationId = context.organisations[0]?.id;
  if (!organisationId || !context.xero) return null;
  const button = h('button', {
    class: 'fx-btn fx-btn--primary', type: 'button',
    onclick: async () => {
      button.disabled = true;
      let sent = false;
      try {
        const res = await flow('/api/xero/invoices/push', { method: 'POST', body: JSON.stringify({ organisationId, invoiceIds: [invoice.id] }) });
        const result = res.invoices?.[0];
        const email = result?.email;
        if (email && ['failed', 'unknown'].includes(email.state)) toast(email.error, 'danger');
        else if (email?.state === 'sent') toast(`${invoice.number} is approved in Xero, and Xero emailed it to the customer.`, 'success');
        else if (['created', 'reconciled', 'existing'].includes(result?.outcome)) toast(`${invoice.number} is in Xero as a draft.`, 'success');
        else if (result?.outcome === 'already_in_xero') toast(`Xero already has ${invoice.number}.`, 'info');
        else toast(result?.error?.message ?? 'Xero did not take it.', 'danger');
        sent = ['created', 'reconciled', 'existing', 'already_in_xero'].includes(result?.outcome);
      } catch (error) {
        toast(error.message, 'danger');
        if (error.retryAfterMs) ui.holdButton(button, error.retryAfterMs);
      } finally {
        if (sent) showSent(button);
        else if (!button.dataset.label) button.disabled = false;
      }
    },
  }, 'Send to Xero');
  // Sent or on its way (Send, or Send all ready): it cannot be sent twice.
  if (['queued', 'sent'].includes(invoice.sendState)) {
    showSent(button);
    return button;
  }
  // The preview reads only Flow's copy of Xero: it costs no Xero calls.
  flow('/api/xero/invoices/preview', { method: 'POST', body: JSON.stringify({ organisationId, invoiceIds: [invoice.id] }) })
    .then((res) => {
      if (res.invoices?.[0]?.sendMode === 'approve_and_email' && !button.disabled) button.textContent = 'Send to Xero and email';
    })
    .catch(() => {});
  return button;
}

// A sent invoice's Send button stays, greyed, and says it went.
function showSent(button) {
  if (!button) return;
  button.disabled = true;
  button.textContent = 'Sent to Xero';
  button.title = 'Flow sent this invoice to Xero.';
}

// The jobs a new invoice can start from: no invoice yet, newest first.
const PICKABLE = new Set(['in_work', 'ready', 'pending']);

async function pickJob(ui) {
  const { h, flow, toast, go } = ui;
  let jobs;
  try {
    jobs = (await flow('/api/invoicing/jobs?limit=500')).jobs.filter((job) => PICKABLE.has(job.view) && !job.invoiceId);
  } catch (error) {
    toast(error.message, 'danger');
    return;
  }
  const search = h('input', { class: 'fx-input', type: 'search', placeholder: 'Find a client or practitioner', 'aria-label': 'Find a job' });
  const rows = jobs.map((job) => {
    const label = h('label', { class: 'fx-pick__row' },
      h('input', { type: 'radio', name: 'job', value: job.id, required: true }),
      h('span', { class: 'fx-pick__main' },
        h('span', { class: 'fx-strong' }, job.contactName ?? 'No client yet'),
        h('span', { class: 'fx-dim' }, [job.practitioner, job.shippedOn ? showDate(job.shippedOn) : null].filter(Boolean).join(' · '))),
      h('span', { class: 'fx-num fx-strong' }, job.totalCents == null ? '—' : formatCents(job.totalCents)));
    label.dataset.find = `${job.contactName ?? ''} ${job.practitioner ?? ''}`.toLowerCase();
    return label;
  });
  const list = h('div', { class: 'fx-pick', role: 'radiogroup', 'aria-label': 'Jobs' },
    rows.length ? rows : h('p', { class: 'fx-dim' }, 'Every job has an invoice already.'));
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const row of rows) row.hidden = Boolean(q) && !row.dataset.find.includes(q);
  });
  const picked = await ui.dialog({
    title: 'New invoice from a job',
    body: h('div', { class: 'fx-pick__body' },
      h('p', { class: 'fx-dim' }, 'Flow fills in the client, Reference and lines from the invoice rules, and links the invoice to the job.'),
      search, list),
    confirm: 'Make draft',
  });
  const jobId = picked?.get('job');
  if (!jobId) return;
  try {
    const { invoice } = await flow(`/api/invoicing/jobs/${jobId}/draft`, { method: 'POST', body: '{}' });
    toast('Draft invoice made from the job.', 'success');
    go(`/invoices/${invoice.id}`, { replace: true });
  } catch (error) {
    const reasons = error.details?.reasons;
    toast(reasons?.length ? `Not drafted: ${reasons.join('; ')}.` : error.message, 'danger');
  }
}
