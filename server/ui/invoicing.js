// Invoices: the list (/invoices) and one invoice (/invoices/new,
// /invoices/<id>). A draft is edited in place; issuing gives it its number
// and keeps the document exactly as sent. Money is whole cents on the wire
// and dollars on screen. The server works out every total; the totals here
// are a preview with the same rule (GST 10% per line, rounded half away from
// zero, server/core/money.js). Data comes from /api/invoicing
// (server/api/invoicing.js). app.js passes in its shared pieces as `ui`.
import { alertStrip } from '/assets/ui/alerts.js';
import { draftNote, sendModeNote } from '/assets/ui/invoice-notes.js';
import { jobChangeBanner } from '/assets/ui/job-change.js';

const STATUS_LABEL = { draft: 'Draft', issued: 'Issued', void: 'Void' };
const STATUS_TONE = { draft: 'info', issued: 'success', void: 'mute' };
// Drafts (to check), Problem and Ready are views (server/core/sending.js):
// every draft is in one of them. A person marks a checked draft ready; a
// saved change keeps it there. An issued invoice that failed to send is a
// problem.
// Ready first: it opens by default, as the drafts most often wait there to send.
const TABS = [['ready', 'Ready'], ['to_check', 'Drafts'], ['problem', 'Problem'], ['issued', 'Issued'], ['void', 'Void']];
const VIEW_LABEL = { problem: 'Problem', ready: 'Ready', sending: 'Sending', to_check: 'Draft' };
const VIEW_TONE = { problem: 'danger', ready: 'success', sending: 'info', to_check: 'info' };
const EMPTY = {
  to_check: 'No drafts to check. Press New invoice to start one.',
  problem: 'No problems.',
  ready: 'Nothing is ready. Tick drafts and press Move to Ready.',
};
// Tabs whose rows can be ticked, and what the ticked rows can do.
const TICKS = { to_check: true, ready: true };

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
  const saved = sessionStorage.getItem('flow_invoice_tab');
  // Back from an invoice comes here with the tab, search and scroll it left.
  const back = readNav();
  const returning = sessionStorage.getItem(NAV_BACK) === '1';
  sessionStorage.removeItem(NAV_BACK);
  const state = { status: TABS.some(([id]) => id === saved) ? saved : 'ready', q: returning ? back?.q ?? '' : '', ticked: new Set() };
  const tabs = h('div', { class: 'fx-tabs', role: 'tablist' });
  const search = h('input', { class: 'fx-input fx-search', type: 'search', placeholder: 'Find a number, client or reference', 'aria-label': 'Find an invoice', value: state.q });
  const bar = h('div', { class: 'fx-sendbar', hidden: true });
  const host = h('div', { class: 'fx-panel' }, h('div', { class: 'fx-skeleton' }));
  const context = await flow('/api/invoicing/context').catch(() => ({ canIssue: false }));
  let body = null;
  const openTab = (id) => { state.status = id; state.ticked.clear(); sessionStorage.setItem('flow_invoice_tab', id); load(); };
  const alerts = alertStrip(ui, 'invoices', { onTab: openTab });
  main.append(
    pageHeader('Invoices', {
      actions: [h('a', { class: 'fx-btn fx-btn--primary', href: '/invoices/new', onclick: go }, 'New invoice')],
    }),
    alerts.element,
    h('div', { class: 'fx-toolbar' }, tabs, search),
    bar,
    host);

  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = search.value.trim(); load(); }, 200);
  });

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const action = (label, path, payload, done, tone = 'primary') => {
    const el = h('button', {
      class: `fx-btn fx-btn--${tone}`, type: 'button',
      onclick: async () => {
        el.disabled = true;
        try {
          const res = await flow(`/api/invoicing/invoices/${path}`, { method: 'POST', body: JSON.stringify(payload()) });
          toast(...done(res));
          state.ticked.clear();
          seen.clear();
          await load();
          alerts.refresh();
        } catch (error) {
          toast(error.message, 'danger');
          el.disabled = false;
        }
      },
    }, label);
    return el;
  };

  // The bar above the list: what a person can do with this view.
  function drawBar() {
    const to = body.sendsTo;
    const ticked = [...state.ticked];
    const parts = [];
    if (state.status === 'to_check') {
      parts.push(h('p', { class: 'fx-dim' }, ticked.length ? `${plural(ticked.length, 'draft', 'drafts')} ticked.` : 'Check each draft, tick it, then move it to Ready.'));
      if (ticked.length) {
        parts.push(action(`Move ${ticked.length} to Ready`, 'mark-ready', () => ({ invoiceIds: ticked }), (res) => (res.refused.length
          ? [`${res.marked} ready. ${plural(res.refused.length, 'draft has', 'drafts have')} a problem and moved to Problem.`, 'danger']
          : [`${plural(res.marked, 'draft', 'drafts')} ready.`, 'success'])));
      }
    } else if (state.status === 'ready') {
      parts.push(h('p', { class: 'fx-dim' }, sendModeNote(to, body.sendMode)));
      const buttons = [];
      if (ticked.length) {
        buttons.push(action(`Move ${ticked.length} to Drafts`, 'mark-not-ready', () => ({ invoiceIds: ticked }),
          (res) => [`${plural(res.moved, 'invoice', 'invoices')} back in Drafts.`, 'success'], 'ghost'));
      }
      if (context.canIssue && body.counts.ready > 0) {
        buttons.push(action(to ? `Send all ${body.counts.ready} ready to ${to}` : `Finalise all ${body.counts.ready} ready`, 'send-ready', () => ({ issueDate: localDate() }),
          (res) => [`${res.issued} issued.${to ? ` They are on the way to ${to}.` : ''}${res.remaining ? ` ${res.remaining} more are ready: press again.` : ''}`, 'success']));
      }
      if (buttons.length) parts.push(h('div', { class: 'fx-sendbar__actions' }, buttons));
    } else if (state.status === 'problem') {
      const failed = body.invoices.filter((i) => i.status === 'issued').length;
      if (context.canIssue && to && failed > 0) {
        parts.push(h('p', { class: 'fx-dim' }, `${plural(failed, 'issued invoice', 'issued invoices')} did not reach ${to}. Fix the cause, then send again.`));
        parts.push(action('Send again', 'send-again', () => ({}), (res) => [`${res.queued} on the way to ${to} again.`, 'success']));
      }
    }
    bar.replaceChildren(...parts);
    bar.hidden = !parts.length;
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
      bar.hidden = true;
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
      ...(id === 'problem' && counts?.problem ? { 'data-tone': 'danger' } : {}),
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
        : EMPTY[state.status] ?? `No ${STATUS_LABEL[state.status].toLowerCase()} invoices yet.`));
      return;
    }
    // The invoice page steps through this list, in this order (navBar).
    saveNav({ tab: state.status, q: state.q, ids: body.invoices.map((i) => i.id) });
    const open = (href) => { saveNav({ ...readNav(), scrollY: window.scrollY }); go(href); };
    const link = (href, label) => h('a', { class: 'fx-strong', href, onclick: (event) => { event.preventDefault(); event.stopPropagation(); open(href); } }, label);
    const ticks = TICKS[state.status];
    const showProblem = state.status === 'problem';
    const created = ['to_check', 'problem', 'ready'].includes(state.status);
    // An invoice gets its number when it is sent or issued, so only the
    // Issued and Void tabs show a Number column; the others open on Client.
    const numbered = !created;
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
      onchange: () => {
        for (const invoice of body.invoices) { if (all.checked) state.ticked.add(invoice.id); else state.ticked.delete(invoice.id); }
        for (const box of boxes) box.checked = all.checked;
        drawBar();
      },
    });
    const statusCells = new Map();
    host.replaceChildren(h('table', { class: 'fx-table fx-table--rows' },
      h('thead', {}, h('tr', {},
        ticks ? h('th', { class: 'fx-tick-cell' }, all) : null,
        numbered ? h('th', {}, 'Number') : null, h('th', {}, 'Client'), h('th', {}, showProblem ? 'Problem' : 'Reference'),
        h('th', {}, created ? 'Created' : 'Issued'), h('th', { class: 'fx-num' }, 'Total'), h('th', {}, 'Status'))),
      h('tbody', {}, body.invoices.map((invoice) => {
        const href = `/invoices/${invoice.id}`;
        const first = invoice.problems?.[0];
        const view = invoice.status === 'void' ? null : invoice.view;
        return h('tr', { tabindex: '0', onclick: () => open(href), onkeydown: (event) => { if (event.key === 'Enter') open(href); } },
          ticks ? h('td', { class: 'fx-tick-cell', onclick: (event) => event.stopPropagation() }, tickBox(invoice)) : null,
          numbered ? h('td', {}, link(href, invoice.number ?? 'Draft')) : null,
          h('td', {}, numbered ? (invoice.contactName ?? '—') : link(href, invoice.contactName ?? 'No client')),
          showProblem
            ? h('td', { class: 'fx-problem' }, first?.message ?? '—', invoice.problems.length > 1 ? h('span', { class: 'fx-dim' }, ` +${invoice.problems.length - 1} more`) : null)
            : h('td', { class: 'fx-dim' }, invoice.reference ?? '—'),
          h('td', { class: 'fx-dim' }, showDate(invoice.issueDate ?? invoice.createdAt?.slice(0, 10))),
          h('td', { class: 'fx-num fx-strong' }, formatCents(invoice.totalCents)),
          (() => {
            const cell = h('td', { class: 'fx-status-cell' }, view
              ? h('span', { class: 'fx-status', 'data-tone': VIEW_TONE[view] }, VIEW_LABEL[view])
              : h('span', { class: 'fx-status', 'data-tone': STATUS_TONE[invoice.status] }, STATUS_LABEL[invoice.status]));
            statusCells.set(invoice.id, cell);
            return cell;
          })());
      }))));
    // Issued and void invoices also show Xero's status, from Flow's copy.
    if (['issued', 'void'].includes(state.status)) {
      const shownBody = body;
      const statuses = await xeroStatuses(ui, context.organisations?.[0]?.id, body.invoices.map((i) => i.id));
      if (shownBody !== body) return;
      for (const [invoiceId, status] of statuses) {
        if (status.state !== 'not_sent' || status.finding) statusCells.get(invoiceId)?.append(' ', xeroTag(ui, status));
      }
    }
  }
  await load();
  if (returning && back?.scrollY) window.scrollTo(0, back.scrollY);
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
// next invoice of that list.
function navBar(ui, id) {
  const { h, go } = ui;
  const nav = readNav();
  const ids = nav?.ids ?? [];
  const at = ids.indexOf(id);
  const back = () => { sessionStorage.setItem(NAV_BACK, '1'); go('/invoices'); };
  const step = (to, label, path) => {
    const button = h('button', {
      class: 'fx-pager__step', type: 'button', disabled: !to, 'aria-label': label, title: label,
      onclick: () => go(`/invoices/${to}`),
    });
    button.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return button;
  };
  return h('nav', { class: 'fx-pager', 'aria-label': 'Invoices' },
    h('button', { class: 'fx-pager__back', type: 'button', onclick: back }, '← Back'),
    at >= 0 ? h('span', { class: 'fx-pager__count' }, `${at + 1} of ${ids.length}`) : null,
    at >= 0 ? h('span', { class: 'fx-pager__steps' }, step(ids[at - 1], 'Previous invoice', 'M14.5 6l-6 6 6 6'), step(ids[at + 1], 'Next invoice', 'M9.5 6l6 6-6 6')) : null);
}

