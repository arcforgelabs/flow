# RowMenu

The ⋯ menu at the end of a row: the actions that do not earn a button.

- `rowMenu(label, items, { trigger, className, align })` gives `[button, panel]`; an item is `{ icon, text, run, tone }`, `'-'` is a line. `align: 'start'` opens the menu from the button's left edge (a view tab, the sidebar's More). `trigger` replaces the ⋯ icon (the sidebar's More).
- A destructive item is last, `tone: 'danger'`, behind a Dialog.

Code: `rowMenu` in `server/ui/kit.js`.
