// The shared pieces every Flow page builds with: elements (h), the page
// header, notes, toasts, dialogs, setting rows, the ⋯ row menu, the button
// that waits between presses, cards that open a page, and the crumbs trail. app.js hands them to each view module in ui(),
// and the design system's cards (scripts/design-system/) render these same
// functions, so a card is the real thing. Reuse one or give it an option;
// never copy it into a page (AGENTS.md, "UI: reuse first").
import { lucide } from '/assets/ui/custom-fields.js';
import { applyPhoneRule } from './mobile.js';
import { named } from '/assets/ui/tip.js';

// h('p', { class: 'x', onclick }, 'text', child) — children are text or nodes.
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Keeps a button off for `ms`, with the time left on it, then puts it back.
export function holdButton(button, ms) {
  if (!button || !(ms > 0)) return;
  clearInterval(button.fxHold);
  const label = button.dataset.label ?? button.textContent;
  button.dataset.label = label;
  const until = Date.now() + ms;
  const draw = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(button.fxHold);
      button.textContent = label;
      delete button.dataset.label;
      button.removeAttribute('title');
      button.disabled = false;
      return;
    }
    const time = left < 60 ? `${left}s` : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    button.disabled = true;
    button.textContent = `${label} · ${time}`;
    button.title = `Flow waits before it asks again, to protect the connected system's limits. Ready in ${time}.`;
  };
  draw();
  button.fxHold = setInterval(draw, 1000);
}

// The page's name and nothing under it: the page shows what it is for.
// `count` is a live number beside the name (2 to check); `help` is a docs
// link, an icon with its name as a tip.
export function pageHeader(title, { count = null, help = null, actions = [] } = {}) {
  return applyPhoneRule(h('header', { class: 'fx-ph' },
    h('div', { class: 'fx-ph__text' },
      h('h1', { class: 'fx-title' }, title),
      count != null ? h('span', { class: 'fx-ph__count' }, count) : null,
      help ? helpLink(help) : null),
    actions.length ? h('div', { class: 'fx-ph__actions' }, actions) : null), 'pageHeader');
}

// The top of a list page (Jobs, Invoices, Reconcile), laid out the same on
// every list and in Board and List alike, so nothing moves when a person
// switches: the title row, then one toolbar with `start` at the left (tabs,
// Group, Sort, Filter) and `end` at the right (search, Board/List), then the
// page's `actions` (New invoice) last, as Claude's own lists do. `controls`
// (the page's Group, Sort and Filter) sit with the saved view tabs at their
// right (`views`: the page's savedViews element, else an empty slot that
// stays hidden), at the end of `start`, or of `end` when `controlsAt` is
// 'end'. `line` draws the rule that tabs sit on; `sticky` keeps the toolbar
// at the top while the rows scroll up under it, with a shadow once they do.
// Append `nodes` to the page.
export function listHead(title, { count = null, help = null, actions = [], start = [], end = [], controls = null, controlsAt = 'start', line = false, sticky = false, views: tabs = null } = {}) {
  const views = tabs ?? h('div', { class: 'fx-views', role: 'group', 'aria-label': 'Views', hidden: true });
  const tools = h('div', { class: 'fx-toolbar__tools' }, controls, views);
  const left = controlsAt === 'end' ? [start].flat() : [start, tools].flat();
  const right = controlsAt === 'end' ? [tools, end].flat() : [end].flat();
  const bar = applyPhoneRule(h('div', { class: 'fx-listhead', 'data-sticky': sticky },
    h('div', { class: `fx-toolbar${line ? '' : ' fx-toolbar--plain'}` }, left, h('div', { class: 'fx-toolbar__end' }, right, actions))), 'listHead');
  const edge = sticky ? h('div', { class: 'fx-listhead__edge', 'aria-hidden': 'true' }) : null;
  if (edge && typeof IntersectionObserver === 'function') {
    const top = window.matchMedia?.('(max-width: 820px)').matches ? 61 : 1;
    new IntersectionObserver(([entry]) => bar.toggleAttribute('data-stuck', !entry.isIntersecting), { rootMargin: `-${top}px 0px 0px 0px` }).observe(edge);
  }
  return { nodes: [pageHeader(title, { count, help }), edge, bar].filter(Boolean), views, bar };
}

