// The view bar over a list: chips that open a small panel (Group, Sort,
// Filter, Columns), as on ClickUp. Every list page builds its chips here, so
// they look and work the same: Jobs, Invoices, Reconcile and the Price list.
//
// viewBar(h) answers the parts:
//   menu(icon, build, { rows, clearLabel })  a chip, its × and its panel.
//     build(redraw, close) answers the panel's nodes. set(label, on, clear)
//     names the chip, marks it on, and gives its × an action.
//   option(text, checked, onclick, role, icon)  a row in a panel, with a tick.
//   title, choose, bin, addButton, rowsFoot, clearAll  the parts of a rows
//     panel: a title, rows of selects with a bin, a foot with Add and Clear.
//   groupMenu(config), sortMenu(config)  the Group and Sort chips (below).
//   filterMenu(config)  the Filter chip, as ClickUp's: groups of rows of
//     field, operator and value, And / Or in a group and between groups,
//     "Add nested filter", "Add filter" and "Clear all" (job-view.js has
//     the rules and filterJobs, which keeps the rows that pass). config:
//       fields()          [{ value, label, icon? } | { group, options }]
//       kindOf(field)     'choice' | 'person' | 'date' | 'number' | 'check' | 'text' | null
//       opsOf(field)      { op: words }, or null for OPERATORS[kindOf(field)]
//       choicesOf(field)  [{ value, label, icon? }] for a choice field
//       view()            { match, groups: [{ match, filters }] }
//       change(patch)     saves { groups } or { match }
//       first             the field a new row starts on
//       empty             the words when no filter is on
import { lucide } from '/assets/ui/custom-fields.js';
import { applyPhoneRule } from './mobile.js';
import { DATE_VALUES, dateValueIsOn, filterCount, KIND_ICONS, OPERATORS } from '/assets/ui/job-view.js';

