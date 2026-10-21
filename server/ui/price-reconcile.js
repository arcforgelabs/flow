// Price list › Reconcile (/price-list/reconcile). Only while an integration
// with its own price list is on (Xero items, Seazona products). It lays the
// connected systems' records against Flow's own codes, in the two views of
// Xero › Import › Review:
//   card  one record beside its likely Flow code, one fact per row, ✓ or ≠
//         between them; the invoice pager steps through them. Link, Other
//         match, Find a code, Add as new code, Skip.
//   list  every record and code to check, ticked rows acted on together from
//         the bulk bar.
// A record with no link offers likely codes (price-match.js). A code that
// differs from its linked record is an alert only: Mark resolved, or fix it
// at its source. It reads Flow's copies only: no call to Xero or Seazona.
// The price check itself runs on each pipeline pass, so there is no button.
import { bulkBar } from '/assets/ui/bulk-bar.js';
import { lucide } from '/assets/ui/custom-fields.js';
import { findCodes, nameScore, reconcileRows, SAME_NAME } from '/assets/ui/price-match.js';

const TAX_LABELS = { GST: 'GST', GST_FREE: 'GST free' };
const money = (cents) => (cents === null || cents === undefined ? '—' : `$${(cents / 100).toFixed(2)}`);
const taxWords = (code) => (code ? TAX_LABELS[code] ?? code : '—');
const LOGOS = { xero: '/assets/ui/logos/xero.svg', seazona: '/assets/ui/logos/seazona.svg' };

