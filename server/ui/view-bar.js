// The view bar over a list: chips that open a small panel (Group, Sort,
// Filter, Columns), as on ClickUp. Every list page builds its chips here, so
// they look and work the same: Jobs (jobs.js) and Reconcile (reconcile.js).
//
// viewBar(h) answers the parts:
//   menu(icon, build, { rows, clearLabel })  a chip, its × and its panel.
//     build(redraw, close) answers the panel's nodes. set(label, on, clear)
//     names the chip, marks it on, and gives its × an action.
//   option(text, checked, onclick, role, icon)  a row in a panel, with a tick.
//   title, choose, bin, addButton, rowsFoot, clearAll  the parts of a rows
//     panel: a title, rows of selects with a bin, a foot with Add and Clear.
//   filterMenu(config)  the Filter chip: rows of field, operator and value,
//     And / Or, "Add filter" and "Clear all" (job-view.js has the rules and
//     filterJobs, which keeps the rows that pass). config:
//       fields()          [{ value, label } | { group, options }]
//       kindOf(field)     'choice' | 'person' | 'date' | 'number' | 'check' | 'text' | null
//       opsOf(field)      { op: words }, or null for OPERATORS[kindOf(field)]
//       choicesOf(field)  [{ value, label, icon? }] for a choice field
//       view()            { filters, match }
//       change(patch)     saves { filters } or { match }
//       first             the field a new row starts on
//       empty             the words when no filter is on
import { lucide } from '/assets/ui/custom-fields.js';
import { filterCount, OPERATORS } from '/assets/ui/job-view.js';

