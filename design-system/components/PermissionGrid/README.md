# PermissionGrid

A grid of what each role may do: one row per permission, a switch for Owner, Admin and Staff. All turns every permission for that role on or off. The owner column stays on.

- `permissionGrid(h, { groups, grants, onChange, onChangeAll })`. `groups` is `[{ label, permissions: [{ key, label }] }]`. `grants` is `{ owner, admin, staff }`, each `{ key: true|false }`.
- `onChange(role, key, allowed)` hears one switch. `onChangeAll(role, allowed)` hears All. Without it, All calls `onChange` for each permission that changes. The owner column is locked and does not call either.
- On a phone the same switches sit in one card per permission, with All first.

Code: `permissionGrid` in `server/ui/permissions-grid.js`.