export async function renderPriceReconcile(main, ui) {
  const { h, flow, toast } = ui;
  const canAct = ['owner', 'admin'].includes(ui.me?.person?.role);
  const icon = (name, label) => lucide(h, name, label);
  let view = new URLSearchParams(location.search).get('view') === 'list' ? 'list' : 'card';
  const host = h('div', { class: 'fx-xi fx-prc' }, h('p', { class: 'fx-dim' }, 'Loading…'));
  const tally = h('span', {});
  const toggle = (name, label, glyph) => h('button', {
    class: 'fx-xi__view', type: 'button', role: 'tab', 'aria-selected': String(view === name), 'aria-label': label, title: label, 'data-view': name,
    onclick: () => setView(name),
  }, icon(glyph));
  const bulk = bulkBar(ui, { label: 'Ticked records' });
  main.append(
    h('nav', { class: 'fx-crumbs', 'aria-label': 'Breadcrumb' },
      h('a', { href: '/price-list', onclick: (event) => ui.go(event) }, 'Price list'), h('span', { 'aria-hidden': 'true' }, '›'), h('span', {}, 'Reconcile')),
    ui.pageHeader('Reconcile prices', {
      count: tally,
      actions: [h('div', { class: 'fx-xi__views', role: 'tablist', 'aria-label': 'View' }, toggle('card', 'One at a time', 'square'), toggle('list', 'List, tick many', 'list-checks'))],
    }),
    host, bulk.element);

  let data = null;
  let rows = [];
  let at = 0;
  let pick = 0;
  let chosen = null;

  function setView(name) {
    view = name;
    window.history.replaceState(null, '', view === 'list' ? '/price-list/reconcile?view=list' : '/price-list/reconcile');
    for (const b of main.querySelectorAll('.fx-xi__view')) b.setAttribute('aria-selected', String(b.dataset.view === view));
    draw();
  }

  async function load() {
    try {
      data = await flow('/api/invoicing/price-list');
    } catch (error) {
      host.replaceChildren(h('p', { class: 'fx-empty' }, error.message));
      return;
    }
    rows = reconcileRows(data);
    at = Math.min(at, Math.max(0, rows.length - 1));
    draw();
  }

  async function call(path, method, payload) {
    try {
      return await flow(path, { method, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    } catch (error) {
      toast(error.message, 'danger');
      return null;
    }
  }

  // Links many records at once: one call, one remap. An accounting system
  // takes one record for each code, so a second record for the same code
  // waits for a person.
  async function linkMany(pairs) {
    const seen = new Set();
    const links = [];
    for (const { row, item } of pairs) {
      const key = `${row.system.id}:${item.id}`;
      if (row.system.kind === 'accounting' && seen.has(key)) continue;
      seen.add(key);
      links.push({ priceItemId: item.id, system: row.system.id, externalId: String(row.record.id) });
    }
    if (!links.length) return 0;
    const body = await call('/api/invoicing/price-links', 'POST', { links });
    return body?.linked ?? 0;
  }

  const newCodeOf = (record) => ({
    code: String(record.code || record.id).slice(0, 30), name: String(record.name || record.code || record.id).slice(0, 200),
    unitAmountCents: record.unitAmountCents ?? 0, taxCode: record.taxCode ?? 'GST',
  });

  async function addAsNew(row) {
    const draft = newCodeOf(row.record);
    const input = (name, value, label, extra = {}) => h('label', { class: 'fx-field' }, h('span', { class: 'fx-label' }, label),
      h('input', { class: 'fx-input', name, value, required: true, ...extra }));
    const tax = h('select', { class: 'fx-select', name: 'taxCode' }, Object.entries(TAX_LABELS).map(([value, label]) => h('option', { value, selected: value === draft.taxCode }, label)));
    const form = await ui.dialog({
      title: 'Add as new code',
      body: h('div', { class: 'fx-fields' },
        input('code', draft.code, 'Code', { maxlength: '30' }), input('name', draft.name, 'Name', { maxlength: '200' }),
        input('price', (draft.unitAmountCents / 100).toFixed(2), 'Price, before tax', { inputmode: 'decimal' }),
        h('label', { class: 'fx-field' }, h('span', { class: 'fx-label' }, 'Tax'), tax)),
      confirm: 'Add and link',
    });
    if (!form) return;
    const cents = Math.round(Number(String(form.get('price')).replace(/[$,\s]/g, '')) * 100);
    if (!Number.isInteger(cents) || cents < 0) { toast('Write the price as a number, for example 55.00.', 'danger'); return; }
    const made = await call('/api/invoicing/price-items', 'POST', { code: form.get('code'), name: form.get('name'), unitAmountCents: cents, taxCode: form.get('taxCode') });
    if (!made) return;
    if (await linkMany([{ row, item: made.item }])) toast(`Added ${made.item.code} and linked.`, 'success');
    await load();
  }

  async function resolve(row) {
    const body = await call(`/api/invoicing/price-items/${row.item.id}/resolve`, 'POST', {});
    if (body) toast(body.state === 'agree' ? 'Prices agree now.' : 'Marked resolved.', 'success');
    return body;
  }

  function draw() {
    if (!data) return;
    bulk.draw({ count: 0 });
    if (!data.systems.length) {
      tally.replaceChildren('');
      host.replaceChildren(h('p', { class: 'fx-empty' }, 'No integration with a price list is on. Flow uses its own list alone.'),
        h('a', { href: '/price-list', onclick: (event) => ui.go(event) }, '← Price list'));
      return;
    }
    if (!rows.length) {
      tally.replaceChildren('');
      host.replaceChildren(h('div', { class: 'fx-xi__done' }, icon('check-check'), h('p', {}, 'Every record has a code, and every price agrees.'),
        h('a', { href: '/price-list', onclick: (event) => ui.go(event) }, 'Price list')));
      return;
    }
    if (view === 'list') drawList();
    else drawCard();
  }

  const systemMark = (system) => (LOGOS[system.id] ? h('img', { class: 'fx-xi__mark', src: LOGOS[system.id], alt: system.name }) : h('span', { class: 'fx-strong' }, system.name));
  const flowMark = () => h('img', { class: 'fx-xi__mark', src: '/assets/ui/flow-mark.svg', alt: 'Flow' });
  const mark = (state) => (state === 'same' ? h('span', { class: 'fx-xi__agree', 'data-state': 'same' }, icon('equal', 'Same'))
    : state === 'differs' ? h('span', { class: 'fx-xi__agree', 'data-state': 'differs' }, icon('equal-not', 'Different')) : h('span', {}));
  const agree = (left, right) => (left == null || right == null || left === '' ? null : left === right ? 'same' : 'differs');

  // The bulk shortcut above the card: every sure one at once, or the list.
  function bulkStrip() {
    const sure = rows.filter((r) => r.sure);
    return h('div', { class: 'fx-xi__bulk' },
      icon('list-checks'),
      h('span', { class: 'fx-xi__bulk-text' }, `${rows.length} to check`),
      canAct && sure.length ? h('button', { class: 'fx-btn fx-btn--sm fx-btn--primary', type: 'button', onclick: async (event) => {
        event.currentTarget.disabled = true;
        const linked = await linkMany(sure.map((row) => ({ row, item: row.candidates[0].item })));
        if (linked) toast(`${linked} linked.`, 'success');
        await load();
      } }, icon('check-check'), `Link ${sure.length} sure`) : null,
      h('button', { class: 'fx-btn fx-btn--sm', type: 'button', onclick: () => setView('list') }, icon('list-checks'), 'Tick many'));
  }

  // The invoice pager: Back to the price list, "n of N", previous and next.
  function pager() {
    const step = (to, label, path) => {
      const button = h('button', {
        class: 'fx-pager__step', type: 'button', disabled: to < 0 || to >= rows.length, 'aria-label': label, title: label,
        onclick: () => { at = to; pick = 0; chosen = null; drawCard(); },
      });
      button.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      return button;
    };
    return h('nav', { class: 'fx-pager', 'aria-label': 'Records to check' },
      h('button', { class: 'fx-pager__back', type: 'button', onclick: () => ui.go('/price-list') }, '← Back'),
      h('span', { class: 'fx-pager__count' }, `${at + 1} of ${rows.length}`),
      h('span', { class: 'fx-pager__steps' }, step(at - 1, 'Previous', 'M14.5 6l-6 6 6 6'), step(at + 1, 'Next', 'M9.5 6l6 6-6 6')));
  }

  // One record (or one differing code) at a time.
  function drawCard() {
    const row = rows[at];
    tally.replaceChildren(`${rows.length} to check`);
    const next = () => { at = (at + 1) % rows.length; pick = 0; chosen = null; drawCard(); };
    const record = row.record;
    const item = row.kind === 'differs' ? row.item : chosen ?? row.candidates[pick]?.item ?? null;
    const facts = [
      ['hash', 'Code', h('span', { class: 'fx-num' }, record?.code ?? record?.id ?? '—'), h('span', { class: 'fx-num' }, item?.code ?? '—'), null],
      ['tag', 'Name', record?.name ?? '—', item?.name ?? '—', item && record ? (row.kind === 'link' && !chosen ? row.candidates[pick]?.name : null) ?? (record.name && item.name ? (nameScore(record.name, item.name) >= SAME_NAME ? 'same' : 'differs') : null) : null],
      ['dollar-sign', 'Price', h('span', { class: 'fx-num' }, money(record?.unitAmountCents)), h('span', { class: 'fx-num' }, money(item?.unitAmountCents)), item ? agree(record?.unitAmountCents, item.unitAmountCents) : null],
      ['percent', 'Tax', taxWords(record?.taxCode), taxWords(item?.taxCode), item ? agree(record?.taxCode, item.taxCode) : null],
      ['circle-dot', 'Status',
        row.kind === 'link' ? h('span', { class: 'fx-status', 'data-tone': 'warn' }, 'No code') : record ? h('span', { class: 'fx-status', 'data-tone': 'success' }, 'Linked') : h('span', { class: 'fx-status', 'data-tone': 'danger' }, `Not in ${row.system.name}`),
        row.kind === 'link' ? (item ? h('span', { class: 'fx-status', 'data-tone': row.candidates[pick]?.sure && !chosen ? 'success' : 'neutral' }, chosen ? 'Your pick' : row.candidates[pick]?.sure ? 'Sure match' : 'Likely') : h('span', { class: 'fx-dim' }, 'No likely code'))
          : h('span', { class: 'fx-status', 'data-tone': 'warn' }, 'Differs'), null],
    ];
    const table = h('table', { class: 'fx-xi-cmp' },
      h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, systemMark(row.system)), h('th', {}), h('th', {}, flowMark()))),
      h('tbody', {}, facts.map(([glyph, label, left, right, state]) => h('tr', {},
        h('th', { scope: 'row' }, icon(glyph, label)),
        h('td', {}, left), h('td', { class: 'fx-xi-cmp__mid' }, mark(state)), h('td', {}, right)))));

    const acts = [];
    const busy = (button, run) => async () => {
      button.disabled = true;
      try { await run(); } finally { button.disabled = false; }
    };
    if (row.kind === 'link') {
      const count = row.candidates.length;
      if (count > 1 && !chosen) {
        acts.push(h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', title: 'Other match', 'aria-label': 'Other match', onclick: () => { pick = (pick + 1) % count; drawCard(); } },
          icon('arrow-left-right'), `${pick + 1}/${count}`));
      }
      acts.push(h('button', { class: 'fx-btn', type: 'button', onclick: next }, icon('skip-forward'), 'Skip'));
      if (canAct) {
        const add = h('button', { class: 'fx-btn', type: 'button' }, icon('plus'), 'Add as new code');
        add.onclick = busy(add, () => addAsNew(row));
        acts.push(add);
        if (item) {
          const link = h('button', { class: 'fx-btn fx-btn--primary', type: 'button' }, icon('link-2'), 'Link');
          link.onclick = busy(link, async () => {
            if (await linkMany([{ row, item }])) toast(`Linked to ${item.code}.`, 'success');
            pick = 0;
            chosen = null;
            await load();
          });
          acts.push(link);
        }
      }
    } else {
      acts.push(h('button', { class: 'fx-btn', type: 'button', onclick: next }, icon('skip-forward'), 'Skip'));
      acts.push(h('button', { class: 'fx-btn', type: 'button', onclick: () => ui.go(`/price-list?code=${row.item.id}`) }, icon('pencil'), 'Edit code'));
      if (canAct && row.link && !row.record) {
        const unlink = h('button', { class: 'fx-btn', type: 'button' }, icon('unlink'), 'Remove link');
        unlink.onclick = busy(unlink, async () => {
          if (await call(`/api/invoicing/price-links/${row.link.id}`, 'DELETE')) toast('Link removed.', 'success');
          await load();
        });
        acts.push(unlink);
      }
      if (canAct) {
        const done = h('button', { class: 'fx-btn fx-btn--primary', type: 'button' }, icon('check'), 'Mark resolved');
        done.onclick = busy(done, async () => { await resolve(row); await load(); });
        acts.push(done);
      }
    }

    // Find a code: any Flow code by code or name, when no likely one fits.
    const finder = row.kind === 'link' ? (() => {
      const results = h('div', { class: 'fx-prc__found', role: 'listbox', 'aria-label': 'Codes found' });
      const input = h('input', { class: 'fx-input fx-xi__search', type: 'search', autocomplete: 'off', placeholder: 'Find another code: code or name', 'aria-label': 'Find another code' });
      input.addEventListener('input', () => {
        results.replaceChildren(...findCodes(input.value, data.items).map((code) => h('button', {
          class: 'fx-pop__item', type: 'button', role: 'option',
          onclick: () => { chosen = code; drawCard(); },
        }, h('span', { class: 'fx-num' }, code.code), h('span', {}, code.name), h('span', { class: 'fx-dim fx-num' }, money(code.unitAmountCents)))));
      });
      return h('div', { class: 'fx-prc__finder' }, h('div', { class: 'fx-xi__bulk' }, icon('search'), input), results);
    })() : null;

    host.replaceChildren(...[pager(), bulkStrip(), table, finder, h('div', { class: 'fx-xi__acts' }, acts)].filter(Boolean));
  }

  // Every record and code to check; ticked rows go from the bulk bar.
  function drawList() {
    tally.replaceChildren(`${rows.length} to check`);
    const ticked = new Set();
    const boxes = new Map();
    const picked = () => rows.filter((r) => ticked.has(r.key));
    const clear = () => { ticked.clear(); for (const b of boxes.values()) b.checked = false; all.checked = false; drawBar(); };
    const drawBar = () => {
      const chosenRows = picked();
      const linkable = chosenRows.filter((r) => r.kind === 'link' && r.candidates[0]);
      const unlinked = chosenRows.filter((r) => r.kind === 'link');
      const differing = chosenRows.filter((r) => r.kind === 'differs');
      bulk.draw({
        count: canAct ? chosenRows.length : 0,
        onClear: clear,
        groups: [[
          { icon: 'link-2', label: 'Link', title: 'Link each to its likely code', primary: true, run: async () => {
            if (!linkable.length) { toast('No ticked record has a likely code. Use Add as new codes, or one at a time.', 'warn'); return; }
            const linked = await linkMany(linkable.map((row) => ({ row, item: row.candidates[0].item })));
            if (linked) toast(linked === unlinked.length ? `${linked} linked.` : `${linked} linked. The rest stay here.`, 'success');
            await load();
          } },
          { icon: 'plus', label: 'Add as new codes', title: 'Add each ticked record as a new code, then link it', run: async () => {
            if (!unlinked.length) { toast('Tick records with no code first.', 'warn'); return; }
            const pairs = [];
            for (const row of unlinked) {
              const made = await call('/api/invoicing/price-items', 'POST', newCodeOf(row.record));
              if (made) pairs.push({ row, item: made.item });
            }
            const linked = await linkMany(pairs);
            toast(`${linked} added and linked.`, linked === unlinked.length ? 'success' : 'warn');
            await load();
          } },
          { icon: 'check', label: 'Mark resolved', title: 'Accept each ticked difference', run: async () => {
            if (!differing.length) { toast('Tick codes that differ first.', 'warn'); return; }
            for (const id of new Set(differing.map((r) => r.item.id))) await call(`/api/invoicing/price-items/${id}/resolve`, 'POST', {});
            toast('Marked resolved.', 'success');
            await load();
          } },
        ]],
      });
    };
    const all = h('input', { type: 'checkbox', class: 'fx-tick', 'aria-label': 'Tick all', onchange: () => {
      for (const r of rows) { if (all.checked) ticked.add(r.key); else ticked.delete(r.key); }
      for (const b of boxes.values()) b.checked = all.checked;
      drawBar();
    } });
    const sure = rows.filter((r) => r.sure);
    const state = (row) => {
      if (row.kind === 'differs') return [icon('equal-not', 'Differs'), 'differs'];
      if (row.sure) return [icon('check-check', 'Sure match'), 'sure'];
      if (row.candidates[0]) return [icon('link-2', 'Likely code'), 'likely'];
      return [icon('circle-dashed', 'No likely code'), 'none'];
    };
    host.replaceChildren(
      h('div', { class: 'fx-xi__bulk' }, icon('list-checks'), h('span', { class: 'fx-xi__bulk-text' }, 'Tick rows, then use the bar below.'),
        canAct && sure.length ? h('button', { class: 'fx-btn fx-btn--sm', type: 'button', onclick: () => {
          for (const r of sure) { ticked.add(r.key); boxes.get(r.key).checked = true; }
          drawBar();
        } }, icon('check-check'), `Tick ${sure.length} sure`) : null),
      h('div', { class: 'fx-xi__scroll' }, h('table', { class: 'fx-table fx-table--rows fx-xi-list fx-prc-list' },
        h('thead', {}, h('tr', {},
          canAct ? h('th', { class: 'fx-tick-cell' }, all) : null,
          h('th', { colspan: '4' }, 'Record'), h('th', { class: 'fx-xi-list__mid' }), h('th', { colspan: '3' }, h('span', { class: 'fx-prc-list__flow' }, flowMark(), 'Flow code')))),
        h('tbody', {}, rows.map((row, index) => {
          const box = h('input', { type: 'checkbox', class: 'fx-tick', 'aria-label': `Tick ${row.record?.name ?? row.item?.code}`, onclick: (event) => event.stopPropagation(), onchange: () => {
            if (box.checked) ticked.add(row.key); else ticked.delete(row.key);
            drawBar();
          } });
          boxes.set(row.key, box);
          const item = row.kind === 'differs' ? row.item : row.candidates[0]?.item ?? null;
          const [glyph, tone] = state(row);
          const differs = (kind) => row.kind === 'differs' && row.findings.some((f) => f.kind === kind);
          return h('tr', { 'data-state': tone, onclick: () => { at = index; pick = 0; chosen = null; setView('card'); } },
            canAct ? h('td', { class: 'fx-tick-cell', onclick: (event) => event.stopPropagation() }, box) : null,
            h('td', { class: 'fx-prc-list__sys' }, systemMark(row.system)),
            h('td', { class: 'fx-prc-list__name' }, row.record?.name ?? h('span', { class: 'fx-dim' }, row.kind === 'differs' ? `Not in ${row.system.name}` : '—'),
              row.record?.code ? h('span', { class: 'fx-dim fx-num' }, ` · ${row.record.code}`) : null),
            h('td', { class: `fx-num${differs('price') ? ' fx-prc-list__bad' : ''}` }, money(row.record?.unitAmountCents)),
            h('td', { class: differs('tax') ? 'fx-prc-list__bad' : 'fx-dim' }, taxWords(row.record?.taxCode)),
            h('td', { class: 'fx-xi-list__mid' }, glyph),
            h('td', { class: 'fx-num' }, item?.code ?? h('span', { class: 'fx-dim' }, 'No likely code')),
            h('td', { class: 'fx-prc-list__name' }, item?.name ?? ''),
            h('td', { class: 'fx-num fx-strong' }, item ? money(item.unitAmountCents) : ''));
        })))));
    drawBar();
  }

  await load();
}
