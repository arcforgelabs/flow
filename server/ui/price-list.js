// Settings, Price list (/price-list; server/core/price-list.js,
// docs/PRICE_LIST.md). Flow's own codes and prices, which work with no
// integration connected. Each row is one code: its name, its price and tax,
// and a chip for each connected system (Xero, Seazona) that says whether that
// system's record agrees. Edit opens a dialog with the code's fields, its
// links and, when something differs, Mark resolved. Below the list, each
// system's records that link to no code, with a menu to link each one, and
// the line price setting. Everyone can read it; an owner or admin changes it.
// The caller passes in app.js's shared pieces as `ui`.
import { alertStrip } from '/assets/ui/alerts.js';

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
  const host = h('div', { class: 'fx-card', style: { padding: '8px 20px 16px' } }, h('div', { class: 'fx-skeleton' }));
  const addButton = h('button', { class: 'fx-btn fx-btn--primary', type: 'button', disabled }, 'Add code');
  const checkButton = h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', disabled }, 'Check prices');
  const alerts = alertStrip(ui, 'price-list');
  main.append(pageHeader('Price list', { subtitle: 'The codes and prices that Flow puts on invoice lines.', actions: [checkButton, addButton] }), alerts.element, host);

  let data = null;
  let query = '';
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

  // One chip for each connected system: agrees, differs (with its price), or
  // has no record for this code.
  function chips(item) {
    return data.systems.map((system) => {
      const mine = item.findings.filter((f) => f.system === system.id);
      const linked = item.links.some((l) => l.system === system.id);
      if (mine.some((f) => f.kind === 'not_linked')) return h('span', { class: 'fx-status', 'data-tone': 'warn' }, `Not in ${system.name}`);
      if (!linked) return null;
      const price = mine.find((f) => f.kind === 'price');
      if (price) return h('span', { class: 'fx-status', 'data-tone': 'danger' }, `${system.name} ${money(price.other)}`);
      if (mine.some((f) => f.kind === 'tax')) return h('span', { class: 'fx-status', 'data-tone': 'danger' }, `${system.name} tax`);
      if (mine.some((f) => f.kind === 'missing')) return h('span', { class: 'fx-status', 'data-tone': 'danger' }, `${system.name} removed`);
      return h('span', { class: 'fx-status', 'data-tone': 'success' }, system.name);
    }).filter(Boolean);
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

  // A system's record that links to no code: a menu of codes to link it to,
  // or "New code" to add it to the list as it is.
  function unlinkedRow(system, record, items) {
    const select = h('select', { class: 'fx-select fx-price__link', 'aria-label': `Code for ${record.name ?? record.code}`, disabled },
      h('option', { value: '' }, 'Link to a code…'),
      h('option', { value: 'new' }, 'Add as a new code'),
      ...items.filter((i) => !i.archivedAt).map((i) => h('option', { value: i.id }, `${i.code} · ${i.name} · ${money(i.unitAmountCents)}`)));
    select.addEventListener('change', async () => {
      if (!select.value) return;
      select.disabled = true;
      let itemId = select.value;
      if (itemId === 'new') {
        const made = await send('/api/invoicing/price-items', 'POST', {
          code: record.code || record.id, name: record.name || record.code || record.id,
          unitAmountCents: record.unitAmountCents ?? 0, taxCode: record.taxCode ?? 'GST',
        }, null);
        itemId = made?.item.id ?? null;
      }
      if (itemId && await send(`/api/invoicing/price-items/${itemId}/links`, 'POST', { system: system.id, externalId: record.id }, 'Linked. Jobs with this item update in a few minutes.')) return load();
      select.disabled = disabled;
      select.value = '';
      return null;
    });
    const hint = [record.code, money(record.unitAmountCents), TAX_LABELS[record.taxCode]].filter(Boolean).join(' · ');
    return row(record.name ?? record.code ?? record.id, h('span', { class: 'fx-set__hint' }, hint), select);
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
    const shown = data.items.filter((i) => !words || `${i.code} ${i.name}`.toLowerCase().includes(words));
    const live = shown.filter((i) => !i.archivedAt);
    const archived = shown.filter((i) => i.archivedAt);
    const itemRow = (item) => {
      const editButton = h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', disabled }, 'Edit');
      editButton.addEventListener('click', () => edit(item));
      const hint = h('span', { class: 'fx-set__hint' }, `${money(item.unitAmountCents)} · ${TAX_LABELS[item.taxCode] ?? item.taxCode}`);
      return row(`${item.code} · ${item.name}`, h('div', { class: 'fx-price__hint' }, hint, ...chips(item)), editButton);
    };
    const search = h('input', { class: 'fx-input fx-search', type: 'search', placeholder: 'Find a code', value: query, 'aria-label': 'Find a code' });
    search.addEventListener('input', () => { query = search.value; draw(); search.focus(); search.setSelectionRange(query.length, query.length); });
    const systems = data.systems.length
      ? h('div', { class: 'fx-price__systems' }, ...data.systems.map((s) => h('span', { class: 'fx-chip fx-chip--static' }, `${s.name} · ${s.count} ${s.kind === 'accounting' ? 'items' : 'products'}`)))
      : h('p', { class: 'fx-dim' }, 'No integration has a price list. Flow uses this list alone.');
    const sections = [
      disabled ? notice('Only an owner or admin can change these.', 'info') : null,
      h('section', { class: 'fx-set' }, h('div', { class: 'fx-price__head' }, h('h2', { class: 'fx-set__title' }, `Codes · ${data.items.filter((i) => !i.archivedAt).length}`), search), systems,
        ...(live.length ? live.map(itemRow) : [h('p', { class: 'fx-dim' }, words ? 'No code matches.' : 'No codes yet. Add the first one.')])),
    ];
    for (const { system: id, records } of data.unlinked) {
      if (!records.length) continue;
      const system = data.systems.find((s) => s.id === id);
      sections.push(h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, `${system.name} · not on the list · ${records.length}`),
        ...records.slice(0, 200).map((r) => unlinkedRow(system, r, data.items)),
        records.length > 200 ? h('p', { class: 'fx-dim' }, `${records.length - 200} more. Link these first.`) : null));
    }
    if (archived.length) {
      sections.push(h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, `Archived · ${archived.length}`), ...archived.map(itemRow)));
    }
    const settings = h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, 'Invoice lines'), h('div', { class: 'fx-skeleton' }));
    linePriceRow().then((r) => settings.replaceChildren(settings.firstChild, r,
      h('p', { class: 'fx-dim', style: { margin: '8px 0 0' } }, h('a', { href: DOCS, target: '_blank', rel: 'noopener' }, 'How the price list works'))));
    sections.push(settings);
    host.replaceChildren(...sections.filter(Boolean));
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
  checkButton.addEventListener('click', async () => {
    checkButton.disabled = true;
    const body = await send('/api/invoicing/price-list/check', 'POST', {}, null);
    if (body) toast(body.summary.differing ? `${body.summary.differing} codes differ.` : 'Every linked price agrees.', body.summary.differing ? 'info' : 'success');
    checkButton.disabled = disabled;
    alerts.refresh();
    await load();
  });
  await load();
}
