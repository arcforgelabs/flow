// The bulk action bar: while a person has ticked rows in a list, it floats
// at the foot of the page, like ClickUp's. It shows "N selected ×" (the ×
// clears the ticks), then the actions in groups split by a thin line, then
// More. An action has a Lucide icon and one word; an icon-only action gives
// its name on hover and to a screen reader. More opens every action, with a
// search box, grouped under small heads.
//
// bulkBar(ui, { label }) answers { element, draw(state) }. label names the
// bar for a screen reader ("Ticked invoices", "Ticked jobs"). state = { count, onClear,
// groups: [[action]], more: [{ head, actions: [action] }] }; an action is
// { icon, label, title?, run, primary?, iconOnly?, tone? }. title is the
// long name, for the hover tip and the More menu. run(working) may call
// working('Sending') once the step really starts (after its dialog): the
// pressed button then shows a spinner and that word until run ends. A count
// of 0 hides the bar; Esc clears the ticks while it shows.
import { lucide } from '/assets/ui/custom-fields.js';

let barCount = 0;

export function bulkBar(ui, { label = 'Ticked invoices' } = {}) {
  const { h } = ui;
  const id = `fx-bulk-more-${++barCount}`;
  const element = h('div', { class: 'fx-bulk', role: 'toolbar', 'aria-label': label, hidden: true });
  const panel = h('div', { class: 'fx-pop fx-bulk__more', id, popover: 'auto', role: 'menu' });
  let current = null;
  let busy = false;

  const run = async (action) => {
    if (busy) return;
    busy = true;
    element.setAttribute('aria-busy', 'true');
    // The step is on its way: its button (on the bar, or More's) spins.
    const working = (word) => {
      const pressed = [...element.querySelectorAll('.fx-bulk__act')].find((b) => b.dataset.action === action.label);
      if (!pressed) return;
      pressed.dataset.busy = '';
      pressed.firstChild?.replaceWith(h('span', { class: 'fx-spinner fx-spinner--sm', 'aria-hidden': 'true' }));
      const text = pressed.querySelector('.fx-bulk__word');
      if (text && word) text.textContent = `${word}…`;
    };
    try { await action.run(working); } finally {
      busy = false;
      element.removeAttribute('aria-busy');
      if (current) draw(current);
    }
  };

  const button = (action) => h('button', {
    type: 'button', 'data-action': action.label,
    class: `fx-bulk__act${action.primary ? ' fx-bulk__act--primary' : ''}${action.iconOnly ? ' fx-bulk__act--icon' : ''}`,
    ...(action.tone ? { 'data-tone': action.tone } : {}),
    ...(action.iconOnly ? { 'aria-label': action.title ?? action.label, 'data-tip': action.title ?? action.label } : action.title ? { title: action.title } : {}),
    onclick: () => run(action),
  }, lucide(h, action.icon), action.iconOnly ? null : h('span', { class: 'fx-bulk__word' }, action.label));

  // More: a search box over every action, under small heads.
  const search = h('input', { class: 'fx-input fx-bulk__search', type: 'search', placeholder: 'Search…', 'aria-label': 'Search actions' });
  const list = h('div', { class: 'fx-bulk__list' });
  const drawMore = () => {
    const q = search.value.trim().toLowerCase();
    const parts = [];
    for (const { head, actions } of current?.more ?? []) {
      const found = actions.filter((a) => !q || `${a.label} ${a.title ?? ''}`.toLowerCase().includes(q));
      if (!found.length) continue;
      parts.push(h('p', { class: 'fx-pop__head' }, head), h('div', { class: 'fx-bulk__grid' }, found.map((action) => h('button', {
        type: 'button', class: 'fx-pop__item', role: 'menuitem', ...(action.tone ? { 'data-tone': action.tone } : {}),
        onclick: () => { panel.hidePopover?.(); run(action); },
      }, h('span', { class: 'fx-pop__tick' }, lucide(h, action.icon)), h('span', {}, action.title ?? action.label)))));
    }
    list.replaceChildren(...(parts.length ? parts : [h('p', { class: 'fx-bulk__none' }, 'No action matches.')]));
  };
  search.addEventListener('input', drawMore);
  const onKey = (event) => {
    if (!element.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (event.key === 'Escape' && !element.hidden && !panel.matches?.(':popover-open') && !document.querySelector('dialog[open]')) current?.onClear();
  };
  document.addEventListener?.('keydown', onKey);
  panel.append(search, list);
  const more = h('button', {
    type: 'button', class: 'fx-bulk__act', popovertarget: id, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
  }, lucide(h, 'ellipsis'), h('span', { class: 'fx-bulk__word' }, 'More'));
  // The menu opens above the bar, at its right edge.
  panel.addEventListener('toggle', (event) => {
    more.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState !== 'open') return;
    search.value = '';
    drawMore();
    const at = more.getBoundingClientRect();
    panel.style.top = `${Math.round(Math.max(8, at.top - panel.offsetHeight - 8))}px`;
    panel.style.left = `${Math.round(Math.max(8, Math.min(at.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8)))}px`;
    search.focus();
  });

  function draw(state) {
    current = state;
    element.hidden = !state?.count;
    if (element.hidden) { panel.hidePopover?.(); return; }
    const count = h('span', { class: 'fx-bulk__count' },
      h('span', {}, `${state.count} selected`),
      h('button', { type: 'button', class: 'fx-bulk__clear', 'aria-label': 'Clear the ticks', 'data-tip': 'Clear', onclick: state.onClear }, lucide(h, 'x')));
    const groups = state.groups.filter((g) => g.length);
    const parts = [];
    groups.forEach((group, i) => {
      if (i) parts.push(h('span', { class: 'fx-bulk__sep', 'aria-hidden': 'true' }));
      parts.push(...group.map(button));
    });
    if ((state.more ?? []).some((g) => g.actions.length)) parts.push(h('span', { class: 'fx-bulk__sep', 'aria-hidden': 'true' }), more, panel);
    element.replaceChildren(count, h('span', { class: 'fx-bulk__acts' }, ...parts));
  }

  return { element, draw };
}
