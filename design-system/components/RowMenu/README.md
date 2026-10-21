# RowMenu

The ⋯ menu at the end of a row: the actions that do not earn a button.

- `rowMenu(label, items, { align })` gives `[button, panel]`; an item is `{ icon, text, run, tone }`, `'-'` is a line. `align: 'start'` opens the menu from the button's left edge (a view tab).
- A destructive item is last, `tone: 'danger'`, behind a Dialog.

Code: `rowMenu` in `server/ui/kit.js`.
