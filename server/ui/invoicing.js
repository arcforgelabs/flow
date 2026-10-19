// Invoices: the list (/invoices) and one invoice (/invoices/new,
// /invoices/<id>). A draft is edited in place; issuing gives it its number
// and keeps the document exactly as sent. Money is whole cents on the wire
// and dollars on screen. The server works out every total; the totals here
// are a preview with the same rule (GST 10% per line, rounded half away from
// zero, server/core/money.js). Data comes from /api/invoicing
// (server/api/invoicing.js). app.js passes in its shared pieces as `ui`.
import { alertStrip } from '/assets/ui/alerts.js';

const STATUS_LABEL = { draft: 'Draft', issued: 'Issued', void: 'Void' };
const STATUS_TONE = { draft: 'info', issued: 'success', void: 'mute' };
// Drafts (to check), Problem and Ready are views (server/core/sending.js):
// every draft is in one of them. A person marks a checked draft ready; any
// later change sends it back. An issued invoice that failed to send is a
// problem.
// Ready first: it opens by default, as the drafts most often wait there to send.
const TABS = [['ready', 'Ready'], ['to_check', 'Drafts'], ['problem', 'Problem'], ['issued', 'Issued'], ['void', 'Void']];
const VIEW_LABEL = { problem: 'Problem', ready: 'Ready', sending: 'Sending', to_check: 'Draft' };
const VIEW_TONE = { problem: 'danger', ready: 'success', sending: 'info', to_check: 'info' };
const EMPTY = {
  to_check: 'No drafts to check. Press New invoice to start one.',
  problem: 'No problems.',
  ready: 'Nothing is ready. Tick drafts and press Mark ready.',
};
// Tabs whose rows can be ticked, and what the ticked rows can do.
const TICKS = { to_check: true, ready: true };

const money = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
export const formatCents = (cents) => money.format((cents ?? 0) / 100);

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

// What happens to a ready invoice in the accounting system, one fact per
// sentence. It follows the integration's settings: its connection, whether it
// takes writes, and the send mode on its page.
export function sendModeNote(to, sendMode) {
  if (!to) return 'No accounting system is on. Flow keeps each invoice here only.';
  if (sendMode && !sendMode.connected) return `${to} is not connected. Connect it in Integrations before you send.`;
  if (sendMode && !sendMode.writesAllowed) return `${to} does not take invoices from Flow yet. Turn this on in Integrations, ${to}.`;
  const text = sendMode?.mode === 'approve_and_email'
    ? [`Flow sends each invoice to ${to} as approved.`, `${to} emails it to the customer at once.`]
    : [`Flow sends each invoice to ${to} as a draft.`, `You approve and send it in ${to}.`];
  const others = sendMode?.otherCustomers ?? 0;
  if (others) text.push(`${others} ${others === 1 ? 'customer has' : 'customers have'} a different setting.`);
  return text.join(' ');
}

// ── The list ───────────────────────────────────────────────────────────────

