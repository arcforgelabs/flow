// The sidecar, as in ClickUp: a panel at the right of a page or a dialog.
// The Custom fields manager opens it over its table (`overlay`); a job's
// panel keeps it as its right column, with tabs (Activity, Fix). Closed,
// it takes no room, so the main area gets the full width. `phone: 'page'`
// opens that panel as a full page on a phone: the tabs sit at the top of
// the record and the record bar (`recordBar`) carries back, the title and
// the next record. The main action stays in the caller's foot.
//
// sidecar(h, { label, overlay, escape, tabs, onChange, phone }) answers
// { element, isOpen, open, show, close, tab, setTabs }:
//   open(id)     selects tab `id` (or the first) and draws its `render()`
//   show(node)   draws one node with no tabs (the overlay's own form)
//   close()      hides it and empties it
// `tabs` is [{ id, label, icon, render }]; each tab is an icon and one word.
// `escape` closes it on Esc when no dialog or menu is open over the page.
// `onChange(id)` hears each open (the tab id) and close (null).

import { lucide } from '/assets/ui/custom-fields.js';
import { applyPhoneRule, isPhone, WIDTHS } from './mobile.js';

const CHEVRON_LEFT = 'M14.5 6l-6 6 6 6';
const CHEVRON_RIGHT = 'M9.5 6l6 6-6 6';

function glyph(button, path) {
  button.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return button;
}

export function sidecar(h, { label, overlay = false, escape = false, tabs = [], onChange = null, phone = null } = {}) {
  const element = applyPhoneRule(h('aside', { class: `fx-sidecar${overlay ? ' fx-sidecar--over' : ''}`, 'aria-label': label, hidden: true }), 'sidecar');
  let list = tabs;
  let current = null;
  let drawn = false;
  if (phone === 'page') element.dataset.phone = 'page';

  const closeButton = () => h('button', { class: 'fx-sidecar__close', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => api.close() }, lucide(h, 'x'));

  // On a phone page the tab strip is the record's top tabs, so it lives on
  // the record (the parent) and stays put while the record scrolls. The
  // body stays in the sidecar, which is what the phone suite measures.
  function parkHead(head) {
    const grid = element.parentElement;
    if (element.classList.contains('fx-sidecar--page') && grid) grid.prepend(head);
    else element.prepend(head);
  }

  function drawTabs() {
    const head = h('header', { class: 'fx-sidecar__head' },
      h('div', { class: 'fx-sidecar__tabs', role: 'tablist', 'aria-label': label },
        list.map((t) => h('button', {
          class: 'fx-sidecar__tab', type: 'button', role: 'tab', 'data-tab': t.id,
          'aria-selected': String(t.id === current), onclick: () => api.open(t.id),
        }, lucide(h, t.icon), h('span', {}, t.label), t.mark ? h('span', { class: 'fx-sidecar__mark', 'aria-hidden': 'true' }) : null))),
      closeButton());
    const tab = list.find((t) => t.id === current);
    const body = h('div', { class: 'fx-sidecar__body', role: 'tabpanel' }, tab?.render?.() ?? null);
    element.parentElement?.querySelector(':scope > .fx-sidecar__head')?.remove();
    element.replaceChildren(body);
    parkHead(head);
  }

  const api = {
    element,
    isOpen: () => !element.hidden,
    tab: () => (element.hidden ? null : current),
    open(id = null) {
      current = list.find((t) => t.id === id)?.id ?? list[0]?.id ?? null;
      drawTabs();
      element.hidden = false;
      // The first open leaves the record where it is. A later tab brings
      // its panel up under the sticky tabs.
      if (drawn && element.classList.contains('fx-sidecar--page')) {
        element.querySelector('.fx-sidecar__body')?.scrollIntoView({ block: 'start' });
      }
      drawn = true;
      onChange?.(current);
    },
    show(node) {
      current = null;
      element.parentElement?.querySelector(':scope > .fx-sidecar__head')?.remove();
      element.replaceChildren(node);
      element.hidden = false;
    },
    close() {
      if (element.hidden) return;
      element.hidden = true;
      element.parentElement?.querySelector(':scope > .fx-sidecar__head')?.remove();
      element.replaceChildren();
      current = null;
      drawn = false;
      onChange?.(null);
    },
    // New tabs (a tab's data came in): an open tab draws again.
    setTabs(next) {
      list = next;
      if (!element.hidden && current) drawTabs();
    },
    closeButton,
  };

  if (phone === 'page') {
    const sync = () => {
      element.classList.toggle('fx-sidecar--page', isPhone());
      if (!element.hidden && current) drawTabs();
    };
    sync();
    if (typeof matchMedia === 'function') matchMedia(WIDTHS.phone).addEventListener('change', sync);
  }

  if (escape) {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && element.isConnected && !element.hidden && !document.querySelector('dialog[open], .fx-pop:popover-open')) api.close();
    });
  }
  return api;
}

// The bar at the top of a record on a phone: ← back, the title, ‹ › for the
// previous and next record, and an optional ⋯ menu. Hidden above phone
// width (flow.css), so a desk record keeps its own bar. `prev` and `next`
// are { label, disabled, onclick }. `setSteps` and `setMenu` update them
// after the list arrives.
export function recordBar(h, { title = '', onBack, prev = null, next = null, menu = null, label = 'Record' } = {}) {
  const back = glyph(h('button', { class: 'fx-record__back', type: 'button', 'aria-label': 'Back', title: 'Back', onclick: onBack }), CHEVRON_LEFT);
  const titleNode = h('h2', { class: 'fx-record__title', title }, title);
  const step = (path) => glyph(h('button', { class: 'fx-record__step', type: 'button' }), path);
  const prevBtn = step(CHEVRON_LEFT);
  const nextBtn = step(CHEVRON_RIGHT);
  const end = h('div', { class: 'fx-record__end' }, prevBtn, nextBtn);
  const apply = (button, spec, fallback) => {
    const name = spec?.label ?? fallback;
    button.setAttribute('aria-label', name);
    button.title = name;
    button.disabled = !spec || Boolean(spec.disabled);
    button.onclick = spec?.onclick ?? null;
  };
  apply(prevBtn, prev, 'Previous');
  apply(nextBtn, next, 'Next');
  const element = h('header', { class: 'fx-record', 'aria-label': label }, back, titleNode, end);
  element.setSteps = (nextPrev, nextNext) => {
    apply(prevBtn, nextPrev, 'Previous');
    apply(nextBtn, nextNext, 'Next');
  };
  element.setMenu = (node) => {
    end.querySelector('.fx-record__menu')?.remove();
    if (node) end.append(node);
  };
  if (menu) element.setMenu(menu);
  return element;
}

// Keeps `pick()` in `foot` while the window is a phone, and back in `home`
// (the header's actions) otherwise. Returns the function to call again when
// the primary action changes (Save appears, a send arrives).
export function watchPhonePrimary(home, foot, pick) {
  let parked = null;
  const apply = () => {
    const next = isPhone() ? (pick() ?? null) : null;
    if (parked && parked !== next && home) home.append(parked);
    parked = next;
    if (parked) {
      foot.hidden = false;
      if (parked.parentElement !== foot) foot.replaceChildren(parked);
    } else {
      foot.replaceChildren();
      foot.hidden = true;
    }
  };
  apply();
  if (typeof matchMedia === 'function') matchMedia(WIDTHS.phone).addEventListener('change', apply);
  return apply;
}
