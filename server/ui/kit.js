// The shared pieces every Flow page builds with: elements (h), the page
// header, notes, toasts, dialogs, setting rows, the ⋯ row menu and the button
// that waits between presses. app.js hands them to each view module in ui(),
// and the design system's cards (scripts/design-system/) render these same
// functions, so a card is the real thing. Reuse one or give it an option;
// never copy it into a page (AGENTS.md, "UI: reuse first").
import { lucide } from '/assets/ui/custom-fields.js';
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
  return h('header', { class: 'fx-ph' },
    h('div', { class: 'fx-ph__text' },
      h('h1', { class: 'fx-title' }, title),
      count != null ? h('span', { class: 'fx-ph__count' }, count) : null,
      help ? helpLink(help) : null),
    actions.length ? h('div', { class: 'fx-ph__actions' }, actions) : null);
}

// The top of a list page (Jobs, Invoices, Reconcile), laid out the same on
// every list and in Board and List alike, so nothing moves when a person
// switches: the title row, a row for saved view tabs (`views`, hidden until
// a page fills it), then one toolbar with `start` at the left (tabs, Group,
// Sort, Filter) and `end` at the right (search, Board/List), then the page's
// `actions` (New invoice) last, as Claude's own lists do. `line` draws the
// rule that tabs sit on; `sticky` keeps the toolbar at the top while the rows
// scroll up under it, with a shadow once they do. Append `nodes` to the page.
export function listHead(title, { count = null, help = null, actions = [], start = [], end = [], line = false, sticky = false } = {}) {
  const views = h('div', { class: 'fx-views', role: 'group', 'aria-label': 'Views', hidden: true });
  const bar = h('div', { class: 'fx-listhead', 'data-sticky': sticky },
    h('div', { class: `fx-toolbar${line ? '' : ' fx-toolbar--plain'}` }, start, h('div', { class: 'fx-toolbar__end' }, end, actions)));
  const edge = sticky ? h('div', { class: 'fx-listhead__edge', 'aria-hidden': 'true' }) : null;
  if (edge && typeof IntersectionObserver === 'function') {
    const top = window.matchMedia?.('(max-width: 820px)').matches ? 61 : 1;
    new IntersectionObserver(([entry]) => bar.toggleAttribute('data-stuck', !entry.isIntersecting), { rootMargin: `-${top}px 0px 0px 0px` }).observe(edge);
  }
  return { nodes: [pageHeader(title, { count, help }), views, edge, bar].filter(Boolean), views, bar };
}

// The window a list or board sits in under listHead, as HubSpot's: on a
// desktop it fills the page to the bottom and scrolls inside itself both
// ways, so nothing runs off the page, with a foot bar for the count and its
// tools. It makes `main` the window's height (fx-main--frame).
export function listFrame(main, content) {
  main.classList.add('fx-main--frame');
  const count = h('span', { class: 'fx-frame__count', role: 'status' });
  const tools = h('div', { class: 'fx-frame__tools' });
  const body = h('div', { class: 'fx-frame__body' }, content);
  const element = h('section', { class: 'fx-frame' }, body, h('footer', { class: 'fx-frame__foot' }, count, tools));
  return { element, body, tools, count: (text) => { count.textContent = text ?? ''; } };
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
  return h('div', { class: 'fx-notice', 'data-tone': tone, role: tone === 'danger' ? 'alert' : 'status' },
    title ? h('strong', {}, title) : null,
    h('span', {}, text));
}

export function toast(text, tone = 'info') {
  const region = document.getElementById('toasts');
  const item = h('div', { class: 'fx-toast', 'data-tone': tone, role: 'status' }, text);
  region.append(item);
  setTimeout(() => item.remove(), 4200);
}

// A modal built on <dialog>: resolves with the button's value, or null.
export function dialog({ title, body, confirm, tone = 'primary' }) {
  return new Promise((resolve) => {
    const form = h('form', { method: 'dialog', class: 'fx-dialog__form' },
      h('h2', { class: 'fx-dialog__title' }, title),
      body,
      h('div', { class: 'fx-dialog__actions' },
        h('button', { class: 'fx-btn fx-btn--ghost', value: 'cancel', type: 'submit', formnovalidate: true }, 'Cancel'),
        h('button', { class: `fx-btn fx-btn--${tone}`, value: 'ok', type: 'submit' }, confirm)));
    const element = h('dialog', { class: 'fx-dialog' }, form);
    element.addEventListener('close', () => {
      const ok = element.returnValue === 'ok';
      const data = ok ? new FormData(form) : null;
      element.remove();
      resolve(ok ? data : null);
    });
    document.body.append(element);
    element.showModal();
    element.querySelector('input, select, button[value="ok"]')?.focus();
  });
}

// One setting, laid out the same on every settings screen: a short name, one
// line of smaller text under it, and the control on the right. Longer help
// lives behind a link, not here. A wide control (a grid of choices) sits on
// its own line under the name. `tone: 'danger'` marks a row that needs a person.
export function settingRow({ label, hint, control, wide = false, tone = null }) {
  const target = control?.matches?.('input, select, textarea') ? control : control?.querySelector?.('input:not([type=color]), select, textarea');
  const id = target ? (target.id ||= `fx-set-${++settingRow.next}`) : null;
  return h('div', { class: `fx-setting${wide ? ' fx-setting--wide' : ''}`, 'data-tone': tone },
    h('div', { class: 'fx-setting__text' },
      id ? h('label', { class: 'fx-setting__name', for: id }, label) : h('span', { class: 'fx-setting__name' }, label),
      hint ? h('p', { class: 'fx-setting__hint' }, hint) : null),
    h('div', { class: 'fx-setting__control' }, control));
}
settingRow.next = 0;

// The steps of a Connect, each ticked, running or crossed, with the time taken.

let rowMenus = 0;

// A row's ⋯ menu, as on the Custom fields page.
export function rowMenu(label, items) {
  const id = `fx-row-menu-${++rowMenus}`;
  const button = h('button', { class: 'fx-cfm__more', type: 'button', 'aria-label': label, popovertarget: id, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, lucide(h, 'ellipsis'));
  const panel = h('div', { class: 'fx-pop', id, popover: 'auto', role: 'menu' });
  panel.addEventListener('toggle', (event) => {
    button.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState !== 'open') return;
    const close = () => panel.hidePopover();
    panel.replaceChildren(...items.map((entry) => (entry === '-'
      ? h('div', { class: 'fx-pop__sep' })
      : h('button', { type: 'button', class: 'fx-pop__item', role: 'menuitem', 'data-tone': entry.tone, onclick: () => { close(); entry.run(); } },
        h('span', { class: 'fx-pop__tick' }, lucide(h, entry.icon)), h('span', {}, entry.text)))));
    const at = button.getBoundingClientRect();
    panel.style.top = `${Math.round(at.bottom + 6)}px`;
    panel.style.left = `${Math.round(Math.max(8, Math.min(at.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8)))}px`;
  });
  return [button, panel];
}
