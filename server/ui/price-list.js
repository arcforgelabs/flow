// Price list (/price-list; server/core/price-list.js, docs/PRICE_LIST.md).
// Flow's own codes and prices, which work with no integration connected.
// Laid out like Jobs and Invoices: the shared list head (Active / Archived
// tabs, Group, Sort, Filter, saved views, Find) over the list window, one
// row per code. A row opens a dialog with the code's fields, its links and,
// when something differs, Mark resolved. The head's icons open Reconcile
// (price-reconcile.js, while an integration with its own price list is on)
// and the price list's settings. Everyone can read it; an owner or admin
// changes it. The caller passes in app.js's shared pieces as `ui`.
import { alertStrip } from '/assets/ui/alerts.js';
import { columnTable, groupHead, rowCells, viewSaver } from '/assets/ui/columns.js';
import { lucide } from '/assets/ui/custom-fields.js';
import { filterJobs, groupJobs, PRICE_COLUMNS, sortJobs } from '/assets/ui/job-view.js';
import { normalisePriceView, PRICE_FIELDS, priceValue } from '/assets/ui/list-views.js';
import { reconcileRows } from '/assets/ui/price-match.js';
import { savedViews } from '/assets/ui/saved-views.js';
import { findBox, today, viewBar } from '/assets/ui/view-bar.js';

const TAX_LABELS = { GST: 'GST', GST_FREE: 'GST free' };
// Where an invoice line takes its price (the line mapping routine's
// `linePrice`): the job's own amount, or this list's price.
const LINE_PRICES = [
  { value: 'work', label: 'Job price' },
  { value: 'list', label: 'Price list' },
];
const NUMBER_WORDS = ['Low to high', 'High to low'];

// The list's columns (columns.js): each keeps its own width, saved with the
// person's account; + shows a hidden one again.
const COLUMN_DEFS = {
  code: { kind: 'number', phone: 'meta', className: 'fx-price__code', cell: (item) => item.code },
  name: { kind: 'client', phone: 'title', cell: (item) => item.name },
  price: { kind: 'total', num: true, cell: (item) => money(item.unitAmountCents) },
  tax: { kind: 'case', className: 'fx-dim', cell: (item) => TAX_LABELS[item.taxCode] ?? item.taxCode },
};

