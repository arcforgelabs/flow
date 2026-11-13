// Settings, Rules, "Price codes" (server/core/line-mapping.js,
// /api/invoicing/line-labels and /line-mappings). Each group of work system
// lines that found no price item is one row: its text, its work system code,
// its own price, the lines and jobs it holds back, and a menu of the lab's
// price items. A row whose code is a product of the work system links that
// product to the price item (the price list's link), so its lines map at
// every price. A row with no product (a free-text line) saves the choice for
// that label at that price. Everyone can read them; an owner or admin chooses.
// Every row and every error has "Copy prompt" for a connected agent. The
// caller passes in app.js's shared pieces as `ui`.

import { priceCodePrompt } from '/assets/ui/problem-prompt.js';

const money = (cents) => (cents === null || cents === undefined ? '' : `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`);
const PLACEHOLDER = '__placeholder';
const count = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

// The line under a waiting row's name: its code, its price and what it holds.
export function waitingHint(line) {
  const listPrice = line.product?.unitAmountCents ?? null;
  const held = line.jobs === null || line.jobs === undefined
    ? (line.lines === 1 ? '1 line waits' : `${line.lines} lines wait`)
    : `${count(line.lines, 'line', 'lines')} on ${count(line.jobs, 'job', 'jobs')}, ${line.jobsToInvoice ? `${line.jobsToInvoice} to invoice` : 'all invoiced'}`;
  return [
    line.code ? `Code ${line.code}` : null,
    listPrice !== null && listPrice !== line.unitAmountCents ? `${money(line.unitAmountCents)} on the job, list ${money(listPrice)}` : money(line.unitAmountCents),
    held,
  ].filter(Boolean).join(' · ');
}

export function lineMappingSection(ui) {
  const { h, flow, toast, notice, me, settingRow, copyButton } = ui;
  const disabled = !['owner', 'admin'].includes(me?.person.role);
  const body = h('div', {}, h('div', { class: 'fx-skeleton' }));
  const section = h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, 'Price codes'), body);

  const row = (label, hint, control) => settingRow({ label, hint, control });
  const copy = (facts) => copyButton({
    label: 'Copy prompt', copied: 'Prompt copied. Paste it to your agent.',
    text: () => priceCodePrompt({ origin: location.origin, ...facts }),
  });
  // An error stays on the page, in red, with its own "Copy prompt".
  const failed = (error, action, line = null) => h('div', { class: 'fx-offer' },
    notice(error.message, 'danger', `${action} did not work.`),
    copy({ row: line, action, error: { status: error.status, code: error.code, message: error.message } }));

  async function load() {
    let waiting;
    let items;
    try {
      [{ waiting }, { priceItems: items }] = await Promise.all([flow('/api/invoicing/line-labels'), flow('/api/invoicing/price-items')]);
    } catch (error) {
      body.replaceChildren(failed(error, 'Read the lines that wait'));
      return;
    }
    const listLink = row('Price list', 'Your codes and prices, and their links.', h('a', { class: 'fx-btn fx-btn--ghost fx-btn--sm', href: '/price-list', onclick: (event) => ui.go(event) }, 'Open'));
    if (!waiting.length) {
      body.replaceChildren(row('Every line has a price code', 'Lines from Seazona find their price item by themselves.', h('span', { class: 'fx-dim' }, '')), listLink);
      return;
    }
    const options = [h('option', { value: '' }, 'Choose a price item…'),
      ...items.map((i) => h('option', { value: i.id }, `${i.code} · ${i.name} · ${money(i.unitAmountCents)}`))];
    body.replaceChildren(...waiting.map((line) => {
      // A $0.00 line can be a placeholder: a line the lab adds only to open the job.
      const own = options.map((o) => o.cloneNode(true));
      if (line.unitAmountCents === 0) own.splice(1, 0, h('option', { value: PLACEHOLDER }, 'Placeholder: leave it off the invoice'));
      const select = h('select', { class: 'fx-select', 'aria-label': `Price item for ${line.sample}`, disabled }, own);
      const problem = h('div', {});
      select.addEventListener('change', async () => {
        const placeholder = select.value === PLACEHOLDER;
        const item = items.find((i) => i.id === select.value);
        if (!item && !placeholder) return;
        select.disabled = true;
        const action = placeholder ? 'Save the placeholder' : line.product ? 'Link the product' : 'Save the price code';
        try {
          if (placeholder) {
            const { automations } = await flow('/api/invoicing/automations');
            const now = automations.find((a) => a.key === 'map_lines')?.config?.placeholders ?? [];
            await flow('/api/invoicing/automations/map_lines', {
              method: 'PUT',
              body: JSON.stringify({ config: { placeholders: [...now, { label: line.label, unitAmountCents: line.unitAmountCents }] } }),
            });
            toast('Saved. Flow leaves this line off each invoice from the next sync.', 'success');
          } else if (line.product) {
            await flow('/api/invoicing/price-links', {
              method: 'POST',
              body: JSON.stringify({ links: [{ priceItemId: item.id, system: line.product.system, externalId: line.product.externalId }] }),
            });
            toast(`Linked to ${item.code}. Lines of this product update in a few minutes, at every price.`, 'success');
          } else {
            await flow('/api/invoicing/line-mappings', {
              method: 'POST',
              body: JSON.stringify({ kind: 'saved', label: line.label, unitAmountCents: line.unitAmountCents ?? 0, itemCode: item.code }),
            });
            toast('Saved. Jobs with this line update in a few minutes.', 'success');
          }
          await load();
        } catch (error) {
          problem.replaceChildren(failed(error, action, line));
          select.value = '';
          select.disabled = disabled;
        }
      });
      return h('div', {}, row(line.sample, waitingHint(line), h('div', { class: 'fx-offer' }, select, copy({ row: line }))), problem);
    }), listLink);
  }
  load();
  return section;
}