// The window a list or board sits in under listHead, as HubSpot's: on a
// desktop it fills the page to the bottom and scrolls inside itself both
// ways, so nothing runs off the page, with a foot bar for the count and its
// tools. It makes `main` the window's height (fx-main--frame). Rows fade
// under an edge they scroll past (edgeFade); the sticky table head is the
// top edge's own break.
export function listFrame(main, content) {
  main.classList.add('fx-main--frame');
  const count = h('span', { class: 'fx-frame__count', role: 'status' });
  const tools = h('div', { class: 'fx-frame__tools' });
  const body = h('div', { class: 'fx-frame__body' }, content);
  const view = h('div', { class: 'fx-frame__view' }, body);
  const element = applyPhoneRule(h('section', { class: 'fx-frame' }, view, h('footer', { class: 'fx-frame__foot' }, count, tools)), 'listFrame');
  edgeFade(body, { target: view, edges: ['bottom', 'left', 'right'] });
  return { element, body, view, tools, count: (text) => { count.textContent = text ?? ''; } };
}

// A soft fade at each edge of `target` that `scroller` has more content
// past, so rows and cards fade under it instead of vanishing. No fade on
// an edge a scrollbar already marks (the bottom under a sideways bar, the
// right beside a down bar). `target` holds the fades and must not scroll.
const fading = typeof ResizeObserver === 'function'
  ? new ResizeObserver((entries) => entries.forEach(({ target }) => (target.isConnected ? target.fxFade?.() : fading.unobserve(target))))
  : null;
export function edgeFade(scroller, { target = scroller.parentElement, edges = ['top', 'bottom', 'left', 'right'] } = {}) {
  target.classList.add('fx-fades');
  for (const edge of edges) {
    if (!target.querySelector(`:scope > .fx-fade[data-edge="${edge}"]`)) target.append(h('span', { class: 'fx-fade', 'data-edge': edge, 'aria-hidden': 'true' }));
  }
  const update = () => {
    const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth, offsetHeight, offsetWidth } = scroller;
    const more = {
      top: scrollTop > 1,
      bottom: scrollTop + clientHeight < scrollHeight - 1 && offsetHeight - clientHeight === 0,
      left: scrollLeft > 1,
      right: scrollLeft + clientWidth < scrollWidth - 1 && offsetWidth - clientWidth === 0,
    };
    // Several scrollers can share a target (the board in the frame): it
    // fades each edge any of them has more past.
    target.fxFades ??= new Map();
    target.fxFades.set(scroller, edges.filter((edge) => more[edge]));
    for (const other of target.fxFades.keys()) if (!other.isConnected) target.fxFades.delete(other);
    target.dataset.fade = [...new Set([...target.fxFades.values()].flat())].join(' ');
  };
  scroller.fxFade = update;
  scroller.addEventListener('scroll', update, { passive: true });
  fading?.observe(scroller);
  requestAnimationFrame(update);
  return update;
}

// A docs link as a small "?" icon whose tip names it (How sending works).
export function helpLink({ href, label }) {
  return named(h('a', { class: 'fx-help', href, target: '_blank', rel: 'noopener' }, lucide(h, 'circle-help')), label);
}

// A settings section's heading, with its docs link beside it.
export function sectionTitle(text, help = null) {
  return h('h2', { class: 'fx-set__title' }, text, help ? helpLink(help) : null);
}

export function notice(text, tone = 'info', title = null) {
  return applyPhoneRule(h('div', { class: 'fx-notice', 'data-tone': tone, role: tone === 'danger' ? 'alert' : 'status' },
    title ? h('strong', {}, title) : null,
    h('span', {}, text)), 'notice');
}

// A field that fails a check glows red, like a required field, until the
// person types in it; the next check marks it again if it still fails.
// `on` false clears it. Answers the field.
export function fieldError(field, on = true) {
  if (!on) { field.removeAttribute('aria-invalid'); return field; }
  applyPhoneRule(field, 'fieldError');
  field.setAttribute('aria-invalid', 'true');
  field.addEventListener('input', () => field.removeAttribute('aria-invalid'), { once: true });
  return field;
}

// A short result after an action. With `stay: true` it stays until the person
// closes it (for a danger a failed press must not pass unseen).
export function toast(text, tone = 'info', { stay = false } = {}) {
  const region = document.getElementById('toasts');
  const item = applyPhoneRule(h('div', {
    class: stay ? 'fx-toast fx-toast--stay' : 'fx-toast',
    'data-tone': tone,
    role: tone === 'danger' ? 'alert' : 'status',
  }, h('span', { class: 'fx-toast__text' }, text)), 'toast');
  if (stay) {
    item.append(h('button', {
      type: 'button', class: 'fx-toast__close', 'aria-label': 'Close', title: 'Close',
      onclick: () => item.remove(),
    }, lucide(h, 'x')));
  } else {
    setTimeout(() => item.remove(), 4200);
  }
  region.append(item);
}

