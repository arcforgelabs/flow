// The role grid on Settings > Permissions: one row per permission, one switch
// per role. The owner column is on and locked. At phone width the same
// switches stack, one card per permission (flow.css, max-width 639px).
import { sectionTitle } from '/assets/ui/kit.js';

const ROLES = [['owner', 'Owner'], ['admin', 'Admin'], ['staff', 'Staff']];

function roleSwitch(h, { label, on, locked, change }) {
  const button = h('button', {
    class: 'fx-switch', type: 'button', role: 'switch',
    'aria-label': label, 'aria-checked': String(Boolean(on)),
    disabled: locked || undefined,
    onclick: locked ? undefined : () => change(!on),
  });
  return h('label', { class: 'fx-perm__hit' }, button);
}

function everyOn(grants, role, keys) {
  return keys.every((key) => Boolean(grants?.[role]?.[key]));
}

// permissionGrid(h, { groups, grants, onChange, onChangeAll }) draws the grid.
// groups: [{ label, permissions: [{ key, label }] }]
// grants: { owner: { key: true }, admin: {}, staff: {} }
// onChange(role, key, allowed) is one switch. onChangeAll(role, allowed) is
// the All switch: on turns every permission for that role on, off turns them
// off. The owner column does not call either.
export function permissionGrid(h, { groups, grants, onChange, onChangeAll }) {
  const keys = groups.flatMap((group) => group.permissions.map((permission) => permission.key));
  const setAll = (role, allowed) => {
    if (onChangeAll) {
      onChangeAll(role, allowed);
      return;
    }
    for (const key of keys) {
      if (Boolean(grants?.[role]?.[key]) !== allowed) onChange(role, key, allowed);
    }
  };
  const allControls = () => ROLES.map(([role, roleLabel]) => roleSwitch(h, {
    label: `All for ${roleLabel}`,
    on: role === 'owner' || everyOn(grants, role, keys),
    locked: role === 'owner',
    change: (allowed) => setAll(role, allowed),
  }));
  const deskAll = allControls();
  const phoneAll = allControls();
  const head = h('tr', {},
    h('th', { scope: 'col' }, 'Permission'),
    ...ROLES.map(([, label]) => h('th', { class: 'fx-perm__role', scope: 'col' }, label)));
  const rows = [h('tr', { class: 'fx-perm__all' },
    h('th', { scope: 'row' }, 'All'),
    ...deskAll.map((control) => h('td', {}, control)))];
  const cards = [h('article', { class: 'fx-perm__card' },
    h('h3', {}, 'All'),
    ...ROLES.map(([, roleLabel], index) => h('div', { class: 'fx-perm__line' },
      h('span', {}, roleLabel),
      phoneAll[index])))];
  for (const group of groups) {
    rows.push(h('tr', { class: 'fx-perm__group' }, h('th', { colspan: '4', scope: 'colgroup' }, group.label)));
    const cardRows = [];
    for (const permission of group.permissions) {
      const cells = ROLES.map(([role, roleLabel]) => roleSwitch(h, {
        label: `${permission.label} for ${roleLabel}`,
        on: grants?.[role]?.[permission.key],
        locked: role === 'owner',
        change: (allowed) => onChange(role, permission.key, allowed),
      }));
      rows.push(h('tr', {},
        h('th', { scope: 'row' }, permission.label),
        ...cells.map((control) => h('td', {}, control))));
      cardRows.push(h('article', { class: 'fx-perm__card' },
        h('h3', {}, permission.label),
        ...ROLES.map(([role, roleLabel], index) => h('div', { class: 'fx-perm__line' },
          h('span', {}, roleLabel),
          roleSwitch(h, {
            label: `${permission.label} for ${roleLabel}`,
            on: grants?.[role]?.[permission.key],
            locked: role === 'owner',
            change: (allowed) => onChange(role, permission.key, allowed),
          })))));
    }
    cards.push(h('section', { class: 'fx-perm__section' }, sectionTitle(group.label), ...cardRows));
  }
  return h('div', { class: 'fx-perm' },
    h('div', { class: 'fx-perm__desk' },
      h('table', { class: 'fx-perm__table' }, h('thead', {}, head), h('tbody', {}, rows))),
    h('div', { class: 'fx-perm__phone' }, cards));
}