export async function renderInvoiceList(main, ui) {
  const { h, flow, pageHeader, notice, go, toast } = ui;
  const saved = sessionStorage.getItem('flow_invoice_tab');
  const state = { status: TABS.some(([id]) => id === saved) ? saved : 'ready', q: '', ticked: new Set() };
  const tabs = h('div', { class: 'fx-tabs', role: 'tablist' });
  const search = h('input', { class: 'fx-input fx-search', type: 'search', placeholder: 'Find a number, client or reference', 'aria-label': 'Find an invoice' });
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
      parts.push(h('p', { class: 'fx-dim' }, ticked.length ? `${plural(ticked.length, 'draft', 'drafts')} ticked.` : 'Check each draft, tick it, then mark it ready.'));
      if (ticked.length) {
        parts.push(action(`Mark ${ticked.length} ready`, 'mark-ready', () => ({ invoiceIds: ticked }), (res) => (res.refused.length
          ? [`${res.marked} ready. ${plural(res.refused.length, 'draft has', 'drafts have')} a problem and moved to Problem.`, 'danger']
          : [`${plural(res.marked, 'draft', 'drafts')} ready.`, 'success'])));
      }
    } else if (state.status === 'ready') {
      parts.push(h('p', { class: 'fx-dim' }, sendModeNote(to, body.sendMode)));
      const buttons = [];
      if (ticked.length) {
        buttons.push(action(`Back to drafts (${ticked.length})`, 'mark-not-ready', () => ({ invoiceIds: ticked }),
          (res) => [`${plural(res.moved, 'invoice', 'invoices')} back in Drafts.`, 'success'], 'ghost'));
      }
      if (context.canIssue && body.counts.ready > 0) {
        buttons.push(action(to ? `Send all ${body.counts.ready} ready to ${to}` : `Issue all ${body.counts.ready} ready`, 'send-ready', () => ({ issueDate: localDate() }),
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

  async function load() {
    try {
      const query = new URLSearchParams({ status: state.status, ...(state.q ? { q: state.q } : {}) });
      body = await flow(`/api/invoicing/invoices?${query}`);
    } catch (error) {
      host.replaceChildren(notice(error.message, 'danger'));
      return;
    }
    const shown = new Set(body.invoices.map((i) => i.id));
    for (const id of state.ticked) if (!shown.has(id)) state.ticked.delete(id);
    tabs.replaceChildren(...TABS.map(([id, label]) => h('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(state.status === id),
      ...(id === 'problem' && body.counts?.problem ? { 'data-tone': 'danger' } : {}),
      onclick: () => openTab(id),
    }, label, h('span', { class: 'fx-tabs__count' }, String(body.counts?.[id] ?? 0)))));
    drawBar();
    if (!body.invoices.length) {
      host.replaceChildren(h('p', { class: 'fx-empty' }, state.q
        ? 'No invoice matches that search.'
        : EMPTY[state.status] ?? `No ${STATUS_LABEL[state.status].toLowerCase()} invoices yet.`));
      return;
    }
    const ticks = TICKS[state.status];
    const showProblem = state.status === 'problem';
    const created = ['to_check', 'problem', 'ready'].includes(state.status);
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
    host.replaceChildren(h('table', { class: 'fx-table fx-table--rows' },
      h('thead', {}, h('tr', {},
        ticks ? h('th', { class: 'fx-tick-cell' }, all) : null,
        h('th', {}, 'Number'), h('th', {}, 'Client'), h('th', {}, showProblem ? 'Problem' : 'Reference'),
        h('th', {}, created ? 'Created' : 'Issued'), h('th', { class: 'fx-num' }, 'Total'), h('th', {}, 'Status'))),
      h('tbody', {}, body.invoices.map((invoice) => {
        const href = `/invoices/${invoice.id}`;
        const first = invoice.problems?.[0];
        const view = invoice.status === 'void' ? null : invoice.view;
        return h('tr', { tabindex: '0', onclick: () => go(href), onkeydown: (event) => { if (event.key === 'Enter') go(href); } },
          ticks ? h('td', { class: 'fx-tick-cell', onclick: (event) => event.stopPropagation() }, tickBox(invoice)) : null,
          h('td', {}, h('a', { class: 'fx-strong', href, onclick: go }, invoice.number ?? 'Draft')),
          h('td', {}, invoice.contactName ?? '—'),
          showProblem
            ? h('td', { class: 'fx-problem' }, first?.message ?? '—', invoice.problems.length > 1 ? h('span', { class: 'fx-dim' }, ` +${invoice.problems.length - 1} more`) : null)
            : h('td', { class: 'fx-dim' }, invoice.job?.caseRef ?? invoice.reference ?? '—'),
          h('td', { class: 'fx-dim' }, showDate(invoice.issueDate ?? invoice.createdAt?.slice(0, 10))),
          h('td', { class: 'fx-num fx-strong' }, formatCents(invoice.totalCents)),
          h('td', {}, view
            ? h('span', { class: 'fx-status', 'data-tone': VIEW_TONE[view] }, VIEW_LABEL[view])
            : h('span', { class: 'fx-status', 'data-tone': STATUS_TONE[invoice.status] }, STATUS_LABEL[invoice.status])));
      }))));
  }
  await load();
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
      : draftView(current, ui, context, draw)));
  };
  draw(invoice);
}

function crumbs(ui, label) {
  const { h, go } = ui;
  return h('nav', { class: 'fx-crumbs', 'aria-label': 'Breadcrumb' },
    h('a', { href: '/invoices', onclick: go }, 'Invoices'), h('span', { 'aria-hidden': 'true' }, '/'), h('span', {}, label));
}

