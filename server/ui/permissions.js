// Settings > Permissions, and the Permissions sidecar on a person.
// The grid is permissionGrid; a person is Inherit, Allow or Deny on each key.
import { permissionGrid } from '/assets/ui/permissions-grid.js';
import { personLabel } from '/assets/ui/person.js';
import { sidecar } from '/assets/ui/sidecar.js';
import { sectionTitle, settingRow } from '/assets/ui/kit.js';

const EFFECTS = [['inherit', 'Inherit'], ['allow', 'Allow'], ['deny', 'Deny']];

export async function renderPermissions(main, ui) {
  const { h, flow, toast, notice, pageHeader } = ui;
  const canManage = Boolean(ui.me?.ownerActions?.allowed);
  const host = h('div', {}, h('div', { class: 'fx-skeleton' }));
  main.append(
    pageHeader('Permissions'),
    canManage ? null : notice('Changing permissions needs a verified owner sign-in: Google Workspace on the owner domain with no password, or a second factor.', 'warn', 'Read only.'),
    host);
  if (!canManage) {
    host.replaceChildren(h('p', { class: 'fx-empty' }, 'Permissions open after a verified owner sign-in.'));
    return;
  }
  let body;
  try {
    body = await flow('/api/permissions');
  } catch (error) {
    host.replaceChildren(notice(error.message, 'danger'));
    return;
  }
  async function saveRole(role, changes) {
    if (!changes.length) return;
    const previous = Object.fromEntries(changes.map(([key]) => [key, body.grants[role][key]]));
    for (const [key, allowed] of changes) body.grants[role][key] = allowed;
    draw();
    const failed = [];
    await Promise.all(changes.map(async ([key, allowed]) => {
      try {
        await flow(`/api/permissions/roles/${role}`, { method: 'PUT', body: JSON.stringify({ key, allowed }) });
      } catch (error) {
        failed.push(error);
        body.grants[role][key] = previous[key];
      }
    }));
    if (failed.length) {
      draw();
      toast(failed[0].message, 'danger');
    }
  }
  const draw = () => {
    host.replaceChildren(permissionGrid(h, {
      groups: body.groups,
      grants: body.grants,
      onChange: (role, key, allowed) => saveRole(role, [[key, allowed]]),
      onChangeAll: (role, allowed) => {
        const keys = body.groups.flatMap((group) => group.permissions.map((permission) => permission.key));
        saveRole(role, keys.filter((key) => body.grants[role][key] !== allowed).map((key) => [key, allowed]));
      },
    }));
  };
  draw();
}

// The right-hand panel for one person: each permission, Inherit / Allow / Deny.
export function openPersonPermissions(main, ui, person) {
  const { h, flow, toast } = ui;
  main.classList.add('fx-perm-host');
  if (!main.fxPerm) {
    main.fxPerm = sidecar(h, { label: 'Permissions', overlay: true, escape: true });
    main.append(main.fxPerm.element);
  }
  const panel = main.fxPerm;
  const who = personLabel(person);
  panel.setTabs([{
    id: 'access',
    label: 'Access',
    icon: 'key',
    render: () => {
      const body = h('div', { class: 'fx-settings' }, h('p', { class: 'fx-dim' }, 'Loading…'));
      flow(`/api/permissions/people/${person.id}`).then(({ permissions }) => {
        const rows = [];
        const groups = [];
        const allOn = () => permissions.every((permission) => permission.effect === 'allow');
        const allSwitch = h('button', {
          class: 'fx-switch', type: 'button', role: 'switch',
          'aria-label': `All for ${who}`, 'aria-checked': String(allOn()),
        });
        const paintAll = () => allSwitch.setAttribute('aria-checked', String(allOn()));
        allSwitch.onclick = async () => {
          const effect = allOn() ? 'inherit' : 'allow';
          const changing = permissions.filter((permission) => permission.effect !== effect);
          const previous = new Map(changing.map((permission) => [permission.key, permission.effect]));
          for (const permission of changing) {
            permission.effect = effect;
            const select = rows.find((row) => row.key === permission.key)?.select;
            if (select) select.value = effect;
          }
          paintAll();
          const failed = [];
          await Promise.all(changing.map(async (permission) => {
            try {
              await flow(`/api/permissions/people/${person.id}`, { method: 'PUT', body: JSON.stringify({ key: permission.key, effect }) });
            } catch (error) {
              failed.push(error);
              permission.effect = previous.get(permission.key);
              const select = rows.find((row) => row.key === permission.key)?.select;
              if (select) select.value = permission.effect;
            }
          }));
          paintAll();
          if (failed.length) toast(failed[0].message, 'danger');
        };
        for (const permission of permissions) {
          let group = groups.find((item) => item.label === permission.group);
          if (!group) {
            group = { label: permission.group, rows: [] };
            groups.push(group);
          }
          const select = h('select', {
            class: 'fx-select',
            'aria-label': `${permission.label} for ${who}`,
            onchange: async (event) => {
              const effect = event.target.value;
              const previous = permission.effect;
              permission.effect = effect;
              paintAll();
              try {
                await flow(`/api/permissions/people/${person.id}`, { method: 'PUT', body: JSON.stringify({ key: permission.key, effect }) });
                toast(`${permission.label} updated.`, 'success');
              } catch (error) {
                permission.effect = previous;
                event.target.value = previous;
                paintAll();
                toast(error.message, 'danger');
              }
            },
          }, EFFECTS.map(([value, label]) => h('option', { value, selected: value === permission.effect }, label)));
          rows.push({ key: permission.key, select });
          group.rows.push(settingRow({ label: permission.label, control: select }));
        }
        body.replaceChildren(
          settingRow({ label: 'All', control: h('label', { class: 'fx-perm__hit' }, allSwitch) }),
          ...groups.flatMap((group) => [sectionTitle(group.label), ...group.rows]));
      }).catch((error) => {
        body.replaceChildren(h('p', {}, error.message));
      });
      return body;
    },
  }]);
  panel.open('access');
}
