# RowMenu

The ⋯ menu at the end of a row: the actions that do not earn a button. The sidebar's More uses the same menu, floating beside the button, with a pin on each row.

- `rowMenu(label, items, { trigger, className, align, place })` gives `[button, panel]`. An item is `{ icon, text, run, tone }`; `'-'` is a line. `icon` is a Lucide name or a node. `align: 'start'` opens the menu from the button's left edge. `place: 'side'` floats it to the right of the button, moves focus into the menu, and returns focus to the button on close. `trigger` replaces the ⋯ icon (the sidebar's More).
- `trailing: { icon, label, pressed, run, locked }` draws a control at the end of the row. Choosing it does not close the menu. `locked` draws the icon and does not take a click (Jobs and Invoices stay pinned). `items` may be a function, read again whenever the menu opens; `panel.refresh()` redraws it while it is open.
- A destructive item is last, `tone: 'danger'`, behind a Dialog.

Code: `rowMenu` in `server/ui/kit.js`.
