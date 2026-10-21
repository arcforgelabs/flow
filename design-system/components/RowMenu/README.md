# RowMenu

The ⋯ menu at the end of a row: the actions that do not earn a button.

- `rowMenu(label, items)` gives `[button, panel]`; an item is `{ icon, text, run, tone }`, `'-'` is a line.
- A destructive item is last, `tone: 'danger'`, behind a Dialog.

Code: `rowMenu` in `server/ui/kit.js`.