// After a send, the next invoice of the list opens; at its end, the list.
// The sent invoice stays in the bar's list, so the count holds (2 of 35) and
// Previous opens it again, now sent. Back reloads the list without it.
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

// The job an invoice bills. The case id stays on the record, not on screen.
function jobCard(ui, job) {
  const { h } = ui;
  if (!job) return null;
  return h('section', { class: 'fx-card fx-side-card' },
    h('h3', { class: 'fx-label' }, 'Job'),
    h('dl', { class: 'fx-facts' },
      job.practitioner ? [h('dt', {}, 'Practitioner'), h('dd', {}, job.practitioner)] : null,
      job.shippedOn ? [h('dt', {}, 'Shipped'), h('dd', {}, showDate(job.shippedOn))] : null,
      h('dt', {}, 'From'), h('dd', {}, job.sourceSystem === 'seazona' ? 'Seazona' : job.sourceSystem)));
}

// A draft, or a new invoice before its first save.
function draftView(invoice, ui, context, redraw) {
  const { h, flow, toast, go, notice } = ui;
  const isNew = !invoice;
  const lines = (invoice?.lines ?? []).map((line) => ({ ...line }));
  if (!lines.length) lines.push({ description: '', quantity: 1, unitAmountCents: null, taxCode: 'GST', priceItemId: null });
  let contact = invoice?.contact ?? null;
  // Finalise invoice waits for a client and a due date (syncIssue, below).
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
  // change since the page opened. Saving keeps the invoice where it is.
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
      else redraw(saved);
    },
  }, keepsSave ? 'Save as draft' : 'Save changes');
  const opened = JSON.stringify(body());
  const changed = () => !isNew && JSON.stringify(body()) !== opened;
  const watchChanges = () => { if (!keepsSave) saveButton.hidden = !changed(); };
  // With an accounting system on, a ready invoice is sent there: Flow issues
  // it and queues it, the same as Send all ready. With none, Flow issues it
  // and keeps it. A draft that is not ready has no send: move it to Ready first.
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
  // With no accounting system, Finalise invoice gives the draft its number and
  // locks it. A changed job blocks it, as it blocks Move to Ready.
  const issueButton = context.canIssue && !to ? h('button', {
    class: 'fx-btn fx-btn--primary', type: 'button',
    onclick: async () => {
      const saved = await save();
      if (!saved) return;
      const ok = await ui.dialog({
        title: 'Finalise this invoice?',
        body: h('p', {}, `It gets the next number (${nextNumber}). Flow keeps it exactly as issued. To change it later, revise it.`),
        confirm: 'Finalise',
      });
      if (!ok) { if (isNew) go(`/invoices/${saved.id}`, { replace: true }); else redraw(saved); return; }
      try {
        const { invoice: issued } = await flow(`/api/invoicing/invoices/${saved.id}/issue`, { method: 'POST', body: JSON.stringify({ issueDate: localDate() }) });
        toast(`${issued.number} is final.`, 'success');
        if (isNew) go(`/invoices/${issued.id}`, { replace: true });
        else redraw(issued);
      } catch (error) {
        toast(error.message, 'danger');
      }
    },
  }, 'Finalise') : null;
  // Issue needs a client and a due date: until both are set it is greyed.
  // A changed job greys it too, as it does Move to Ready.
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

  // Finalise, with an accounting system on: the draft is saved, then Flow
  // checks it and moves it to the Ready tab, for Send all ready; nothing is
  // sent here. A draft the draft routine made from a job ready to invoice is
  // in Ready already (automations.js), so this is for the rest. One with a
  // problem stays a draft. Move to Drafts, on the Status card, undoes it. A
  // changed job is fixed at its source or adopted, so the button waits.
  const jobChange = invoice?.jobChange ?? null;
  const markReadyButton = isNew || ready || !to ? null : h('button', {
    class: 'fx-btn fx-btn--primary', type: 'button', disabled: Boolean(jobChange),
    title: jobChange ? 'Fix the problem first.' : `Checks this draft and moves it to Ready. Send all ready sends it to ${to}.`,
    onclick: async () => {
      if (!(await save())) return;
      try {
        const res = await flow('/api/invoicing/invoices/mark-ready', { method: 'POST', body: JSON.stringify({ invoiceIds: [invoice.id] }) });
        if (res.marked) toast(`Final. It is in Ready; Send all ready sends it to ${to}.`, 'success');
        else toast(res.refused[0]?.problems.map((p) => p.message).join(' ') ?? 'It has a problem.', 'danger');
        const { invoice: fresh } = await flow(`/api/invoicing/invoices/${invoice.id}`);
        redraw(fresh);
      } catch (error) {
        toast(error.message, 'danger');
      }
    },
  }, 'Finalise');
  // A ready invoice can go back to Drafts. It is a status change, so it sits
  // with the status, not with the page's main buttons.
  const statusCard = ready ? h('section', { class: 'fx-card fx-side-card' },
    h('h3', { class: 'fx-label' }, 'Status'),
    h('p', {}, 'Ready to send.'),
    h('button', {
      class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button',
      onclick: async () => {
        try {
          await flow('/api/invoicing/invoices/mark-not-ready', { method: 'POST', body: JSON.stringify({ invoiceIds: [invoice.id] }) });
          toast('Moved to Drafts.', 'success');
          const { invoice: fresh } = await flow(`/api/invoicing/invoices/${invoice.id}`);
          redraw(fresh);
        } catch (error) {
          toast(error.message, 'danger');
        }
      },
    }, 'Move to Drafts')) : null;
  // The job changed after the invoice was made: its own banner shows what
  // changed. Other problems stay one line.
  const otherProblems = (invoice?.problems ?? []).filter((p) => !(jobChange && p.code === 'job_review'));
  const problems = [
    jobChange ? jobChangeBanner(ui, jobChange, {
      money: formatCents,
      // Adopting changes the draft for the business: owners and admins only.
      onAdopt: !context.canIssue ? null : async () => {
        const system = jobChange.systemName;
        const ok = await ui.dialog({
          title: `Adopt the ${system} changes?`,
          body: h('p', {}, `This invoice takes the Now in ${system} column.${changed() ? ' Your unsaved changes here are lost.' : ''} Nothing goes to ${system} or the accounting system.`),
          confirm: 'Adopt changes',
        });
        if (!ok) return;
        try {
          const res = await flow(`/api/invoicing/jobs/${jobChange.jobId}/use-new-lines`, { method: 'POST', body: '{}' });
          toast(`The invoice now matches ${system}.${res.invoice.view === 'ready' ? ' It is in Ready.' : ''}`, 'success');
          redraw(res.invoice);
        } catch (error) {
          toast(error.message, 'danger');
        }
      },
    }) : null,
    otherProblems.length ? notice(otherProblems.map((p) => p.message).join(' '), 'danger', 'Problem.') : null,
  ];

  return [
    navBar(ui, invoice?.id ?? null),
    h('header', { class: 'fx-ph' },
      h('div', { class: 'fx-ph__text' },
        h('h1', { class: 'fx-title' }, isNew ? 'New invoice' : ready ? 'Ready invoice' : 'Draft invoice'),
        h('p', { class: 'fx-ph__sub' }, draftNote(to, invoice, ready))),
      h('div', { class: 'fx-ph__actions' }, isNew ? null : previewButton(ui, invoice.id, 'Shows the saved invoice.'), saveButton, markReadyButton, sendButton ?? issueButton)),
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
      h('aside', { class: 'fx-invoice__aside' }, statusCard, jobCard(ui, invoice?.job))),
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
  let xeroStatus = null;
  const send = invoice.status === 'issued' && context.canIssue ? sendToXero(invoice, ui, context) : null;
  const loadXero = async () => {
    if (!context.xero) return;
    xeroStatus = (await xeroStatuses(ui, organisationId, [invoice.id])).get(invoice.id) ?? null;
    xeroHost.replaceChildren(xeroCard(invoice, ui, context, xeroStatus, loadXero) ?? '');
    if (xeroStatus && xeroStatus.state !== 'not_sent') showSent(send);
  };
  loadXero();
  // Voiding in Flow never changes Xero: say so while Xero still holds it live.
  const voidBody = () => {
    const live = xeroStatus?.xero && !['VOIDED', 'DELETED'].includes(xeroStatus.xero.status);
    return h('div', {},
      h('p', {}, 'The number stays used. A void invoice cannot be issued again.'),
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
    navBar(ui, invoice.id),
    h('header', { class: 'fx-ph' },
      h('div', { class: 'fx-ph__text' },
        h('div', { class: 'fx-row' },
          h('h1', { class: 'fx-title' }, invoice.number),
          h('span', { class: 'fx-status', 'data-tone': STATUS_TONE[invoice.status] }, STATUS_LABEL[invoice.status])),
        h('p', { class: 'fx-ph__sub' }, `${invoice.contact?.name ?? ''} · issued ${showDate(invoice.issueDate)}`)),
      h('div', { class: 'fx-ph__actions' }, actions, previewButton(ui, invoice.id), send)),
    h('div', { class: 'fx-invoice__grid' },
      h('div', { class: 'fx-invoice__main' },
        h('section', { class: 'fx-card fx-doc' },
          h('dl', { class: 'fx-doc__meta' },
            h('div', {}, h('dt', { class: 'fx-label' }, 'Bill to'), h('dd', {}, invoice.contact?.name ?? '—', invoice.contact?.email ? h('span', { class: 'fx-dim' }, invoice.contact.email) : null)),
            h('div', {}, h('dt', { class: 'fx-label' }, 'Reference'), h('dd', {}, invoice.reference ?? '—')),
            h('div', {}, h('dt', { class: 'fx-label' }, 'Issued'), h('dd', {}, showDate(invoice.issueDate))),
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
        xeroHost,
        jobCard(ui, invoice.job),
        invoice.versions?.length ? h('section', { class: 'fx-card fx-side-card' },
          h('h3', { class: 'fx-label' }, 'History'),
          h('ol', { class: 'fx-timeline' }, invoice.versions.map((v) => h('li', {},
            h('span', { class: 'fx-strong' }, v.version === 1 ? 'Issued' : `Reissued (version ${v.version})`),
            h('span', { class: 'fx-dim' }, new Date(v.issuedAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })))))) : null)),
  ];
}

// Xero's copy of this invoice: its status, any difference from what Flow
// sent, and Mark resolved, which reads Xero's changes and checks again. It
// never writes to Xero: a person fixes the difference where they choose.
function xeroCard(invoice, ui, context, status, reload) {
  const { h, flow, toast } = ui;
  if (!status || (status.state === 'not_sent' && !status.finding)) return null;
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
        toast(error.message, 'danger');
        resolve.disabled = false;
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
      } finally {
        if (sent) showSent(button);
        else button.disabled = false;
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
