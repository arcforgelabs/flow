# Columns

The table under every list (Jobs, Invoices, Reconcile), as ClickUp's: drag a head's right edge to resize the column, drag a head to move it, click or right-click a head for its menu.

- `columnTable(h, { order, widths, change, hidden, extra })` once per page; `table({ columns, rows, lead })` per draw.
- A column is `{ id, label, kind, cell(row) }`. Its kind sets its start width and its minimum (`COLUMN_WIDTH`, `COLUMN_MIN` in `job-view.js`).
- The edge grip: drag, arrow keys (16px a step), or double-click to reset. The width never goes under the kind's minimum.
- Drag a head: a line shows where it lands. A click without a drag opens the menu: Move to start, Move to end, Hide, Reset width; the page adds its own items (Sort, Edit custom field).
- + at the end lists the hidden columns. A `fixed` column (Jobs' Client) keeps its place.
- The view keeps `columns` (order) and `widths`, with the person's account (`viewSaver(ui, page)`, PUT /api/me/views/:page).
- Past the page width the table scrolls sideways. On a phone the rows stack and the widths do not apply.

Code: `columnTable`, `rowCells`, `viewSaver`, `onRightButton` in `server/ui/columns.js`; `widthOf`, `moveColumn`, `normaliseListView` in `server/ui/job-view.js`.