export const ICONS = {
  group: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 14.5 5 8 8.2 1.5 5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="m1.5 8.2 6.5 3.2 6.5-3.2M1.5 11.2 8 14.4l6.5-3.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  sort: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5-3.5L11.5 6M4.5 10 8 13.5l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  columns: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 2.5v11M10 2.5v11" stroke="currentColor" stroke-width="1.3"/></svg>',
  filter: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h12M4.5 8h7M7 12.5h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  tick: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.5 3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export function svg(markup) {
  const span = document.createElement('span');
  span.innerHTML = markup;
  return span.firstChild;
}

// The local calendar day, as yyyy-mm-dd.
export const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

// Popover ids are unique on the page, whichever page builds the bar.
let menuCount = 0;
let choiceCount = 0;

export function viewBar(h) {
  // One toolbar control: a chip that opens a small panel under it, and an ×
  // that clears what the chip sets (as ClickUp's "Clear all filters"). The
  // panel is a popover, so a click outside or Escape closes it.
  function menu(icon, build, { rows = false, clearLabel = 'Clear' } = {}) {
    const id = `fx-view-menu-${++menuCount}`;
    const panel = h('div', { class: `fx-pop${rows ? ' fx-pop--rows' : ''}`, id, popover: 'auto', role: rows ? 'dialog' : 'menu' });
    const button = h('button', { type: 'button', class: 'fx-chip', popovertarget: id, 'aria-haspopup': rows ? 'dialog' : 'menu', 'aria-expanded': 'false' });
    const clear = h('button', { type: 'button', class: 'fx-chip__clear', 'aria-label': clearLabel, title: clearLabel, hidden: true }, lucide(h, 'x'));
    const wrap = h('span', { class: 'fx-chipset' }, button, clear);
    let onClear = null;
    clear.addEventListener('click', () => onClear?.());
    const fill = () => panel.replaceChildren(...build(fill, () => panel.hidePopover()).filter(Boolean));
    panel.addEventListener('toggle', (event) => {
      button.setAttribute('aria-expanded', String(event.newState === 'open'));
      if (event.newState !== 'open') return;
      fill();
      const at = button.getBoundingClientRect();
      panel.style.top = `${Math.round(at.bottom + 6)}px`;
      panel.style.left = `${Math.round(Math.max(8, Math.min(at.left, innerWidth - panel.offsetWidth - 8)))}px`;
    });
    return {
      node: [wrap, panel],
      wrap,
      fill: () => { if (panel.matches(':popover-open')) fill(); },
      set(label, on, clearIt = null) {
        button.replaceChildren(svg(icon), h('span', {}, label));
        wrap.classList.toggle('fx-chipset--on', on);
        button.classList.toggle('fx-chip--on', on);
        onClear = clearIt;
        clear.hidden = !clearIt;
      },
    };
  }

  // A choice in a menu: a row with a tick when it is chosen, and an icon
  // (a Lucide name) when the choice has one.
  const option = (text, checked, onclick, role = 'menuitemradio', icon = null) => h('button', {
    type: 'button', class: 'fx-pop__item', role, 'aria-checked': String(checked), onclick,
  }, h('span', { class: 'fx-pop__tick' }, checked ? svg(ICONS.tick) : null), icon ? lucide(h, icon) : null, h('span', {}, text));

  // The parts of a rows panel (Group by, Sort, Filters): a title, rows of
  // selects with a bin at the end, and a foot with "Add" and "Clear all".
  const title = (text) => h('p', { class: 'fx-rows__title' }, text);
  const choose = (label, value, options, onchange, extra = {}) => h('select', {
    class: 'fx-select fx-select--sm', 'aria-label': label, onchange: (event) => onchange(event.target.value), ...extra,
  }, options.map((o) => (o.group
    ? (o.options.length ? h('optgroup', { label: o.group }, o.options.map((x) => h('option', { value: x.value, selected: x.value === value }, x.label))) : null)
    : h('option', { value: o.value, selected: o.value === value, disabled: o.disabled }, o.label))));
  const bin = (label, onclick) => h('button', { type: 'button', class: 'fx-rows__bin', 'aria-label': label, title: label, onclick }, lucide(h, 'trash-2'));
  const addButton = (text, onclick) => h('button', { type: 'button', class: 'fx-btn fx-btn--ghost fx-btn--sm fx-rows__add', onclick }, lucide(h, 'plus'), text);
  const rowsFoot = (...parts) => h('div', { class: 'fx-rows__foot' }, ...parts);
  const clearAll = (onclick) => h('button', { type: 'button', class: 'fx-btn fx-btn--ghost fx-btn--sm', onclick }, 'Clear all');

  // ── Filters ──
  // Rows of field, operator and value, with a bin on each, "Add filter",
  // and "Clear all". The second row's And / Or applies to every row.
  function filterMenu({ fields, kindOf, opsOf: ownOps = () => null, choicesOf = () => [], view, change, first, empty = 'No filters. Every row shows.' }) {
    const opsOf = (field) => ownOps(field) ?? OPERATORS[kindOf(field)] ?? {};
    // A row's value when its operator changes: kept when it still fits.
    function valueFor(field, op, old) {
      const kind = kindOf(field);
      if (['is', 'not'].includes(op) && ['choice', 'person'].includes(kind)) return Array.isArray(old) ? old : [];
      if (['before', 'after', 'on'].includes(op)) return typeof old === 'string' && /^\d{4}-/.test(old) ? old : today();
      if (['eq', 'gt', 'lt'].includes(op)) return typeof old === 'number' ? old : null;
      if (['has', 'is'].includes(op)) return typeof old === 'string' ? old : '';
      return null;
    }
    const setFilters = (filters) => change({ filters });
    const setRow = (i, patch) => setFilters(view().filters.map((f, n) => (n === i ? { ...f, ...patch } : f)));
    // A choice row's value: a button that opens a list of choices to tick,
    // with a search when the list is long.
    function choiceValue(i, filter) {
      const choices = choicesOf(filter.field);
      const named = () => {
        const on = choices.filter((c) => filter.value.includes(c.value)).map((c) => c.label);
        return on.length ? on.join(', ') : 'Choose…';
      };
      const id = `fx-view-choice-${++choiceCount}`;
      const button = h('button', { type: 'button', class: 'fx-select fx-select--sm fx-rows__value', popovertarget: id, title: named() }, named());
      const pop = h('div', { class: 'fx-pop fx-pop--choices', id, popover: 'auto', role: 'menu' });
      const find = choices.length > 8 ? h('input', { class: 'fx-input fx-input--sm', type: 'search', placeholder: 'Find', 'aria-label': 'Find a choice' }) : null;
      const items = h('div', {});
      const drawItems = () => {
        const q = find?.value.trim().toLowerCase() ?? '';
        items.replaceChildren(...choices.filter((c) => !q || c.label.toLowerCase().includes(q)).map((c) => option(c.label, filter.value.includes(c.value), () => {
          filter = { ...filter, value: filter.value.includes(c.value) ? filter.value.filter((v) => v !== c.value) : [...filter.value, c.value] };
          setRow(i, { value: filter.value });
          button.textContent = named();
          button.title = named();
          drawItems();
        }, 'menuitemcheckbox', c.icon ?? null)));
      };
      find?.addEventListener('input', drawItems);
      pop.append(...[find, items].filter(Boolean));
      pop.addEventListener('toggle', (event) => {
        if (event.newState !== 'open') return;
        drawItems();
        const at = button.getBoundingClientRect();
        pop.style.top = `${Math.round(at.bottom + 4)}px`;
        pop.style.left = `${Math.round(Math.max(8, Math.min(at.left, innerWidth - pop.offsetWidth - 8)))}px`;
        find?.focus();
      });
      return [button, pop];
    }
    function valueControl(i, filter) {
      const kind = kindOf(filter.field);
      const { op } = filter;
      if (['is', 'not'].includes(op) && ['choice', 'person'].includes(kind)) return choiceValue(i, filter);
      if (['before', 'after', 'on'].includes(op)) {
        return h('input', { class: 'fx-input fx-input--sm fx-rows__value', type: 'date', 'aria-label': 'Date', value: filter.value ?? '', onchange: (event) => setRow(i, { value: event.target.value || null }) });
      }
      if (['eq', 'gt', 'lt'].includes(op)) {
        return h('input', {
          class: 'fx-input fx-input--sm fx-rows__value', type: 'number', step: 'any', inputmode: 'decimal', 'aria-label': 'Number', value: filter.value ?? '',
          oninput: (event) => setRow(i, { value: event.target.value === '' ? null : Number(event.target.value) }),
        });
      }
      if (['has', 'is'].includes(op)) {
        return h('input', { class: 'fx-input fx-input--sm fx-rows__value', type: 'text', 'aria-label': 'Text', value: filter.value ?? '', oninput: (event) => setRow(i, { value: event.target.value }) });
      }
      return h('span', { class: 'fx-rows__value fx-rows__value--none' });
    }
    const control = menu(ICONS.filter, (redraw) => {
      const { filters, match } = view();
      const list = fields();
      return [
        title('Filters'),
        filters.length ? h('div', { class: 'fx-rows' }, filters.map((filter, i) => {
          const known = kindOf(filter.field);
          const lead = i === 0 ? h('span', { class: 'fx-rows__lead' }, 'Where')
            : i === 1 ? choose('Match', match, [{ value: 'all', label: 'And' }, { value: 'any', label: 'Or' }], (value) => { change({ match: value }); redraw(); })
              : h('span', { class: 'fx-rows__lead' }, match === 'any' ? 'Or' : 'And');
          if (!known) {
            return h('div', { class: 'fx-rows__row' }, lead, h('span', { class: 'fx-rows__gone' }, 'A custom field that was deleted'), bin('Remove this filter', () => { setFilters(filters.filter((_, n) => n !== i)); redraw(); }));
          }
          const ops = opsOf(filter.field);
          return h('div', { class: 'fx-rows__row' },
            lead,
            choose('Field', filter.field, list, (field) => {
              const op = Object.keys(opsOf(field))[0];
              setRow(i, { field, op, value: valueFor(field, op, null) });
              redraw();
            }),
            choose('Operator', filter.op, Object.entries(ops).map(([value, label]) => ({ value, label })), (op) => { setRow(i, { op, value: valueFor(filter.field, op, filter.value) }); redraw(); }),
            valueControl(i, filter),
            bin('Remove this filter', () => { setFilters(filters.filter((_, n) => n !== i)); redraw(); }));
        })) : h('p', { class: 'fx-rows__empty' }, empty),
        rowsFoot(
          filters.length < 20 ? addButton('Add filter', () => {
            const op = Object.keys(opsOf(first))[0];
            setFilters([...filters, { field: first, op, value: valueFor(first, op, null) }]);
            redraw();
          }) : h('span'),
          filters.length ? clearAll(() => { setFilters([]); redraw(); }) : null),
      ];
    }, { rows: true, clearLabel: 'Clear all filters' });
    // The chip names how many filters are on.
    const draw = () => {
      const count = filterCount(view());
      control.set(count ? `${count} ${count === 1 ? 'Filter' : 'Filters'}` : 'Filter', count > 0, view().filters.length ? () => change({ filters: [], match: 'all' }) : null);
    };
    return { ...control, draw };
  }

  return { menu, option, title, choose, bin, addButton, rowsFoot, clearAll, filterMenu };
}

// A list's own search: a round search icon in the view bar that opens into a
// small box while it has words, so it takes no room until it is used. The
// global search (sidebar foot, Ctrl+K) finds anything anywhere; this one
// narrows the rows on the page. Escape clears it.
export function findBox(h, { label, value = '', oninput }) {
  const input = h('input', { class: 'fx-input fx-input--sm fx-find__input', type: 'search', placeholder: label, 'aria-label': label, value });
  const button = h('button', { type: 'button', class: 'fx-chip fx-find__button', 'aria-label': label, title: label }, lucide(h, 'search'));
  const element = h('span', { class: `fx-find${value ? ' fx-find--open' : ''}` }, button, input);
  button.addEventListener('click', () => { element.classList.add('fx-find--open'); input.focus(); });
  input.addEventListener('input', () => oninput(input.value));
  input.addEventListener('blur', () => { if (!input.value) element.classList.remove('fx-find--open'); });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    input.value = '';
    oninput('');
    input.blur();
  });
  return { element, input };
}