const money = (cents) => (cents === null || cents === undefined ? '' : `$${(cents / 100).toFixed(2)}`);
const toCents = (text) => {
  const value = Number(String(text ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(value) ? Math.round(value * 100) : NaN;
};

export async function renderPriceList(main, ui) {
  const { h, flow, toast, notice, dialog, listHead, listFrame, me } = ui;
  const disabled = !['owner', 'admin'].includes(me?.person.role);
  const host = h('div', { class: 'fx-panel' }, h('div', { class: 'fx-skeleton' }));
  // The person's view (list-views.js): columns, Group, Sort and Filter,
  // kept with their account.
  let view = normalisePriceView(me?.views?.['price-list']);
  const saveView = viewSaver(ui, 'price-list');
  function change(patch) {
    view = normalisePriceView({ ...view, ...patch });
    saveView(view);
    views.draw();
    if (data) draw();
  }
  const views = savedViews(ui, { page: 'price-list', current: () => view, apply: change });
  const opening = views.opening();
  if (opening) view = normalisePriceView(opening);
  views.draw();

  let data = null;
  let query = '';
  let tab = 'active';
  let opened = new URLSearchParams(location.search).get('code');
  const systemName = (id) => data?.systems.find((s) => s.id === id)?.name ?? id;
  const taxName = (code) => TAX_LABELS[code] ?? code;

  // Group, Sort and Filter: the same chips as on Jobs (view-bar.js).
  const kindOf = (field) => PRICE_FIELDS[field]?.kind ?? null;
  const fieldList = (keep = () => true) => Object.entries(PRICE_FIELDS).filter(([, f]) => keep(f)).map(([value, f]) => ({ value, label: f.label, icon: f.icon }));
  const bar = viewBar(h);
  const groupMenu = bar.groupMenu({ options: () => fieldList((f) => f.group), view: () => view, change });
  const sortMenu = bar.sortMenu({
    options: fieldList, view: () => view, change,
    dirWords: (by) => (kindOf(by) === 'number' ? NUMBER_WORDS : ['A to Z', 'Z to A']),
    nameOf: (by) => PRICE_FIELDS[by].label, empty: 'No sort. Codes show A to Z.',
  });
  const filterMenu = bar.filterMenu({
    fields: fieldList, kindOf,
    choicesOf: (field) => (field === 'tax' ? Object.entries(TAX_LABELS).map(([value, label]) => ({ value, label }))
      : field === 'linked' ? (data?.systems ?? []).map((s) => ({ value: s.id, label: s.name })) : []),
    view: () => view, change, first: 'tax', empty: 'No filters. Every code shows.',
  });
  const controls = h('div', { class: 'fx-viewbar', role: 'group', 'aria-label': 'Group, sort and filter' }, ...groupMenu.node, ...sortMenu.node, ...filterMenu.node);
  const drawControls = () => {
    groupMenu.set(view.group === 'none' ? 'Group' : `Group: ${PRICE_FIELDS[view.group].label}`, view.group !== 'none', view.group === 'none' ? null : () => change({ group: 'none' }));
    sortMenu.draw();
    filterMenu.draw();
  };

  // The list's columns (columns.js): each keeps its own width, saved with
  // the person's account; + shows a hidden one again; a head sorts.
  const heads = columnTable(h, {
    order: () => view.columns,
    widths: () => view.widths,
    change,
    hidden: () => Object.keys(PRICE_COLUMNS).filter((id) => !view.columns.includes(id)).map((id) => ({ id, label: PRICE_COLUMNS[id] })),
    sorting: { sortOf: (id) => (PRICE_FIELDS[id] ? id : null), sorts: () => view.sorts, change, dirWords: (by) => (kindOf(by) === 'number' ? NUMBER_WORDS : ['A to Z', 'Z to A']) },
  });

  const tabs = h('div', { class: 'fx-tabs', role: 'tablist' });
  const find = findBox(h, { label: 'Find a code or name', value: query, oninput: (words) => { query = words; draw(); } });
  const icon = (name, label, onclick) => h('button', { class: 'fx-btn fx-btn--ghost fx-btn--icon', type: 'button', 'aria-label': label, title: label, onclick }, lucide(h, name));
  const reconcileButton = icon('git-compare-arrows', 'Reconcile', () => ui.go('/price-list/reconcile'));
  reconcileButton.hidden = true;
  const settingsButton = icon('settings', 'Price list settings', () => openSettings());
  const addButton = h('button', { class: 'fx-btn fx-btn--primary', type: 'button', disabled, title: disabled ? 'Only an owner or admin can add a code' : null, onclick: () => edit(null) }, lucide(h, 'plus'), 'New');
  const alerts = alertStrip(ui, 'price-list');
  const listTop = listHead('Price list', {
    actions: [reconcileButton, settingsButton, addButton],
    views: views.element, start: tabs, controls, controlsAt: 'end', end: find.element, line: true, sticky: true,
  });
  const [title, ...top] = listTop.nodes;
  const frame = listFrame(main, host);
  main.append(title, alerts.element, ...top, frame.element);

  async function send(path, method, payload, done = 'Saved.') {
    try {
      const body = await flow(path, { method, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      if (done) toast(done, 'success');
      return body;
    } catch (error) {
      toast(error.message, 'danger');
      return null;
    }
  }

  const findingText = (f) => {
    const name = systemName(f.system);
    if (f.kind === 'price') return `${name} price is ${money(f.other)}. Flow price is ${money(f.flow)}.`;
    if (f.kind === 'tax') return `${name} tax is ${TAX_LABELS[f.other] ?? f.other}. Flow tax is ${TAX_LABELS[f.flow] ?? f.flow}.`;
    if (f.kind === 'missing') return `${name} no longer has ${f.externalCode ?? 'the linked record'}.`;
    return `${name} has no item with this code.`;
  };

  // The dialog for a new code (item null) or an existing one.
  async function edit(item, draft = item) {
    const field = (label, control) => h('div', { class: 'fx-field' }, h('span', { class: 'fx-label' }, label), control);
    const code = h('input', { class: 'fx-input', required: true, maxlength: '30', value: draft?.code ?? '', 'aria-label': 'Code' });
    const name = h('input', { class: 'fx-input', required: true, maxlength: '200', value: draft?.name ?? '', 'aria-label': 'Name' });
    const price = h('input', { class: 'fx-input', required: true, inputmode: 'decimal', value: draft ? (draft.unitAmountCents / 100).toFixed(2) : '', 'aria-label': 'Price' });
    const tax = h('select', { class: 'fx-select', 'aria-label': 'Tax' }, Object.entries(TAX_LABELS).map(([value, label]) => h('option', { value }, label)));
    tax.value = draft?.taxCode ?? 'GST';
    const account = h('input', { class: 'fx-input', maxlength: '20', value: draft?.accountCode ?? '', 'aria-label': 'Account code', placeholder: 'Optional' });
    const description = h('input', { class: 'fx-input', maxlength: '1000', value: draft?.description ?? '', 'aria-label': 'Invoice text', placeholder: 'Optional' });

    let action = null;
    const button = (label, value, extra = '') => {
      const b = h('button', { class: `fx-btn fx-btn--ghost fx-btn--sm ${extra}`, type: 'button' }, label);
      b.addEventListener('click', () => { action = value; b.closest('dialog').close(); });
      return b;
    };
    const parts = [
      field('Code', code), field('Name', name), field('Price, before tax', price), field('Tax', tax),
      field('Invoice text', description), field('Account code', account),
    ];
    if (item) {
      const findings = item.findings ?? [];
      if (findings.length) {
        parts.push(field('Differences', h('div', { class: 'fx-fields' },
          ...findings.map((f) => h('span', { class: 'fx-dim' }, findingText(f))),
          button('Mark resolved', { kind: 'resolve' }))));
      }
      if (item.links.length) {
        parts.push(field('Links', h('div', { class: 'fx-fields' }, ...item.links.map((l) => h('div', { class: 'fx-rule__value' },
          h('span', { class: 'fx-dim' }, `${systemName(l.system)} · ${l.externalCode ?? l.externalId}${l.record ? ` · ${l.record.name ?? ''} · ${money(l.record.unitAmountCents)}` : ''}`),
          button('Remove', { kind: 'unlink', id: l.id }))))));
      }
      parts.push(button(item.archivedAt ? 'Bring back' : 'Archive code', { kind: 'archive', archived: !item.archivedAt }, item.archivedAt ? '' : 'fx-rule__delete'));
    }
    const ok = await dialog({ title: item ? `Edit ${item.code}` : 'New code', body: h('div', { class: 'fx-fields fx-rule__dialog' }, ...parts), confirm: item ? 'Save' : 'Add code' });

    if (action?.kind === 'resolve') {
      const body = await send(`/api/invoicing/price-items/${item.id}/resolve`, 'POST', {}, null);
      if (body) toast(body.state === 'agree' ? 'Prices agree now.' : 'Marked resolved.', 'success');
      alerts.refresh();
      return load();
    }
    if (action?.kind === 'unlink') {
      if (await send(`/api/invoicing/price-links/${action.id}`, 'DELETE', null, 'Link removed.')) return load();
      return null;
    }
    if (action?.kind === 'archive') {
      if (await send(`/api/invoicing/price-items/${item.id}/archive`, 'POST', { archived: action.archived }, action.archived ? 'Archived.' : 'Brought back.')) return load();
      return null;
    }
    if (!ok) return null;
    const payload = {
      code: code.value, name: name.value, unitAmountCents: toCents(price.value), taxCode: tax.value,
      accountCode: account.value || null, description: description.value || null,
    };
    if (!Number.isInteger(payload.unitAmountCents) || payload.unitAmountCents < 0) {
      toast('Write the price as a number, for example 55.00.', 'danger');
      return edit(item, { ...payload, unitAmountCents: 0 });
    }
    const body = item
      ? await send(`/api/invoicing/price-items/${item.id}`, 'PUT', payload)
      : await send('/api/invoicing/price-items', 'POST', payload);
    if (!body) return edit(item, payload);
    return load();
  }

  // The price list's settings: one dialog from the head's settings icon.
  async function openSettings() {
    const select = h('select', { class: 'fx-select', 'aria-label': 'Invoice line price', disabled }, LINE_PRICES.map((p) => h('option', { value: p.value }, p.label)));
    let saved = 'work';
    try {
      const { automations } = await flow('/api/invoicing/automations');
      saved = automations.find((a) => a.key === 'map_lines')?.config.linePrice ?? 'work';
    } catch { /* the default shows */ }
    select.value = saved;
    const ok = await dialog({
      title: 'Price list settings',
      body: h('div', { class: 'fx-fields' }, h('label', { class: 'fx-field' }, h('span', { class: 'fx-label' }, 'Invoice line price'), select)),
      confirm: 'Save',
    });
    if (ok && select.value !== saved) await send('/api/invoicing/automations/map_lines', 'PUT', { config: { linePrice: select.value } });
  }

  // A group's name: a choice's label, or Yes / No.
  const groupLabel = (item) => {
    const value = priceValue(item, view.group);
    if (view.group === 'tax') return taxName(value);
    if (view.group === 'linked') return value.length ? value.map(systemName).join(', ') : 'Not linked';
    return value ? 'Differs' : 'Agrees';
  };

  function draw() {
    drawControls();
    const words = query.trim().toLowerCase();
    const live = data.items.filter((i) => !i.archivedAt);
    const archived = data.items.filter((i) => i.archivedAt);
    const kept = filterJobs(tab === 'archived' ? archived : live, view, { valueOf: priceValue, kindOf, late: null, today: today() })
      .filter((i) => !words || `${i.code} ${i.name}`.toLowerCase().includes(words));
    const shown = sortJobs(kept, view, (item, by) => {
      const value = priceValue(item, by);
      return typeof value === 'string' ? value.toLowerCase() : value;
    });
    const todo = data.systems.length ? reconcileRows(data).length : 0;
    reconcileButton.hidden = !data.systems.length;
    reconcileButton.title = todo ? `Reconcile: ${todo} to check` : 'Reconcile';
    frame.count(`${shown.length} ${shown.length === 1 ? 'code' : 'codes'}`);
    tabs.replaceChildren(...[['active', 'Active', live.length], ['archived', 'Archived', archived.length]].map(([id, label, count]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; draw(); },
    }, label, h('span', { class: 'fx-tabs__count' }, String(count)))));

    if (!shown.length) {
      host.replaceChildren(h('p', { class: 'fx-empty' }, words || view.groups.length ? 'No code matches.' : tab === 'archived' ? 'No archived codes.' : 'No codes yet.'));
    } else {
      const columns = view.columns.map((id) => ({ id, label: PRICE_COLUMNS[id], ...COLUMN_DEFS[id] }));
      const itemRow = (item) => h('tr', { class: 'fx-row-link', tabindex: '0', onclick: () => edit(item), onkeydown: (event) => { if (event.key === 'Enter') edit(item); } },
        rowCells(h, columns, item),
        h('td', { class: 'fx-c-end' }));
      const groups = view.group === 'none' ? [{ label: null, jobs: shown }] : groupJobs(shown, [], groupLabel)
        .sort((x, y) => x.label.localeCompare(y.label) * (view.groupDir === 'desc' ? -1 : 1));
      const head = ({ label, jobs }) => groupHead(h, {
        label: `${label}, ${jobs.length} ${jobs.length === 1 ? 'code' : 'codes'}`,
        badge: h('span', { class: 'fx-strong' }, label, ' ', h('span', { class: 'fx-tabs__count' }, String(jobs.length))),
        open: !folded.has(label), onFold: () => { if (folded.has(label)) folded.delete(label); else folded.add(label); draw(); },
        span: columns.length + 1,
      });
      host.replaceChildren(heads.table({
        className: 'fx-table--rows fx-price__table', columns,
        rows: groups.map((g) => h('tbody', {}, g.label == null ? null : head(g), g.label != null && folded.has(g.label) ? null : g.jobs.map(itemRow))),
      }));
    }
    // Opened from Reconcile's "Edit code": that code's dialog, once.
    if (opened) {
      const item = data.items.find((i) => i.id === opened);
      opened = null;
      window.history.replaceState(null, '', '/price-list');
      if (item) edit(item);
    }
  }
  // Folded groups, for this visit.
  const folded = new Set();

  async function load() {
    try {
      data = await flow('/api/invoicing/price-list');
    } catch (error) {
      host.replaceChildren(notice(error.message, 'danger'));
      return;
    }
    draw();
  }

  await load();
}