// A modal built on <dialog>: resolves with the button's value, or null.
export function dialog({ title, body, confirm, tone = 'primary', choices = null }) {
  return new Promise((resolve) => {
    const choiceList = choices
      ? h('div', { class: 'fx-sheet__choices', role: 'group', 'aria-label': title },
        choices.map((choice) => h('button', { class: 'fx-sheet__choice', type: 'submit', value: choice.value },
          h('span', {}, choice.label),
          choice.detail == null ? null : h('span', { class: 'fx-tabs__count' }, String(choice.detail)))))
      : null;
    const actions = choices ? null : h('div', { class: 'fx-dialog__actions' },
      h('button', { class: 'fx-btn fx-btn--ghost', value: 'cancel', type: 'submit', formnovalidate: true }, 'Cancel'),
      h('button', { class: `fx-btn fx-btn--${tone}`, value: 'ok', type: 'submit' }, confirm));
    const form = h('form', { method: 'dialog', class: 'fx-dialog__form' },
      h('h2', { class: 'fx-dialog__title' }, title),
      choiceList ?? body,
      actions);
    const element = applyPhoneRule(h('dialog', { class: 'fx-dialog' }, form), 'dialog');
    element.addEventListener('close', () => {
      const value = element.returnValue;
      element.remove();
      if (choices) {
        resolve(value && value !== 'cancel' ? value : null);
        return;
      }
      const ok = value === 'ok';
      resolve(ok ? new FormData(form) : null);
    });
    if (choices) element.addEventListener('click', (event) => { if (event.target === element) element.close(); });
    document.body.append(element);
    element.showModal();
    element.querySelector(choices ? '.fx-sheet__choice' : 'input, select, button[value="ok"]')?.focus();
  });
}

// One setting, laid out the same on every settings screen: a short name, one
// line of smaller text under it, and the control on the right. Longer help
// lives behind a link, not here. A wide control (a grid of choices) sits on
// its own line under the name. `tone: 'danger'` marks a row that needs a person.
export function settingRow({ label, hint, control, wide = false, tone = null }) {
  const target = control?.matches?.('input, select, textarea') ? control : control?.querySelector?.('input:not([type=color]), select, textarea');
  const id = target ? (target.id ||= `fx-set-${++settingRow.next}`) : null;
  return applyPhoneRule(h('div', { class: `fx-setting${wide ? ' fx-setting--wide' : ''}`, 'data-tone': tone },
    h('div', { class: 'fx-setting__text' },
      id ? h('label', { class: 'fx-setting__name', for: id }, label) : h('span', { class: 'fx-setting__name' }, label),
      hint ? h('p', { class: 'fx-setting__hint' }, hint) : null),
    h('div', { class: 'fx-setting__control' }, control)), 'settingRow');
}
settingRow.next = 0;

// The steps of a Connect, each ticked, running or crossed, with the time taken.

let rowMenus = 0;

function menuGlyph(icon) {
  if (icon instanceof Node) return icon.isConnected ? icon.cloneNode(true) : icon;
  return icon ? lucide(h, icon) : null;
}

