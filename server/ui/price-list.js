// Settings, Price list (/price-list; server/core/price-list.js,
// docs/PRICE_LIST.md). Flow's own codes and prices, which work with no
// integration connected: one table row per code, with its price and tax, and
// the line price setting below. Edit opens a dialog with the code's fields, its
// links and, when something differs, Mark resolved. While an integration with
// its own price list is on, Reconcile (price-reconcile.js) says how many
// records need a person and opens the work. Everyone can read it; an owner or
// admin changes it. The caller passes in app.js's shared pieces as `ui`.
import { alertStrip } from '/assets/ui/alerts.js';
import { reconcileRows } from '/assets/ui/price-match.js';

const DOCS = 'https://github.com/arcforgelabs/flow/blob/main/docs/PRICE_LIST.md';
const TAX_LABELS = { GST: 'GST', GST_FREE: 'GST free' };
const LINE_PRICES = [
  { value: 'work', label: 'Work system amount' },
  { value: 'list', label: 'Price list' },
];

const money = (cents) => (cents === null || cents === undefined ? '' : `$${(cents / 100).toFixed(2)}`);
const toCents = (text) => {
  const value = Number(String(text ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(value) ? Math.round(value * 100) : NaN;
};

export async function renderPriceList(main, ui) {
  const { h, flow, toast, notice, dialog, pageHeader, me } = ui;
  const disabled = !['owner', 'admin'].includes(me?.person.role);
  const host = h('div', { class: 'fx-price' }, h('div', { class: 'fx-skeleton' }));
  const addButton = h('button', { class: 'fx-btn fx-btn--primary', type: 'button', disabled }, 'Add code');
  const reconcileButton = h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', hidden: true, onclick: () => ui.go('/price-list/reconcile') }, 'Reconcile');
  const alerts = alertStrip(ui, 'price-list');
  main.append(pageHeader('Price list', { subtitle: 'The codes and prices that Flow puts on invoice lines.', actions: [reconcileButton, addButton] }), alerts.element, host);

  let data = null;
  let query = '';
  let tab = 'active';
  let opened = new URLSearchParams(location.search).get('code');
  const systemName = (id) => data.systems.find((s) => s.id === id)?.name ?? id;

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

  const row = (name, hint, control) => h('div', { class: 'fx-set__row' },
    h('div', { class: 'fx-set__text' }, h('span', { class: 'fx-set__name' }, name), hint),
    h('div', { class: 'fx-set__control fx-rule__controls' }, control));

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

  async function linePriceRow() {
    const select = h('select', { class: 'fx-select', 'aria-label': 'Line price from', disabled }, LINE_PRICES.map((p) => h('option', { value: p.value }, p.label)));
    try {
      const { automations } = await flow('/api/invoicing/automations');
      select.value = automations.find((a) => a.key === 'map_lines')?.config.linePrice ?? 'work';
    } catch {
      select.value = 'work';
    }
    let saved = select.value;
    select.addEventListener('change', async () => {
      select.disabled = true;
      if (await send('/api/invoicing/automations/map_lines', 'PUT', { config: { linePrice: select.value } })) saved = select.value;
      else select.value = saved;
      select.disabled = disabled;
    });
    return row('Line price from', h('span', { class: 'fx-set__hint' }, 'Where an invoice line takes its price.'), select);
  }

  function draw() {
    const words = query.trim().toLowerCase();
    const live = data.items.filter((i) => !i.archivedAt);
    const archived = data.items.filter((i) => i.archivedAt);
    const shown = (tab === 'archived' ? archived : live).filter((i) => !words || `${i.code} ${i.name}`.toLowerCase().includes(words));
    const todo = data.systems.length ? reconcileRows(data).length : 0;
    reconcileButton.hidden = !data.systems.length;
    reconcileButton.replaceChildren('Reconcile', todo ? h('span', { class: 'fx-tabs__count', 'data-tone': 'warn' }, String(todo)) : null);
    reconcileButton.title = todo ? `${todo} records need a person` : 'Every record has a code, and every price agrees';

    const search = h('input', { class: 'fx-input fx-search', type: 'search', placeholder: 'Find a code', value: query, 'aria-label': 'Find a code' });
    search.addEventListener('input', () => { query = search.value; draw(); search.focus(); search.setSelectionRange(query.length, query.length); });
    const tabs = h('div', { class: 'fx-tabs', role: 'tablist' }, [['active', 'Active', live.length], ['archived', 'Archived', archived.length]].map(([id, label, count]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; draw(); },
    }, label, h('span', { class: 'fx-tabs__count' }, String(count)))));
    const itemRow = (item) => h('tr', { onclick: () => edit(item), tabindex: '0', onkeydown: (event) => { if (event.key === 'Enter') edit(item); } },
      h('td', { class: 'fx-price__code' }, item.code),
      h('td', {}, item.name),
      h('td', { class: 'fx-num' }, money(item.unitAmountCents)),
      h('td', { class: 'fx-dim' }, TAX_LABELS[item.taxCode] ?? item.taxCode));
    const table = shown.length
      ? h('div', { class: 'fx-price__scroll' }, h('table', { class: 'fx-table fx-table--rows fx-price__table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Code'), h('th', {}, 'Name'), h('th', { class: 'fx-num' }, 'Price'), h('th', {}, 'Tax'))),
        h('tbody', {}, shown.map(itemRow))))
      : h('p', { class: 'fx-empty' }, words ? 'No code matches.' : tab === 'archived' ? 'No archived codes.' : 'No codes yet. Add the first one.');
    const sections = [
      disabled ? notice('Only an owner or admin can change these.', 'info') : null,
      h('div', { class: 'fx-toolbar fx-price__head' }, tabs, search),
      table,
    ];
    const settings = h('section', { class: 'fx-set fx-price__settings' }, h('h2', { class: 'fx-set__title' }, 'Invoice lines'), h('div', { class: 'fx-skeleton' }));
    linePriceRow().then((r) => settings.replaceChildren(settings.firstChild, r,
      h('p', { class: 'fx-dim', style: { margin: '8px 0 0' } }, h('a', { href: DOCS, target: '_blank', rel: 'noopener' }, 'How the price list works'))));
    sections.push(settings);
    host.replaceChildren(...sections.filter(Boolean));
    // Opened from Reconcile's "Edit code": that code's dialog, once.
    if (opened) {
      const item = data.items.find((i) => i.id === opened);
      opened = null;
      window.history.replaceState(null, '', '/price-list');
      if (item) edit(item);
    }
  }

  async function load() {
    try {
      data = await flow('/api/invoicing/price-list');
    } catch (error) {
      host.replaceChildren(notice(error.message, 'danger'));
      return;
    }
    draw();
  }

  addButton.addEventListener('click', () => edit(null));
  await load();
}
