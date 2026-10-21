// The sidecar, as in ClickUp: a panel at the right of a page or a dialog.
// The Custom fields manager opens it over its table (`overlay`); a job's
// panel keeps it as its right column, with tabs (Activity, Review). Closed,
// it takes no room, so the main area gets the full width.
//
// sidecar(h, { label, overlay, escape, tabs, onChange }) answers
// { element, isOpen, open, show, close, tab, setTabs }:
//   open(id)     selects tab `id` (or the first) and draws its `render()`
//   show(node)   draws one node with no tabs (the overlay's own form)
//   close()      hides it and empties it
// `tabs` is [{ id, label, icon, render }]; each tab is an icon and one word.
// `escape` closes it on Esc when no dialog or menu is open over the page.
// `onChange(id)` hears each open (the tab id) and close (null).

import { lucide } from '/assets/ui/custom-fields.js';

export function sidecar(h, { label, overlay = false, escape = false, tabs = [], onChange = null } = {}) {
  const element = h('aside', { class: `fx-sidecar${overlay ? ' fx-sidecar--over' : ''}`, 'aria-label': label, hidden: true });
  let list = tabs;
  let current = null;

  const closeButton = () => h('button', { class: 'fx-sidecar__close', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => api.close() }, lucide(h, 'x'));

  function drawTabs() {
    const head = h('header', { class: 'fx-sidecar__head' },
      h('div', { class: 'fx-sidecar__tabs', role: 'tablist', 'aria-label': label },
        list.map((t) => h('button', {
          class: 'fx-sidecar__tab', type: 'button', role: 'tab', 'data-tab': t.id,
          'aria-selected': String(t.id === current), onclick: () => api.open(t.id),
        }, lucide(h, t.icon), h('span', {}, t.label), t.mark ? h('span', { class: 'fx-sidecar__mark', 'aria-hidden': 'true' }) : null))),
      closeButton());
    const tab = list.find((t) => t.id === current);
    element.replaceChildren(head, h('div', { class: 'fx-sidecar__body', role: 'tabpanel' }, tab?.render?.() ?? null));
  }

  const api = {
    element,
    isOpen: () => !element.hidden,
    tab: () => (element.hidden ? null : current),
    open(id = null) {
      current = list.find((t) => t.id === id)?.id ?? list[0]?.id ?? null;
      drawTabs();
      element.hidden = false;
      onChange?.(current);
    },
    show(node) {
      current = null;
      element.replaceChildren(node);
      element.hidden = false;
    },
    close() {
      if (element.hidden) return;
      element.hidden = true;
      element.replaceChildren();
      current = null;
      onChange?.(null);
    },
    // New tabs (a tab's data came in): an open tab draws again.
    setTabs(next) {
      list = next;
      if (!element.hidden && current) drawTabs();
    },
    closeButton,
  };

  if (escape) {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && element.isConnected && !element.hidden && !document.querySelector('dialog[open], .fx-pop:popover-open')) api.close();
    });
  }
  return api;
}