// A row's ⋯ menu, as on the Custom fields page. The menu lines up with the
// button's right edge; `align: 'start'` lines it up with its left edge.
// `place: 'side'` floats it to the right of the button (the sidebar's More),
// and moves focus into the menu and back to the button on close.
// `trigger` swaps the ⋯ icon for the given contents.
// An item is `{ icon, text, run, tone }` or `'-'` (a line). `icon` is a Lucide
// name or a node. `trailing` is a control at the row's end (the pin) that
// does not close the menu: `{ icon, label, pressed, run, locked }`. `locked`
// draws the icon and does not take a click. `items` may be a function, read
// again each time the menu opens. `panel.refresh()` redraws it while open.
export function rowMenu(label, items, { trigger = null, className = 'fx-cfm__more', align = 'end', place = 'below' } = {}) {
  const id = `fx-row-menu-${++rowMenus}`;
  const button = applyPhoneRule(h('button', { class: className, type: 'button', 'aria-label': label, popovertarget: id, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, trigger ?? lucide(h, 'ellipsis')), 'rowMenu');
  const panel = h('div', { class: place === 'side' ? 'fx-pop fx-pop--side' : 'fx-pop', id, popover: 'auto', role: 'menu' });
  const entries = () => (typeof items === 'function' ? items() : items);
  let picking = false;

  function renderEntry(entry) {
    if (entry === '-') return h('div', { class: 'fx-pop__sep' });
    const item = h('button', {
      type: 'button', class: 'fx-pop__item', role: 'menuitem', 'data-tone': entry.tone,
      onclick: () => { picking = true; panel.hidePopover(); entry.run(); },
    }, h('span', { class: 'fx-pop__tick' }, menuGlyph(entry.icon)), h('span', {}, entry.text));
    if (!entry.trailing) return item;
    const trail = entry.trailing;
    const mark = menuGlyph(trail.icon);
    const control = trail.locked
      ? h('span', { class: 'fx-pop__pin fx-pop__pin--fixed', role: 'img', 'aria-label': trail.label }, mark)
      : h('button', {
        type: 'button', class: 'fx-pop__pin', 'aria-label': trail.label, 'aria-pressed': trail.pressed ? 'true' : 'false',
        onclick: (event) => { event.stopPropagation(); trail.run(); },
      }, mark);
    return h('div', { class: 'fx-pop__row', role: 'none' }, item, control);
  }

  function placePanel() {
    const at = button.getBoundingClientRect();
    const margin = 8;
    const narrow = place === 'side' && window.matchMedia('(max-width: 820px)').matches;
    if (narrow) {
      // On a phone the sidebar is the slide-out. The menu stays inside it.
      const drawer = button.closest('.fx-nav')?.getBoundingClientRect();
      const left = Math.round((drawer?.left ?? at.left) + margin);
      const width = Math.max(160, Math.round((drawer?.width ?? at.width) - margin * 2));
      panel.style.width = `${width}px`;
      panel.style.minWidth = '0';
      let top = Math.round(at.bottom + 6);
      if (top + panel.offsetHeight > innerHeight - margin) top = Math.max(margin, Math.round(innerHeight - margin - panel.offsetHeight));
      panel.style.top = `${top}px`;
      panel.style.left = `${left}px`;
      return;
    }
    panel.style.width = '';
    panel.style.minWidth = '';
    if (place === 'side') {
      const gap = 8;
      let left = Math.round(at.right + gap);
      if (left + panel.offsetWidth > innerWidth - margin) left = Math.round(at.left - gap - panel.offsetWidth);
      panel.style.left = `${Math.max(margin, Math.min(left, innerWidth - panel.offsetWidth - margin))}px`;
      let top = Math.round(at.top);
      panel.style.top = `${Math.max(margin, Math.min(top, innerHeight - panel.offsetHeight - margin))}px`;
      return;
    }
    panel.style.top = `${Math.round(at.bottom + 6)}px`;
    const left = align === 'start' ? at.left : at.right - panel.offsetWidth;
    panel.style.left = `${Math.round(Math.max(margin, Math.min(left, innerWidth - panel.offsetWidth - margin)))}px`;
  }

  function draw(keepFocus) {
    const active = document.activeElement;
    const row = active?.closest?.('.fx-pop__row');
    const text = row?.querySelector('[role="menuitem"]')?.textContent?.trim() ?? '';
    const onPin = Boolean(active?.classList?.contains('fx-pop__pin'));
    panel.replaceChildren(...entries().map(renderEntry));
    if (!keepFocus || !text) return;
    const next = [...panel.querySelectorAll('.fx-pop__row')].find((candidate) => candidate.querySelector('[role="menuitem"]')?.textContent?.trim() === text);
    (onPin ? next?.querySelector('.fx-pop__pin') : next?.querySelector('[role="menuitem"]'))?.focus();
  }

  panel.refresh = () => {
    if (!panel.matches(':popover-open')) return;
    draw(true);
    placePanel();
  };

  panel.addEventListener('toggle', (event) => {
    const open = event.newState === 'open';
    button.setAttribute('aria-expanded', String(open));
    if (!open) {
      // A chosen row moves focus itself. Anything else (Escape, a click
      // outside) puts focus back on the button that opened the menu.
      if (place === 'side' && !picking) button.focus();
      picking = false;
      return;
    }
    draw(false);
    placePanel();
    if (place === 'side') panel.querySelector('[role="menuitem"]')?.focus();
  });

  if (place === 'side') {
    panel.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const stops = [...panel.querySelectorAll('button')];
      if (!stops.length) return;
      event.preventDefault();
      const index = Math.max(0, stops.indexOf(document.activeElement));
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? stops.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % stops.length
        : (index - 1 + stops.length) % stops.length;
      stops[next].focus();
    });
  }

  return [button, panel];
}

