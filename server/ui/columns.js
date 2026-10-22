// A list's columns, as ClickUp's: drag a head's right edge to make the
// column wider or narrower (never under its kind's minimum), drag a head
// to move the column, and click or right-click a head for its menu (Move to
// start, Move to end, Hide; + shows a hidden column again). Jobs, Invoices,
// Reconcile and the Price list build their tables here, so every list works
// the same.
//
// The view a person keeps for a list (with their account, PUT
// /api/me/views/:page) holds two keys from here:
//   columns  the shown columns' ids, in order
//   widths   { [id]: px } for the columns the person made wider or narrower
// The rules (no DOM) are in job-view.js ("Columns"), so the server checks a
// saved view with them (server/auth/people.js) and tests read them.
//
// columnTable(h, config), once per page, answers { table, menu, openMenu }:
//   order()          the shown columns' ids, as the view keeps them
//   widths()         the saved widths
//   change(patch)    saves { columns } or { widths }
//   hidden()         [{ id, label }] the + menu lists (no hidden: no +)
//   extra(column, item)  menu nodes before Move (Sort, Edit custom field)
// table({ columns, rows, lead, className }), per draw, answers the table:
//   columns  the shown columns, in order: { id, label, kind, cell(row),
//            num?, className?, sort?(): node, icon?, fixed? }. An icon
//            shows in place of the label (the label is its name). A fixed
//            column keeps its place: no drag, no Move, no Hide.
//   rows     the <tbody> nodes (rowCells builds a row's cells)
//   lead     <th> nodes before the columns (the tick column)
//
// Cells every list shares: dateCell (a short date), personCell (a person's
// initials) and fieldColumn (one of the lab's custom fields as a column, on
// Jobs and on Invoices, where it is the invoice's job's value).
import { lucide } from '/assets/ui/custom-fields.js';
import { endWidth, LEAD_WIDTH, MAX_WIDTH, minWidth, moveColumn, TAIL_WIDTH, tableWidth, widthOf } from '/assets/ui/job-view.js';
import { applyPhoneRule, assignPhoneSlots, phoneSlot } from './mobile.js';
import { initialsOf } from '/assets/ui/person.js';

const fullDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
// A list date, short: Today, Tomorrow or Yesterday, else day/month (and
// year when it is not this year).
export function shortDate(iso) {
  if (!iso) return '—';
  const at = new Date(`${iso}T00:00:00`);
  const now = new Date();
  const days = Math.round((at - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return at.toLocaleDateString('en-AU', at.getFullYear() === now.getFullYear() ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// A date cell: the short date, the whole date on hover.
export const dateCell = (h, iso) => h('time', { datetime: iso ?? null, title: iso ? fullDate(iso) : null }, shortDate(iso));

// A person as a badge (initials), the name on hover; `people` is
// [{ id, name }] (GET /api/custom-fields).
export function personCell(h, personId, people) {
  if (!personId) return h('span', { class: 'fx-dim' }, '—');
  const name = people.find((p) => p.id === personId)?.name ?? 'Former person';
  return h('span', { class: 'fx-avatar fx-avatar--sm', role: 'img', 'aria-label': name, title: name }, initialsOf(name));
}

// A custom field's value as text.
export function fieldText(field, value, people) {
  if (value == null || value === false) return '—';
  if (field.type === 'checkbox') return 'Yes';
  if (field.type === 'person') return people.find((p) => p.id === value)?.name ?? 'Former person';
  if (field.type === 'dropdown') return field.options?.find((o) => o.id === value)?.name ?? '—';
  if (field.type === 'date') return shortDate(value);
  return String(value);
}

// One custom field as a list column: `valueOf(row)` is the row's value
// (null when it has none), `people` names a person field's value.
export function fieldColumn(h, field, { id, valueOf, people }) {
  const cell = field.type === 'person' ? (row) => personCell(h, valueOf(row), people)
    : field.type === 'date' ? (row) => dateCell(h, valueOf(row)) : (row) => fieldText(field, valueOf(row), people);
  const kind = field.type === 'date' ? 'date' : field.type === 'person' ? 'person' : field.type === 'number' ? 'total' : 'text';
  return { id, label: field.name, kind, num: field.type === 'number', className: 'fx-dim', cell };
}


// A row's cells for the shown columns: a class per kind, the label for
// the phone layout, the full text as the cell's name on hover.
export function rowCells(h, columns, row) {
  return assignPhoneSlots(columns).map((c) => {
    const slot = phoneSlot(c);
    const td = h('td', {
      class: [`fx-c-${c.kind}`, c.num ? 'fx-num' : null, c.className].filter(Boolean).join(' '),
      'data-label': c.label,
      ...(slot ? { 'data-phone-slot': slot } : {}),
    }, c.cell(row));
    // A cell stays on one line and ends in "…" when the column is narrow
    // (flow.css, .fx-table--sized); the whole text shows on hover.
    const text = td.textContent?.trim();
    if (text && text !== '—') td.title = text;
    return td;
  });
}

// ── The table ──────────────────────────────────────────────────────────────

// One menu for every column head, as a popover: made at the first open and
// kept for every page after.
function columnPopover(h) {
  let pop = null;
  const close = () => pop?.hidePopover?.();
  const item = (icon, text, run) => h('button', { type: 'button', class: 'fx-pop__item', role: 'menuitem', onclick: () => { close(); run(); } },
    h('span', { class: 'fx-pop__tick' }, lucide(h, icon)), h('span', {}, text));
  const sep = () => h('div', { class: 'fx-pop__sep' });
  // Open with these nodes, at the pointer or under the node clicked.
  function show(parts, event) {
    pop = document.getElementById('fx-colmenu');
    if (!pop) {
      pop = h('div', { class: 'fx-pop', id: 'fx-colmenu', popover: 'auto', role: 'menu' });
      document.body.append(pop);
    }
    pop.replaceChildren(...parts);
    pop.showPopover?.();
    const box = event.currentTarget?.getBoundingClientRect?.();
    const x = event.clientX || box?.left || 0;
    const y = event.clientY || box?.bottom || 0;
    pop.style.top = `${Math.round(Math.min(y + 4, innerHeight - pop.offsetHeight - 8))}px`;
    pop.style.left = `${Math.round(Math.max(8, Math.min(x, innerWidth - pop.offsetWidth - 8)))}px`;
  }
  return { close, item, sep, show };
}

// A popover opened while the right button is still down closes again on
// its release (light dismiss), so open it after the release.
export function onRightButton(event, open) {
  if (event.buttons & 2) addEventListener('pointerup', () => setTimeout(open), { once: true });
  else open();
}

export function columnTable(h, config) {
  const menu = columnPopover(h);
  const ids = () => config.order?.() ?? [];
  const widths = () => config.widths?.() ?? {};

  function openMenu(column, event) {
    const parts = [];
    if (column) {
      parts.push(...(config.extra?.(column, menu.item) ?? []));
      if (!column.fixed) {
        const order = ids();
        parts.push(menu.item('arrow-left-to-line', 'Move to start', () => config.change({ columns: moveColumn(order, column.id, 0) })),
          menu.item('arrow-right-to-line', 'Move to end', () => config.change({ columns: moveColumn(order, column.id, order.length) })));
        if (config.hidden) parts.push(menu.sep(), menu.item('eye-off', 'Hide column', () => config.change({ columns: order.filter((id) => id !== column.id) })));
      }
      if (widths()[column.id] != null) {
        parts.push(menu.item('move-horizontal', 'Reset width', () => config.change({ widths: withoutKey(widths(), column.id) })));
      }
    } else {
      const hidden = config.hidden?.() ?? [];
      parts.push(...hidden.map((c) => h('button', { type: 'button', class: 'fx-pop__item', role: 'menuitem', onclick: () => { menu.close(); config.change({ columns: [...ids(), c.id] }); } }, c.label)));
      if (!hidden.length) parts.push(h('p', { class: 'fx-pop__head' }, 'Every column shows'));
    }
    if (parts.length) menu.show(parts, event);
  }

  function table({ columns, rows, lead = [], className = '' }) {
    const saved = widths();
    // Each column keeps its own width: never stretched to the page. As
    // HubSpot's, the head and every row still run to the right edge: the
    // end column (+ at its right) takes the space after the last column, so
    // a row looks whole, not cut off. A resize changes the table only; the
    // tools stay put.
    const cols = columns.map((c) => h('col', { style: { width: `${widthOf(c, saved)}px` } }));
    const leadCols = lead.map(() => h('col', { style: { width: `${LEAD_WIDTH}px` } }));
    const endCol = h('col', { style: { width: `${TAIL_WIDTH}px` } });
    const tail = config.hidden ? h('th', { class: 'fx-th-add' }, h('button', {
      type: 'button', class: 'fx-th fx-th--add', 'aria-label': 'Show a column', title: 'Show a column', onclick: (event) => openMenu(null, event),
    }, '+')) : h('th', { class: 'fx-th-end', 'aria-hidden': 'true' });
    const heads = columns.map((c, n) => head(c, n));
    const node = h('table', { class: `fx-table fx-table--sized ${className}`.trim() },
      h('colgroup', {}, leadCols, cols, endCol),
      h('thead', {}, h('tr', {}, lead, heads, tail)),
      rows);
    const box = applyPhoneRule(h('div', { class: 'fx-table-scroll' }, node), 'columnTable');
    // The width the columns need; past the window the table scrolls
    // sideways. A browser shares spare width among fixed columns, so the
    // end column is sized here, and again when the window changes size.
    let need = tableWidth(columns, saved, lead.length);
    const fit = () => {
      const end = endWidth(need, box.getBoundingClientRect?.().width ?? 0);
      endCol.style.width = `${end}px`;
      node.style.width = `${need - TAIL_WIDTH + end}px`;
    };
    fit();
    if (typeof ResizeObserver === 'function') {
      // Once the table has left the page (a redraw), stop watching.
      let shown = false;
      const watch = new ResizeObserver(() => {
        if (box.isConnected) { shown = true; fit(); } else if (shown) watch.disconnect();
      });
      watch.observe(box);
    }
    return box;

    function head(c, n) {
      const button = h('button', {
        type: 'button', class: c.fixed ? 'fx-th fx-th--fixed' : 'fx-th', 'aria-haspopup': 'menu',
        title: c.fixed ? c.label : `${c.label}. Drag to move, click for the menu`,
        onclick: (event) => { if (!dragged) openMenu(c, event); },
      }, c.icon ? lucide(h, c.icon, c.label) : c.label);
      const grip = h('span', {
        class: 'fx-th-grip', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical',
        'aria-label': `${c.label} width`, title: 'Drag to resize. Double-click to reset',
        'aria-valuemin': String(minWidth(c.kind)), 'aria-valuemax': String(MAX_WIDTH), 'aria-valuenow': String(widthOf(c, widths())),
      });
      const th = h('th', {
        class: [c.num ? 'fx-num' : null, c.fixed ? null : 'fx-th--drag'].filter(Boolean).join(' ') || null,
        'data-col': c.id,
        oncontextmenu: (event) => { event.preventDefault(); onRightButton(event, () => openMenu(c, event)); },
      }, h('span', { class: 'fx-th-cell' }, button, c.sort?.() ?? null), grip);
      resizer(grip, c, n);
      if (!c.fixed) dragger(button, th, c);
      return th;
    }

    // Drag the edge: the column follows the pointer, kept to its minimum;
    // the width saves on release. Arrow keys step it; a double-click resets.
    function resizer(grip, c, n) {
      const col = cols[n];
      const set = (px) => {
        const w = Math.round(Math.min(MAX_WIDTH, Math.max(minWidth(c.kind), px)));
        col.style.width = `${w}px`;
        grip.setAttribute('aria-valuenow', String(w));
        return w;
      };
      const save = (w) => config.change({ widths: { ...widths(), [c.id]: w } });
      grip.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        grip.setPointerCapture(event.pointerId);
        const from = event.clientX;
        const start = col.getBoundingClientRect().width || widthOf(c, widths());
        const base = need;
        let w = start;
        node.dataset.resizing = '';
        const move = (e) => {
          w = set(start + e.clientX - from);
          need = base + w - start;
          fit();
        };
        const up = () => {
          grip.removeEventListener('pointermove', move);
          delete node.dataset.resizing;
          if (Math.round(w) !== Math.round(start)) save(w);
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up, { once: true });
        grip.addEventListener('pointercancel', up, { once: true });
      });
      grip.addEventListener('click', (event) => event.stopPropagation());
      grip.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        config.change({ widths: withoutKey(widths(), c.id) });
      });
      grip.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0;
        if (!step) return;
        event.preventDefault();
        save(set(widthOf(c, widths()) + step));
      });
    }
  }

  // Drag a head: past a few pixels it lifts, a line shows where it lands,
  // and the release moves it there. A click without a drag opens the menu.
  let dragged = false;
  function dragger(button, th, c) {
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const row = th.parentElement;
      const from = event.clientX;
      let target = null;
      dragged = false;
      const heads = () => [...row.querySelectorAll('th.fx-th--drag')];
      const clear = () => { for (const other of row.children) other.removeAttribute('data-drop'); };
      const move = (e) => {
        if (!dragged && Math.abs(e.clientX - from) < 6) return;
        if (!dragged) {
          dragged = true;
          button.setPointerCapture(event.pointerId);
          th.dataset.dragging = '';
        }
        clear();
        target = null;
        for (const other of heads()) {
          const box = other.getBoundingClientRect();
          if (e.clientX >= box.left && e.clientX < box.right && other !== th) {
            const side = e.clientX < box.left + box.width / 2 ? 'before' : 'after';
            other.dataset.drop = side;
            target = { id: other.dataset.col, side };
          }
        }
      };
      const up = () => {
        removeEventListener('pointermove', move);
        delete th.dataset.dragging;
        clear();
        if (dragged && target) {
          const order = ids().filter((id) => id !== c.id);
          const at = order.indexOf(target.id) + (target.side === 'after' ? 1 : 0);
          config.change({ columns: moveColumn(ids(), c.id, at) });
        }
        // The click that follows a drag does not open the menu.
        setTimeout(() => { dragged = false; });
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up, { once: true });
      addEventListener('pointercancel', up, { once: true });
    });
  }

  return { table, menu, openMenu };
}

function withoutKey(object, key) {
  const { [key]: _gone, ...rest } = object;
  return rest;
}

// Saves a page's view with the person's account (PUT /api/me/views/:page)
// shortly after a change, so a few quick changes make one request.
export function viewSaver(ui, page) {
  let timer = null;
  return (view) => {
    if (ui.me) ui.me.views = { ...ui.me.views, [page]: view };
    clearTimeout(timer);
    timer = setTimeout(() => {
      ui.flow(`/api/me/views/${page}`, { method: 'PUT', body: JSON.stringify(view) })
        .catch(() => ui.toast?.('Flow could not save your view. It applies on this page only.', 'danger'));
    }, 500);
  };
}