function totalsBox(ui, { subtotalCents, taxCents, totalCents }) {
  const { h } = ui;
  return h('dl', { class: 'fx-totals' },
    h('dt', {}, 'Subtotal'), h('dd', {}, formatCents(subtotalCents)),
    h('dt', {}, 'GST'), h('dd', {}, formatCents(taxCents)),
    h('dt', { class: 'fx-totals__grand' }, 'Total'), h('dd', { class: 'fx-totals__grand' }, formatCents(totalCents)));
}

function jobCard(ui, job) {
  const { h } = ui;
  if (!job) return null;
  return h('section', { class: 'fx-card fx-side-card' },
    h('h3', { class: 'fx-label' }, 'Job'),
    h('dl', { class: 'fx-facts' },
      h('dt', {}, 'Case'), h('dd', {}, job.caseRef ?? job.sourceJobRef),
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
          },
        }, c.name, c.email ? h('span', { class: 'fx-dim' }, c.email) : null)) : [h('p', { class: 'fx-dim fx-suggest__none' }, 'No client by that name.')]));
        clientList.hidden = false;
      } catch (error) {
        toast(error.message, 'danger');
      }
    }, 180);
  });
  clientInput.addEventListener('blur', () => { setTimeout(() => { clientList.hidden = true; }, 120); });

  const reference = h('input', { class: 'fx-input', type: 'text', value: invoice?.reference ?? '', placeholder: 'Case or order number' });
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

  const saveButton = h('button', {
    class: 'fx-btn', type: 'button',
    onclick: async () => {
      const saved = await save();
      if (!saved) return;
      toast('Draft saved.', 'success');
      if (isNew) go(`/invoices/${saved.id}`, { replace: true });
      else redraw(saved);
    },
  }, 'Save draft');
  const issueButton = context.canIssue ? h('button', {
    class: 'fx-btn fx-btn--primary', type: 'button',
    onclick: async () => {
      const saved = await save();
      if (!saved) return;
      const ok = await ui.dialog({
        title: 'Issue this invoice?',
        body: h('p', {}, `It gets the next number (${context.organisations[0]?.invoicePrefix ?? ''}${String(context.organisations[0]?.nextInvoiceNumber ?? '').padStart(4, '0')}) and is kept exactly as issued. To change it later, revise it.`),
        confirm: 'Issue',
      });
      if (!ok) { if (isNew) go(`/invoices/${saved.id}`, { replace: true }); else redraw(saved); return; }
      try {
        const { invoice: issued } = await flow(`/api/invoicing/invoices/${saved.id}/issue`, { method: 'POST', body: JSON.stringify({ issueDate: localDate() }) });
        toast(`${issued.number} issued.`, 'success');
        if (isNew) go(`/invoices/${issued.id}`, { replace: true });
        else redraw(issued);
      } catch (error) {
        toast(error.message, 'danger');
      }
    },
  }, 'Issue invoice') : null;

  // Mark ready: the draft is saved, then Flow checks it; one with a problem
  // stays a draft. Back to drafts undoes it.
  const ready = invoice?.view === 'ready';
  const readyButton = isNew ? null : h('button', {
    class: 'fx-btn', type: 'button',
    onclick: async () => {
      const current = ready ? invoice : await save();
      if (!current) return;
      try {
        if (ready) {
          await flow('/api/invoicing/invoices/mark-not-ready', { method: 'POST', body: JSON.stringify({ invoiceIds: [invoice.id] }) });
          toast('Back in Drafts.', 'success');
        } else {
          const res = await flow('/api/invoicing/invoices/mark-ready', { method: 'POST', body: JSON.stringify({ invoiceIds: [invoice.id] }) });
          if (res.marked) toast('Ready to send.', 'success');
          else toast(res.refused[0]?.problems.map((p) => p.message).join(' ') ?? 'It has a problem.', 'danger');
        }
        const { invoice: fresh } = await flow(`/api/invoicing/invoices/${invoice.id}`);
        redraw(fresh);
      } catch (error) {
        toast(error.message, 'danger');
      }
    },
  }, ready ? 'Back to drafts' : 'Mark ready');
  const problems = invoice?.problems?.length
    ? notice(invoice.problems.map((p) => p.message).join(' '), 'danger', 'Problem.')
    : null;

  return [
    crumbs(ui, isNew ? 'New invoice' : ready ? 'Ready' : 'Draft'),
    h('header', { class: 'fx-ph' },
      h('div', { class: 'fx-ph__text' },
        h('h1', { class: 'fx-title' }, isNew ? 'New invoice' : ready ? 'Ready invoice' : 'Draft invoice'),
        h('p', { class: 'fx-ph__sub' }, ready ? 'A person checked it. Send all ready issues it. A change sends it back to Drafts.' : 'The number is given when you issue it.')),
      h('div', { class: 'fx-ph__actions' }, saveButton, readyButton, issueButton)),
    problems,
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
      h('aside', { class: 'fx-invoice__aside' }, jobCard(ui, invoice?.job))),
  ];
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
  const actions = invoice.status === 'issued' && context.canIssue ? [
    h('button', {
      class: 'fx-btn fx-btn--ghost fx-btn--danger', type: 'button',
      onclick: () => act('void', `${invoice.number} is void.`, { title: `Void ${invoice.number}?`, body: h('p', {}, 'The number stays used. A void invoice cannot be issued again.'), confirm: 'Void', tone: 'danger' }),
    }, 'Void'),
    h('button', { class: 'fx-btn', type: 'button', onclick: () => act('revise', `${invoice.number} is a draft again.`) }, 'Revise'),
    sendToXero(invoice, ui, context),
  ] : [];
  return [
    crumbs(ui, invoice.number),
    h('header', { class: 'fx-ph' },
      h('div', { class: 'fx-ph__text' },
        h('div', { class: 'fx-row' },
          h('h1', { class: 'fx-title' }, invoice.number),
          h('span', { class: 'fx-status', 'data-tone': STATUS_TONE[invoice.status] }, STATUS_LABEL[invoice.status])),
        h('p', { class: 'fx-ph__sub' }, `${invoice.contact?.name ?? ''} · issued ${showDate(invoice.issueDate)}`)),
      h('div', { class: 'fx-ph__actions' }, actions)),
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
        jobCard(ui, invoice.job),
        invoice.versions?.length ? h('section', { class: 'fx-card fx-side-card' },
          h('h3', { class: 'fx-label' }, 'History'),
          h('ol', { class: 'fx-timeline' }, invoice.versions.map((v) => h('li', {},
            h('span', { class: 'fx-strong' }, v.version === 1 ? 'Issued' : `Reissued (version ${v.version})`),
            h('span', { class: 'fx-dim' }, new Date(v.issuedAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })))))) : null)),
  ];
}

