// Settings, Invoicing, "Price codes" (server/core/line-mapping.js,
// /api/invoicing/line-labels and /line-mappings). Each work system line label
// that found no price item is one row: its text, its price, the jobs it holds
// back, and a menu of the lab's price items. A choice saves at once as a saved
// mapping for that label at that price, and the next pipeline run maps every
// job that has it. Everyone can read them; an owner or admin chooses. The
// caller passes in app.js's shared pieces as `ui`.

const money = (cents) => (cents === null || cents === undefined ? '' : `$${(cents / 100).toFixed(2)}`);

export function lineMappingSection(ui) {
  const { h, flow, toast, notice, me } = ui;
  const disabled = !['owner', 'admin'].includes(me?.person.role);
  const body = h('div', {}, h('div', { class: 'fx-skeleton' }));
  const section = h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, 'Price codes'), body);

  const row = (name, hint, control) => h('div', { class: 'fx-set__row' },
    h('div', { class: 'fx-set__text' }, h('span', { class: 'fx-set__name' }, name), h('span', { class: 'fx-set__hint' }, hint)),
    h('div', { class: 'fx-set__control' }, control));

  async function load() {
    let labels;
    let items;
    try {
      [{ labels }, { priceItems: items }] = await Promise.all([flow('/api/invoicing/line-labels'), flow('/api/invoicing/price-items')]);
    } catch (error) {
      body.replaceChildren(notice(error.message, 'danger'));
      return;
    }
    const waiting = labels.filter((l) => l.unmapped > 0);
    const listLink = row('Price list', 'Your codes and prices, and their links.', h('a', { class: 'fx-btn fx-btn--ghost fx-btn--sm', href: '/price-list', onclick: (event) => ui.go(event) }, 'Open'));
    if (!waiting.length) {
      body.replaceChildren(row('Every line has a price code', 'Lines from Seazona find their price item by themselves.', h('span', { class: 'fx-dim' }, '')), listLink);
      return;
    }
    const options = [h('option', { value: '' }, 'Choose a price item…'),
      ...items.map((i) => h('option', { value: i.code }, `${i.code} · ${i.name} · ${money(i.unitAmountCents)}`))];
    body.replaceChildren(...waiting.map((label) => {
      const select = h('select', { class: 'fx-select', 'aria-label': `Price item for ${label.sample}`, disabled }, options.map((o) => o.cloneNode(true)));
      select.addEventListener('change', async () => {
        if (!select.value) return;
        select.disabled = true;
        try {
          await flow('/api/invoicing/line-mappings', {
            method: 'POST',
            body: JSON.stringify({ kind: 'saved', label: label.label, unitAmountCents: label.unitAmountCents ?? 0, itemCode: select.value }),
          });
          toast('Saved. Jobs with this line update in a few minutes.', 'success');
          await load();
        } catch (error) {
          toast(error.message, 'danger');
          select.disabled = disabled;
        }
      });
      const lines = label.unmapped === 1 ? '1 line waits' : `${label.unmapped} lines wait`;
      return row(label.sample, `${money(label.unitAmountCents)} · ${lines}`, select);
    }), listLink);
  }
  load();
  return section;
}
