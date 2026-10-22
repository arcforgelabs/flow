# PermissionGrid

A grid of what each role may do: one row per permission, a switch for Owner, Admin and Staff. The owner column stays on.

- `permissionGrid(h, { groups, grants, onChange })`. `groups` is `[{ label, permissions: [{ key, label }] }]`. `grants` is `{ owner, admin, staff }`, each `{ key: true|false }`.
- `onChange(role, key, allowed)` hears a switch. The owner column is locked and does not call it.
- On a phone the same switches sit in one card per permission.

Code: `permissionGrid` in `server/ui/permissions-grid.js`.