const DAY_BETWEEN = /^between:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

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
    const wrap = applyPhoneRule(h('span', { class: 'fx-chipset' }, button, clear), 'viewBar');
    let onClear = null;
    clear.addEventListener('click', () => onClear?.());
    // Place again after the rows draw. A filter row is wider than the empty
    // panel, and the panel is measured once it is open; without this a button
    // at the right (Invoices) leaves the value and the bin off the screen.
    const placeMenu = () => { if (panel.matches(':popover-open')) place(button, panel, 6); };
    const fill = () => {
      panel.replaceChildren(...build(fill, () => panel.hidePopover()).filter(Boolean));
      placeMenu();
      requestAnimationFrame(placeMenu);
    };
    panel.addEventListener('toggle', (event) => {
      button.setAttribute('aria-expanded', String(event.newState === 'open'));
      if (event.newState !== 'open') return;
      fill();
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

  // A choice in a list where many can be ticked, as ClickUp's value list:
  // the choice's mark at the left only when it has one (a Lucide `icon`, a
  // custom field `color`, or a status `rank`), its name, a tick box at the
  // right.
  const mark = (c) => (c.icon ? lucide(h, c.icon)
    : c.color ? h('span', { class: 'fx-dot', 'data-color': c.color, 'aria-hidden': 'true' })
      : c.rank != null ? h('span', { class: 'fx-dot fx-dot--stage', 'data-rank': String(c.rank), 'aria-hidden': 'true' }) : null);
  const checkOption = (c, checked, onclick) => h('button', {
    type: 'button', class: 'fx-pop__item fx-pop__item--check', role: 'menuitemcheckbox', 'aria-checked': String(checked), onclick,
  }, mark(c), h('span', { class: 'fx-pop__text' }, c.label), h('span', { class: 'fx-pop__box', 'aria-hidden': 'true' }, checked ? svg(ICONS.tick) : null));

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

  // A button that opens a list to pick one choice from, as ClickUp's menus
  // in a filter row: options [{ value, label, icon? }], a search box when
  // `search` is on, and a tick on the chosen one.
  function picker({ label, value, options, onpick, search = false, empty = 'Choose…', extra = '' }) {
    const id = `fx-view-pick-${++choiceCount}`;
    const chosen = options.find((o) => o.value === value) ?? null;
    const button = h('button', {
      type: 'button', class: `fx-select fx-select--sm fx-choice ${extra}`.trim(), popovertarget: id, 'aria-label': label, title: chosen?.label ?? label,
    }, chosen?.icon ? lucide(h, chosen.icon) : null, h('span', { class: 'fx-choice__text' }, chosen?.label ?? empty));
    const pop = h('div', { class: 'fx-pop fx-pop--choices', id, popover: 'auto', role: 'menu' });
    const find = search ? h('input', { class: 'fx-input fx-input--sm', type: 'search', placeholder: 'Search…', 'aria-label': `Search ${label.toLowerCase()}` }) : null;
    const items = h('div', {});
    const drawItems = () => {
      const q = find?.value.trim().toLowerCase() ?? '';
      const shown = options.filter((o) => !q || o.label.toLowerCase().includes(q));
      items.replaceChildren(...(shown.length ? shown.map((o) => option(o.label, o.value === value, () => { pop.hidePopover(); onpick(o.value); }, 'menuitemradio', o.icon ?? null))
        : [h('p', { class: 'fx-rows__empty' }, 'Nothing matches.')]));
    };
    find?.addEventListener('input', drawItems);
    pop.append(...[find, items].filter(Boolean));
    pop.addEventListener('toggle', (event) => {
      if (event.newState !== 'open') return;
      if (find) find.value = '';
      drawItems();
      place(button, pop);
      find?.focus();
    });
    return [button, pop];
  }
  // Keep a popover on the screen: at the control's left edge, shifted left
  // when it would run off the right. Called again after a filter row draws,
  // because that row is wider than the empty panel.
  function place(anchor, pop, gap = 4) {
    const at = anchor.getBoundingClientRect();
    const width = pop.offsetWidth;
    const left = Math.max(8, Math.min(at.left, innerWidth - width - 8));
    pop.style.top = `${Math.round(at.bottom + gap)}px`;
    pop.style.left = `${Math.round(left)}px`;
  }

  // ── Group by ──
  // One row: what to group by, the group order, and a bin that takes the
  // groups away when `clearable()` (Jobs' board always has lanes). The page
  // names the chip with set(), as only it knows its group's name.
  //   options()  [{ value, label } | { group, options }]
  //   view()     { group, groupDir }; group 'none' is no groups
  function groupMenu({ options, view, change, clearable = () => true }) {
    return menu(ICONS.group, (redraw) => {
      const { group, groupDir } = view();
      const none = group === 'none';
      return [
        title('Group by'),
        h('div', { class: 'fx-rows' }, h('div', { class: 'fx-rows__row fx-rows__row--group' },
          choose('Group by', none ? '' : group, [...(none ? [{ value: '', label: 'Choose…', disabled: true }] : []), ...options()], (value) => { change({ group: value }); redraw(); }),
          choose('Group order', groupDir, [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }], (value) => { change({ groupDir: value }); redraw(); }, { disabled: none }),
          clearable() && !none ? bin('Remove the grouping', () => { change({ group: 'none' }); redraw(); }) : h('span', { class: 'fx-rows__gap' }))),
      ];
    }, { rows: true, clearLabel: 'Remove the grouping' });
  }

  // ── Sort ──
  // Rows of sorts, each applied in turn; a list's column heads sort too.
  //   options()   [{ value, label } | { group, options }]
  //   view()      { sorts: [{ by, dir }] }
  //   dirWords(by)  the two directions' words, as ['A to Z', 'Z to A']
  //   nameOf(by)  the chip's name for a sort
  function sortMenu({ options, view, change, dirWords, nameOf, empty = 'No sort.' }) {
    const setSorts = (sorts) => change({ sorts });
    const control = menu(ICONS.sort, (redraw) => {
      const { sorts } = view();
      const unused = options().flatMap((o) => o.options ?? [o]).filter((o) => !sorts.some((s) => s.by === o.value));
      return [
        title('Sort'),
        sorts.length ? h('div', { class: 'fx-rows' }, sorts.map((s, i) => {
          const [up, down] = dirWords(s.by);
          const others = sorts.filter((_, n) => n !== i).map((x) => x.by);
          const shown = options().map((o) => (o.group ? { ...o, options: o.options.filter((x) => !others.includes(x.value)) } : o)).filter((o) => o.group || !others.includes(o.value));
          return h('div', { class: 'fx-rows__row fx-rows__row--sort' },
            h('span', { class: 'fx-rows__lead' }, i ? 'then' : 'Sort by'),
            choose('Sort by', s.by, shown, (by) => { setSorts(sorts.map((x, n) => (n === i ? { by, dir: x.dir } : x))); redraw(); }),
            choose('Order', s.dir, [{ value: 'asc', label: up }, { value: 'desc', label: down }], (dir) => { setSorts(sorts.map((x, n) => (n === i ? { ...x, dir } : x))); redraw(); }),
            bin('Remove this sort', () => { setSorts(sorts.filter((_, n) => n !== i)); redraw(); }));
        })) : h('p', { class: 'fx-rows__empty' }, empty),
        rowsFoot(
          sorts.length < 5 && unused.length ? addButton('Add sort', () => { setSorts([...sorts, { by: unused[0].value, dir: 'asc' }]); redraw(); }) : h('span'),
          sorts.length ? clearAll(() => { setSorts([]); redraw(); }) : null),
      ];
    }, { rows: true, clearLabel: 'Clear the sort' });
    // The chip names the sort that is on.
    const draw = () => {
      const { sorts } = view();
      const [first] = sorts;
      control.set(sorts.length > 1 ? `Sort · ${sorts.length}` : first ? `Sort: ${nameOf(first.by)} ${first.dir === 'desc' ? '↓' : '↑'}` : 'Sort', sorts.length > 0,
        sorts.length ? () => setSorts([]) : null);
    };
    return { ...control, draw };
  }

  // ── Filters ──
  // As ClickUp's: groups of rows of field, operator and value, with a bin on
  // each row. A group's second row has And / Or for the rows in it; the
  // second group has And / Or between the groups. "Add nested filter" adds a
  // row to a group, "Add filter" a new group, "Clear all" empties it.
  function filterMenu({ fields, kindOf, opsOf: ownOps = () => null, choicesOf = () => [], view, change, first, empty = 'No filters. Every row shows.' }) {
    const opsOf = (field) => ownOps(field) ?? OPERATORS[kindOf(field)] ?? {};
    // The field list: one list, as ClickUp's, each field with its type icon.
    const fieldList = () => fields().flatMap((o) => (o.group ? o.options : [o]))
      .map((o) => ({ ...o, icon: o.icon ?? KIND_ICONS[kindOf(o.value)] ?? null }));
    // A row's value when its field or operator changes: kept when it fits.
    function valueFor(field, op, old) {
      const kind = kindOf(field);
      if (kind === 'date' && ['is', 'not'].includes(op)) return typeof old === 'string' && dateValueIsOn(old) ? old : 'today';
      if (['is', 'not'].includes(op) && ['choice', 'person'].includes(kind)) return Array.isArray(old) ? old : [];
      if (['eq', 'gt', 'lt'].includes(op)) return typeof old === 'number' ? old : null;
      if (['has', 'hasnt', 'is'].includes(op)) return typeof old === 'string' ? old : '';
      return null;
    }
    const groups = () => view().groups;
    const setGroups = (next) => change({ groups: next.filter((g) => g.filters.length) });
    const newRow = (field = first) => {
      const op = Object.keys(opsOf(field))[0];
      return { field, op, value: valueFor(field, op, null) };
    };
    const setRow = (gi, ri, patch) => setGroups(groups().map((g, n) => (n === gi ? { ...g, filters: g.filters.map((f, m) => (m === ri ? { ...f, ...patch } : f)) } : g)));
    const dropRow = (gi, ri) => setGroups(groups().map((g, n) => (n === gi ? { ...g, filters: g.filters.filter((_, m) => m !== ri) } : g)));
    // A choice row's value: a button that opens a list of choices to tick,
    // with a search and "Select all", as ClickUp's.
    function choiceValue(gi, ri, filter) {
      const choices = choicesOf(filter.field);
      const named = () => {
        const on = choices.filter((c) => filter.value.includes(c.value)).map((c) => c.label);
        return on.length ? on.join(', ') : 'Select option';
      };
      const id = `fx-view-choice-${++choiceCount}`;
      const button = h('button', { type: 'button', class: 'fx-select fx-select--sm fx-rows__value', popovertarget: id, title: named() }, named());
      const pop = h('div', { class: 'fx-pop fx-pop--choices', id, popover: 'auto', role: 'menu' });
      const find = h('input', { class: 'fx-input fx-input--sm', type: 'search', placeholder: 'Search…', 'aria-label': 'Search the choices' });
      const items = h('div', {});
      const save = (value) => {
        filter = { ...filter, value };
        setRow(gi, ri, { value });
        button.textContent = named();
        button.title = named();
        drawItems();
      };
      const all = h('button', { type: 'button', class: 'fx-pop__link', onclick: () => save(filter.value.length === choices.length ? [] : choices.map((c) => c.value)) });
      const drawItems = () => {
        const q = find.value.trim().toLowerCase();
        all.textContent = filter.value.length === choices.length && choices.length ? 'Clear' : 'Select all';
        items.replaceChildren(...choices.filter((c) => !q || c.label.toLowerCase().includes(q)).map((c) => checkOption(c, filter.value.includes(c.value), () => {
          save(filter.value.includes(c.value) ? filter.value.filter((v) => v !== c.value) : [...filter.value, c.value]);
        })));
      };
      find.addEventListener('input', drawItems);
      pop.append(find, h('div', { class: 'fx-pop__bar' }, h('span', { class: 'fx-pop__head' }, fieldList().find((f) => f.value === filter.field)?.label ?? 'Options'), all), items);
      pop.addEventListener('toggle', (event) => {
        if (event.newState !== 'open') return;
        drawItems();
        place(button, pop);
        find.focus();
      });
      return [button, pop];
    }
    // A date row's value: ClickUp's list of ranges, then a day, two days or
    // a count of days when the range needs one.
    function dateValue(gi, ri, filter) {
      const value = filter.value ?? 'today';
      const [kind, rest = ''] = value.split(':');
      const range = DAY_BETWEEN.exec(value);
      const base = range ? 'between' : kind;
      const set = (next) => { setRow(gi, ri, { value: next }); };
      const pick = picker({
        label: 'Date', value: base, search: true, extra: 'fx-rows__value',
        options: Object.entries(DATE_VALUES).map(([v, l]) => ({ value: v, label: l })),
        onpick: (v) => {
          const day = today();
          set({ on: `on:${day}`, before: `before:${day}`, after: `after:${day}`, between: `between:${day}..${day}`, last: 'last:7', next: 'next:7' }[v] ?? v);
          redrawPanel();
        },
      });
      const dayInput = (at, onchange) => h('input', { class: 'fx-input fx-input--sm', type: 'date', 'aria-label': 'Day', value: at, onchange: (event) => { if (event.target.value) onchange(event.target.value); } });
      let more = null;
      if (['on', 'before', 'after'].includes(base)) more = dayInput(rest, (d) => set(`${base}:${d}`));
      if (range) {
        more = h('span', { class: 'fx-rows__days' },
          dayInput(range[1], (d) => set(`between:${d}..${range[2]}`)), dayInput(range[2], (d) => set(`between:${range[1]}..${d}`)));
      }
      if (['last', 'next'].includes(base)) {
        more = h('span', { class: 'fx-rows__days' }, h('input', {
          class: 'fx-input fx-input--sm', type: 'number', min: '1', max: '9999', step: '1', 'aria-label': 'Days', value: rest,
          oninput: (event) => { const n = Number(event.target.value); if (Number.isInteger(n) && n > 0 && n < 10000) set(`${base}:${n}`); },
        }), h('span', { class: 'fx-rows__lead' }, 'days'));
      }
      return h('span', { class: 'fx-rows__value fx-rows__date' }, ...pick, more);
    }
    function valueControl(gi, ri, filter) {
      const kind = kindOf(filter.field);
      const { op } = filter;
      if (kind === 'date' && ['is', 'not'].includes(op)) return dateValue(gi, ri, filter);
      if (['is', 'not'].includes(op) && ['choice', 'person'].includes(kind)) return choiceValue(gi, ri, filter);
      if (['eq', 'gt', 'lt'].includes(op)) {
        return h('input', {
          class: 'fx-input fx-input--sm fx-rows__value', type: 'number', step: 'any', inputmode: 'decimal', 'aria-label': 'Number', value: filter.value ?? '',
          oninput: (event) => setRow(gi, ri, { value: event.target.value === '' ? null : Number(event.target.value) }),
        });
      }
      if (['has', 'hasnt', 'is'].includes(op)) {
        return h('input', { class: 'fx-input fx-input--sm fx-rows__value', type: 'text', placeholder: 'Search…', 'aria-label': 'Text', value: filter.value ?? '', oninput: (event) => setRow(gi, ri, { value: event.target.value }) });
      }
      return h('span', { class: 'fx-rows__value fx-rows__value--none' });
    }
    // And / Or: a small menu on the second row (or group), the word after it.
    const joinControl = (label, match, onpick) => picker({
      label, value: match, extra: 'fx-rows__join', options: [{ value: 'all', label: 'AND' }, { value: 'any', label: 'OR' }], onpick,
    });
    let redrawPanel = () => {};
    const control = menu(ICONS.filter, (redraw) => {
      redrawPanel = redraw;
      const list = fieldList();
      const all = groups();
      const { match } = view();
      const row = (gi, g, filter, ri) => {
        const lead = ri === 0 ? h('span', { class: 'fx-rows__lead' }, 'Where')
          : ri === 1 ? joinControl('Match in this group', g.match, (value) => { setGroups(all.map((x, n) => (n === gi ? { ...x, match: value } : x))); redraw(); })
            : h('span', { class: 'fx-rows__lead fx-rows__word' }, g.match === 'any' ? 'OR' : 'AND');
        const remove = bin('Remove this filter', () => { dropRow(gi, ri); redraw(); });
        if (!kindOf(filter.field)) return h('div', { class: 'fx-rows__row' }, lead, h('span', { class: 'fx-rows__gone' }, 'A custom field that was deleted'), remove);
        const ops = opsOf(filter.field);
        return h('div', { class: 'fx-rows__row' },
          lead,
          ...picker({
            label: 'Field', value: filter.field, options: list, search: true,
            onpick: (field) => { const op = Object.keys(opsOf(field))[0]; setRow(gi, ri, { field, op, value: valueFor(field, op, null) }); redraw(); },
          }),
          ...picker({
            label: 'Operator', value: filter.op, options: Object.entries(ops).map(([value, label]) => ({ value, label })),
            onpick: (op) => { setRow(gi, ri, { op, value: valueFor(filter.field, op, filter.value) }); redraw(); },
          }),
          valueControl(gi, ri, filter),
          remove);
      };
      const count = all.reduce((n, g) => n + g.filters.length, 0);
      const box = (g, gi) => h('div', { class: 'fx-fgroup' },
        h('div', { class: 'fx-rows' }, g.filters.map((filter, ri) => row(gi, g, filter, ri))),
        count < 20 ? h('button', { type: 'button', class: 'fx-fgroup__add', onclick: () => { setGroups(all.map((x, n) => (n === gi ? { ...x, filters: [...x.filters, newRow()] } : x))); redraw(); } }, 'Add nested filter') : null);
      const body = all.length === 1 ? box(all[0], 0) : h('div', { class: 'fx-fgroups' }, all.map((g, gi) => h('div', { class: 'fx-fgroups__row' },
        gi === 0 ? h('span', { class: 'fx-rows__lead' }, 'Where')
          : gi === 1 ? h('span', {}, ...joinControl('Match between groups', match, (value) => { change({ match: value }); redraw(); }))
            : h('span', { class: 'fx-rows__lead fx-rows__word' }, match === 'any' ? 'OR' : 'AND'),
        box(g, gi))));
      return [
        title('Filters'),
        all.length ? body : h('p', { class: 'fx-rows__empty' }, empty),
        rowsFoot(
          count < 20 ? addButton('Add filter', () => { setGroups([...all, { match: 'all', filters: [newRow()] }]); redraw(); }) : h('span'),
          all.length ? clearAll(() => { change({ groups: [], match: 'all' }); redraw(); }) : null),
      ];
    }, { rows: true, clearLabel: 'Clear all filters' });
    // The chip names how many filters are on.
    const draw = () => {
      const count = filterCount(view(), kindOf);
      control.set(count ? `${count} ${count === 1 ? 'Filter' : 'Filters'}` : 'Filter', count > 0, groups().length ? () => change({ groups: [], match: 'all' }) : null);
    };
    return { ...control, draw };
  }

  return { menu, option, title, choose, bin, addButton, rowsFoot, clearAll, groupMenu, sortMenu, filterMenu };
}

// A list's own search: a round search icon in the view bar that opens into a
// small box while it has words, so it takes no room until it is used. The
// global search (sidebar foot, Ctrl+K) finds anything anywhere; this one
// narrows the rows on the page. Escape clears it.
export function findBox(h, { label, value = '', oninput }) {
  const input = h('input', { class: 'fx-input fx-input--sm fx-find__input', type: 'search', placeholder: label, 'aria-label': label, value });
  const button = h('button', { type: 'button', class: 'fx-chip fx-find__button', 'aria-label': label, title: label }, lucide(h, 'search'));
  const element = applyPhoneRule(h('span', { class: `fx-find${value ? ' fx-find--open' : ''}` }, button, input), 'findBox');
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