// Send to Xero (POST /api/xero/invoices/push). The customer's send mode
// (Settings, Invoicing) decides what Xero gets: a draft that a person approves
// there, or an approved invoice that Xero emails to the customer.
function sendToXero(invoice, ui, context) {
  const { h, flow, toast } = ui;
  const organisationId = context.organisations[0]?.id;
  if (!organisationId || !context.xero) return null;
  const button = h('button', {
    class: 'fx-btn fx-btn--primary', type: 'button',
    onclick: async () => {
      button.disabled = true;
      try {
        const res = await flow('/api/xero/invoices/push', { method: 'POST', body: JSON.stringify({ organisationId, invoiceIds: [invoice.id] }) });
        const result = res.invoices?.[0];
        const email = result?.email;
        if (email && ['failed', 'unknown'].includes(email.state)) toast(email.error, 'danger');
        else if (email?.state === 'sent') toast(`${invoice.number} is approved in Xero, and Xero emailed it to the customer.`, 'success');
        else if (['created', 'reconciled', 'existing'].includes(result?.outcome)) toast(`${invoice.number} is in Xero as a draft.`, 'success');
        else if (result?.outcome === 'already_in_xero') toast(`Xero already has ${invoice.number}.`, 'info');
        else toast(result?.error?.message ?? 'Xero did not take it.', 'danger');
      } catch (error) {
        toast(error.message, 'danger');
      } finally {
        button.disabled = false;
      }
    },
  }, 'Send to Xero');
  // The preview reads only Flow's copy of Xero: it costs no Xero calls.
  flow('/api/xero/invoices/preview', { method: 'POST', body: JSON.stringify({ organisationId, invoiceIds: [invoice.id] }) })
    .then((res) => {
      if (res.invoices?.[0]?.sendMode === 'approve_and_email') button.textContent = 'Send to Xero and email';
    })
    .catch(() => {});
  return button;
}