// Where a link in a shared piece opens: app.js passes its own `go`, so a click
// opens the page in place (a new tab still works). Without it, as in the
// design system, a link is a plain link.
let openPath = null;
export function linksOpenWith(go) { openPath = go; }
function inPlace(event) {
  if (!openPath || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  openPath(event.currentTarget.getAttribute('href'));
}

// A card that opens a page. Large (Integrations): its mark (a logo node, or a
// Lucide icon name), the name, a status pill, two lines at most (only when
// they help), and the action. `row` is the one-line card of a tileSection,
// like Claude's Customize categories: the mark at the left, the name, and a
// short dim `meta` value or the status pill at the right.
export function tileCard({ href, mark, title, status, blurb, meta, action = 'Manage', row = false }) {
  const logo = typeof mark === 'string' ? h('span', { class: 'fx-logo fx-logo--icon', 'aria-hidden': 'true' }, lucide(h, mark)) : mark;
  const pill = status ? h('span', { class: 'fx-status', 'data-tone': status.tone ?? 'mute' }, status.label) : null;
  if (row) {
    return applyPhoneRule(h('a', { class: 'fx-tile', href, onclick: inPlace },
      logo,
      h('h3', {}, title),
      pill ?? (meta ? h('span', { class: 'fx-tile__meta' }, meta) : null)), 'tileCard');
  }
  return applyPhoneRule(h('a', { class: `fx-int-card${blurb ? '' : ' fx-int-card--bare'}`, href, onclick: inPlace },
    h('header', { class: 'fx-int-card__head' }, logo, h('h3', {}, title), pill),
    blurb ? h('p', { class: 'fx-int-card__blurb' }, blurb) : null,
    h('span', { class: 'fx-int-card__btn' }, action)), 'tileCard');
}

// A titled group of one-line cards, three columns where they fit, with "Show all" at the right
// when `href` is given (Claude's Customize page).
export function tileSection(title, cards, { href, more = 'Show all' } = {}) {
  return applyPhoneRule(h('section', { class: 'fx-tiles' },
    h('header', { class: 'fx-tiles__head' },
      h('h2', {}, title),
      href ? h('a', { class: 'fx-tiles__more', href, onclick: inPlace }, more, lucide(h, 'chevron-right')) : null),
    h('div', { class: 'fx-tiles__grid' }, cards)), 'tileSection');
}

// A dialog that fills the screen has no pixel outside it, so an accessibility
// check cannot tell it is modal and reads the page underneath. While one is
// open, every other top-level node is inert. The attribute is what the check
// reads; the browser's own modal behaviour is unchanged.
function shieldBehindDialogs() {
  const top = [...document.querySelectorAll('dialog[open]')].at(-1) ?? null;
  for (const child of document.body.children) {
    if (top && child !== top) child.setAttribute('inert', '');
    else child.removeAttribute('inert');
  }
}
// Node tests import this module and have no HTMLDialogElement. The wrap only
// matters in the browser, where showModal and close are the three call sites.
if (typeof HTMLDialogElement !== 'undefined') {
  const openDialog = HTMLDialogElement.prototype.showModal;
  const closeDialog = HTMLDialogElement.prototype.close;
  HTMLDialogElement.prototype.showModal = function showModal() {
    const result = openDialog.call(this);
    shieldBehindDialogs();
    return result;
  };
  HTMLDialogElement.prototype.close = function close(...args) {
    const result = closeDialog.apply(this, args);
    shieldBehindDialogs();
    return result;
  };
}

// The trail above a page one level down: crumbs(['/integrations', 'Integrations'], 'Xero').
export function crumbs(...trail) {
  const here = trail.pop();
  return applyPhoneRule(h('nav', { class: 'fx-crumbs', 'aria-label': 'Breadcrumb' },
    ...trail.flatMap(([href, label]) => [h('a', { href, onclick: inPlace }, label), h('span', { 'aria-hidden': 'true' }, '›')]),
    h('span', {}, here)), 'crumbs');
}
